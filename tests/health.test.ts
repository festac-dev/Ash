import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { Readiness } from "../src/server/health.js";
import { startAshServer } from "../src/server/server.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

test("stalled storage produces a bounded readiness response without starting extra probes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const open = t.mock.method(fs, "open", () => new Promise(() => {}));
  const readiness = new Readiness("unused-stalled-storage-fixture");
  const first = readiness.check();
  const second = readiness.check();
  assert.equal(open.mock.callCount(), 1);
  t.mock.timers.tick(2_000);
  assert.equal(await first, false);
  assert.equal(await second, false);
  const third = readiness.check();
  t.mock.timers.tick(2_000);
  assert.equal(await third, false);
  assert.equal(open.mock.callCount(), 1);
  readiness.drain();
  assert.equal(await readiness.check(), false);
});

test("public probes expose only availability; private health remains authenticated", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir) });
  try {
    for (const endpoint of ["healthz", "readyz"]) {
      const response = await fetch(`${server.session.url}/${endpoint}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, service: "ash" });
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal((await fetch(`${server.session.url}/api/health`)).status, 401);
    const ready = new Readiness(dir);
    assert.equal(await ready.check(), true);
    ready.drain();
    assert.equal(await ready.check(), false);
    assert.equal(await new Readiness(`${dir}/missing`).check(), false);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test("one-time codes pasted into sign-in work once and preserve replay protection", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir) });
  try {
    const issued = await fetch(`${server.session.url}/api/frontend/code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.session.token}` },
    });
    const { code: token } = (await issued.json()) as { code: string };
    const login = () =>
      fetch(`${server.session.url}/api/auth/login`, { method: "POST", body: JSON.stringify({ token }) });
    const response = await login();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    assert.equal((await login()).status, 401);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});
