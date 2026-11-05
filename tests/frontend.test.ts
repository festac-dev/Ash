import assert from "node:assert/strict";
import test, { before } from "node:test";
import { startAshServer } from "../src/server/server.js";
import { ensureFrontendBuild } from "../src/server/frontend-build.js";
import { createDemoTask } from "../src/demo.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

// Asset assertions require a production build. Keep a cold build outside the
// listener-toggle timeout so npm test also works from a clean checkout.
before(() => ensureFrontendBuild(), { timeout: 300_000 });

test(
  "frontend toggle releases its port and leaves the task engine and core API running",
  { timeout: 30_000 },
  async () => {
    const dir = await tempDir();
    const config = testConfig(dir, { ASH_SERVER_PORT: "0", ASH_SERVER_UI: "false" });
    const server = await startAshServer({ config, token: "frontend-toggle-test-0123456789012" });
    const headers = { Authorization: `Bearer ${server.session.token}`, "Content-Type": "application/json" };
    try {
      const id = await createDemoTask(config);
      await server.services.store.update(id, (task) => {
        for (const subtask of task.subtasks) subtask.next_check_at = "2099-01-01T00:00:00Z";
      });
      await server.service.execute(id);
      const before = await server.services.store.load(id);
      const ledger = await server.services.store.loadLedger(id);
      const denied = await fetch(`${server.session.url}/api/frontend`, { method: "POST", body: "{}" });
      assert.equal(denied.status, 401);
      const toggle = async () => {
        const response = await fetch(`${server.session.url}/api/frontend`, { method: "POST", headers, body: "{}" });
        assert.equal(response.status, 200);
        return (await response.json()) as { running: boolean; url: string; code: string | null };
      };
      const opened = await toggle();
      assert.equal(opened.running, true);
      assert.match(opened.code!, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
      assert.equal(new URL(opened.url).hash, "");
      assert.equal((await fetch(opened.url)).status, 200);
      const ticket = opened.code;
      const login = await fetch(`${opened.url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      assert.equal(
        (
          await fetch(`${opened.url}/api/frontend`, {
            method: "POST",
            headers: { Cookie: cookie, "X-Ash-Client": "web" },
            body: "{}",
          })
        ).status,
        403,
      );
      const stream = await fetch(`${opened.url}/api/events`, { headers: { Cookie: cookie } });
      const reader = stream.body!.getReader();
      await reader.read();
      const closed = await toggle();
      assert.equal(closed.running, false);
      assert.equal(closed.code, null);
      await assert.rejects(() => fetch(opened.url, { signal: AbortSignal.timeout(2000) }));
      assert.equal((await reader.read()).done, true);
      assert.equal(server.services.engine.isRunningTask(id), true);
      assert.deepEqual(await server.services.store.load(id), before);
      assert.deepEqual(await server.services.store.loadLedger(id), ledger);
      assert.equal((await fetch(`${server.session.url}/api/health`, { headers })).status, 200);
      assert.equal((await toggle()).running, true);
      await server.close();
    } finally {
      await server.close();
      await cleanup(dir);
    }
  },
);

test("frontend public asset routes cannot expose source, state or credentials", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir) });
  try {
    for (const file of [".env", "server.json", "chunks/../../config.ts", "data.json", "index.js.map"]) {
      const response = await fetch(`${server.session.url}/assets/${file}`);
      assert.notEqual(response.status, 200, file);
    }
    const fallback = await fetch(`${server.session.url}/assets/globe-fallback.svg`);
    assert.equal(fallback.status, 200);
    assert.match(fallback.headers.get("content-type")!, /image\/svg/);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test("public HTML is prerendered and compressed assets preserve cache and authorization boundaries", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir) });
  try {
    const identity = await fetch(server.session.url, { headers: { "Accept-Encoding": "identity" } });
    const html = await identity.text();
    assert.match(html, /<h1[^>]*>Intelligence/);
    assert.match(html, /Ambient visualization/);
    assert.doesNotMatch(html, new RegExp(server.session.token));
    assert.equal(identity.headers.get("cache-control"), "no-store");
    for (const [accept, encoding] of [
      ["br", "br"],
      ["gzip", "gzip"],
      ["br;q=0, gzip;q=0", null],
      ["br;q=.2, gzip;q=.8", "gzip"],
    ] as const) {
      const response = await fetch(server.session.url, { headers: { "Accept-Encoding": accept } });
      assert.equal(response.headers.get("content-encoding"), encoding);
      assert.equal(response.headers.get("vary"), "Accept-Encoding");
      assert.equal(await response.text(), html, "compression changed the document");
    }
    const script = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)?.[1];
    assert.ok(script);
    const asset = await fetch(`${server.session.url}${script}`, {
      method: "HEAD",
      headers: { "Accept-Encoding": "br" },
    });
    assert.match(asset.headers.get("cache-control")!, /immutable/);
    assert.equal(asset.headers.get("content-encoding"), "br");
    assert.equal(await asset.text(), "");
    for (const file of ["/assets/globe-fallback.svg", "/assets/theme.js"]) {
      assert.equal((await fetch(`${server.session.url}${file}`)).headers.get("cache-control"), "no-cache");
    }
    const denied = await fetch(`${server.session.url}/api/state`, { headers: { "Accept-Encoding": "br" } });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("cache-control"), "no-store");
    const state = await fetch(`${server.session.url}/api/state`, {
      headers: { Authorization: `Bearer ${server.session.token}` },
    });
    assert.equal(state.status, 200);
    assert.equal(state.headers.get("cache-control"), "no-store");
  } finally {
    await server.close();
    await cleanup(dir);
  }
});
