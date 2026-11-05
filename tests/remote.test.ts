import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, publicConfig } from "../src/config.js";
import { startAshServer, readServerSession, type RunningAshServer } from "../src/server/server.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

const TOKEN = "remote-session-token-0123456789";

function cookieFrom(response: Response): string {
  const raw = response.headers.get("set-cookie");
  assert.ok(raw, "expected a Set-Cookie header");
  const cookie = raw.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

async function login(
  server: RunningAshServer,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${server.session.url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

test("remote mode is opt-in and requires an explicit long token", () => {
  const base = {
    ASH_DEMO: "1",
    ASH_SIMULATE: "true",
    ASH_MODEL_PROVIDER: "demo",
    ASH_DATA_DIR: "/tmp/ash-remote-config-test",
  };
  assert.throws(() => loadConfig({ ...base, ASH_SERVER_HOST: "0.0.0.0" }), /ASH_SERVER_ALLOW_REMOTE/);
  assert.throws(
    () => loadConfig({ ...base, ASH_SERVER_HOST: "0.0.0.0", ASH_SERVER_ALLOW_REMOTE: "true" }),
    /ASH_SERVER_TOKEN/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        ASH_SERVER_HOST: "0.0.0.0",
        ASH_SERVER_ALLOW_REMOTE: "true",
        ASH_SERVER_TOKEN: "too-short",
      }),
    /at least 24 characters/,
  );
  const config = loadConfig({
    ...base,
    ASH_SERVER_HOST: "0.0.0.0",
    ASH_SERVER_ALLOW_REMOTE: "true",
    ASH_SERVER_TOKEN: TOKEN,
    ASH_SERVER_PUBLIC_URL: "https://ash.example.test",
  });
  assert.equal(config.server.allowRemote, true);
  assert.equal(config.server.publicUrl, "https://ash.example.test");
  const view = publicConfig(config);
  assert.equal(view.server.remote, true);
  assert.equal(JSON.stringify(view).includes(TOKEN), false);
});

test("remote UI serves a login page and authenticates browser sessions", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  const server = await startAshServer({
    config: testConfig(dir),
    host: "0.0.0.0",
    allowRemote: true,
    token: TOKEN,
    publicUrl: "https://ash.example.test",
  });
  try {
    assert.equal(server.session.remote, true);
    assert.equal(server.session.ui_url, "https://ash.example.test/");
    assert.match(server.session.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const home = await fetch(`${server.session.url}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const html = await home.text();
    assert.match(html, /ASH — Intelligence that executes/);
    const consolePage = await fetch(`${server.session.url}/console`);
    const controlsHtml = await consolePage.text();
    assert.match(controlsHtml, /Ash · Workspace/);
    assert.match(controlsHtml, /Connect your workspace/);
    const workspace = await fetch(`${server.session.url}/workspace`);
    assert.equal(workspace.status, 200);
    const workspaceHtml = await workspace.text();
    assert.match(workspaceHtml, /Connect your workspace/);
    assert.doesNotMatch(workspaceHtml, /class="hero"/);
    assert.equal(workspaceHtml.includes(TOKEN), false);
    const controls = await fetch(`${server.session.url}/workspace/controls`);
    assert.equal(controls.status, 200);
    assert.equal(await controls.text(), controlsHtml);
    assert.equal(html.includes(TOKEN), false);

    const appJs = await fetch(`${server.session.url}/assets/app.js`);
    assert.equal(appJs.status, 200);
    assert.match(appJs.headers.get("content-type") ?? "", /text\/javascript/);

    const rejectedOrigin = await login(server, { token: TOKEN }, { Origin: "https://evil.example" });
    assert.equal(rejectedOrigin.status, 403);

    const wrong = await login(server, { token: "wrong-token-0123456789" });
    assert.equal(wrong.status, 401);

    const accepted = await login(server, { token: TOKEN });
    assert.equal(accepted.status, 200);
    const setCookie = accepted.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.equal(setCookie.includes(TOKEN), false);
    const cookie = cookieFrom(accepted);

    const session = await fetch(`${server.session.url}/api/auth/session`, { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    const sessionBody = (await session.json()) as { authenticated: boolean; method: string; mode: string };
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.method, "cookie");
    assert.equal(sessionBody.mode, "SIMULATION");

    const state = await fetch(`${server.session.url}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(state.status, 200);
    assert.equal(((await state.json()) as { mode: string }).mode, "SIMULATION");

    const noCsrf = await fetch(`${server.session.url}/api/tasks`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ description: "remote task without csrf header", budget: "5", currency: "USDC" }),
    });
    assert.equal(noCsrf.status, 403);

    const created = await fetch(`${server.session.url}/api/tasks`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-Ash-Client": "web" },
      body: JSON.stringify({ description: "remote task from browser session", budget: "5", currency: "USDC" }),
    });
    assert.equal(created.status, 201);

    const logout = await fetch(`${server.session.url}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(`${server.session.url}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(afterLogout.status, 401);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test("one-time login tickets work once and only once", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  const server = await startAshServer({
    config: testConfig(dir),
    token: TOKEN,
    publicUrl: "https://ash.example.test",
  });
  try {
    const issued = await fetch(`${server.session.url}/api/frontend/code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const original = ((await issued.json()) as { code: string }).code;
    assert.ok(original);
    const rotatedResponse = await fetch(`${server.session.url}/api/auth/ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(rotatedResponse.status, 200);
    const rotated = (await rotatedResponse.json()) as { code: string; expires_at: string };
    assert.ok(rotated.code);

    const stale = await login(server, { ticket: original });
    assert.equal(stale.status, 401);

    const first = await login(server, { ticket: rotated.code });
    assert.equal(first.status, 200);
    const second = await login(server, { ticket: rotated.code });
    assert.equal(second.status, 401);

    const cookie = cookieFrom(first);
    const cookieTicket = await fetch(`${server.session.url}/api/auth/ticket`, {
      method: "POST",
      headers: { Cookie: cookie, "X-Ash-Client": "web" },
    });
    assert.equal(cookieTicket.status, 403);

    const persisted = await readServerSession(dir);
    assert.ok(persisted);
    assert.equal(persisted.ui_url, "https://ash.example.test/");
    assert.equal(persisted.remote, false);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test("logout prevents further private events on an already-open browser stream", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
  const controller = new AbortController();
  try {
    const cookie = cookieFrom(await login(server, { token: TOKEN }));
    const stream = await fetch(`${server.session.url}/api/events`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    const reader = stream.body!.getReader();
    await reader.read();
    const logout = await fetch(`${server.session.url}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    server.bus.publish({ type: "refresh", reason: "private-after-logout" });
    const next = await reader.read();
    assert.equal(next.done, true);
  } finally {
    controller.abort();
    await server.close();
    await cleanup(dir);
  }
});
