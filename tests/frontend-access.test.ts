import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LoginTicket } from "../src/server/auth.js";
import { FrontendServer } from "../src/server/frontend.js";
import { loadConfig } from "../src/config.js";
import { startAshServer } from "../src/server/server.js";
import { logger } from "../src/logger.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";
const exec = promisify(execFile);

test("failed activation preserves OFF access after an explicitly enabled frontend was stopped", async () => {
  const frontend = new FrontendServer(
    5050,
    () => {},
    async () => {
      throw new Error("Missing production assets");
    },
  );
  frontend.attach("http://127.0.0.1:5050", true, 5050);
  try {
    await frontend.setRunning(false);
    await assert.rejects(() => frontend.setRunning(true), /Missing production assets/);
    assert.equal(frontend.status().running, false);
    assert.equal(frontend.suppressed, true, "Failed activation must not reopen the configured browser routes");
  } finally {
    await frontend.close();
  }
});

test("codes have only a hash at rest in memory, expire, and cannot be replayed", () => {
  const codes = new LoginTicket(60_000);
  const issued = codes.rotate(1000);
  assert.match(issued.code, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
  assert.equal(JSON.stringify(codes).includes(issued.code), false);
  assert.equal(codes.consume(issued.code, 61_000), false);
  const fresh = codes.rotate(1000);
  assert.equal(codes.consume(fresh.code, 1001), true);
  assert.equal(codes.consume(fresh.code, 1002), false);
  const revoked = codes.rotate(2000);
  codes.revoke();
  assert.equal(codes.consume(revoked.code, 2001), false);
});

test("OFF by default, public plain HTTP refused, aliases supported", () => {
  assert.equal(loadConfig({}).server.ui, false);
  assert.throws(
    () =>
      loadConfig({
        ASH_BIND_HOST: "0.0.0.0",
        ASH_SERVER_ALLOW_REMOTE: "true",
        ASH_SERVER_TOKEN: "local-test-token-0123456789",
      }),
    /Public binding requires/,
  );
  const config = loadConfig({
    ASH_BIND_HOST: "0.0.0.0",
    ASH_PUBLIC_URL: "https://ash.example.com",
    ASH_SERVER_ALLOW_REMOTE: "true",
    ASH_SERVER_TOKEN: "local-test-token-0123456789",
  });
  assert.equal(config.server.host, "0.0.0.0");
  assert.equal(config.server.publicUrl, "https://ash.example.com");
});

test(
  "frontend on returns a code; off revokes all sessions and pending codes; lockout is enforced",
  { timeout: 300_000 },
  async () => {
    const dir = await tempDir();
    const server = await startAshServer({
      config: testConfig(dir, { ASH_SERVER_UI: "false", ASH_SERVER_PORT: "0" }),
      inlineFrontend: true,
    });
    const headers = { Authorization: `Bearer ${server.session.token}` };
    const action = async (running: boolean) => {
      const response = await fetch(`${server.session.url}/api/frontend`, {
        method: "POST",
        headers,
        body: JSON.stringify({ running }),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ running: boolean; url: string; code: string }>;
    };
    try {
      assert.equal((await fetch(`${server.session.url}/api/frontend/code`, { method: "POST", headers })).status, 409);
      const on = await action(true);
      assert.equal(on.running, true);
      assert.ok(on.code);
      assert.equal(new URL(on.url).hash, "");
      const login = async (code: string) =>
        fetch(`${server.session.url}/api/auth/login`, { method: "POST", body: JSON.stringify({ code }) });
      const accepted = await login(on.code);
      assert.equal(accepted.status, 200);
      const cookie = accepted.headers.get("set-cookie")!.split(";")[0]!;
      const unused = (
        (await (await fetch(`${server.session.url}/api/frontend/code`, { method: "POST", headers })).json()) as {
          code: string;
        }
      ).code;
      const sessionFile = await fs.readFile(path.join(dir, "server.json"), "utf8");
      assert.equal(sessionFile.includes(on.code) || sessionFile.includes(unused), false);
      assert.equal((await action(false)).running, false);
      assert.equal((await fetch(`${server.session.url}/api/state`, { headers: { Cookie: cookie } })).status, 401);
      const restarted = await action(true);
      assert.equal((await login(unused)).status, 401);
      for (let i = 0; i < 7; i++) assert.equal((await login("0000-0000-0000-0000")).status, 401);
      assert.equal((await login(restarted.code)).status, 429);
      const audit = await fs.readFile(path.join(dir, "logs", "audit.log"), "utf8");
      for (const code of [on.code, unused, restarted.code]) assert.equal(audit.includes(code), false);
    } finally {
      await server.close();
      await cleanup(dir);
    }
  },
);

test("frontend off revokes a login that is still waiting for its audit write", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), inlineFrontend: true });
  const headers = { Authorization: `Bearer ${server.session.token}` };
  const originalAudit = logger.audit.bind(logger);
  let entered!: () => void;
  let release!: () => void;
  const pendingAudit = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const auditGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const access = await fetch(`${server.session.url}/api/frontend/code`, { method: "POST", headers });
    const { code } = (await access.json()) as { code: string };
    logger.audit = async (event, fields) => {
      if (event === "auth.login.succeeded") {
        entered();
        await auditGate;
      }
      return originalAudit(event, fields);
    };
    const login = fetch(`${server.session.url}/api/auth/login`, {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    await pendingAudit;
    const off = await fetch(`${server.session.url}/api/frontend`, {
      method: "POST",
      headers,
      body: JSON.stringify({ running: false }),
    });
    assert.equal(off.status, 200);
    release();
    const response = await login;
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const state = await fetch(`${server.session.url}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(state.status, 401);
  } finally {
    release();
    logger.audit = originalAudit;
    await server.close();
    await cleanup(dir);
  }
});

test(
  "frontend code runs against a service without a TTY and prints a structured code",
  { timeout: 60_000 },
  async () => {
    const dir = await tempDir();
    const server = await startAshServer({ config: testConfig(dir), inlineFrontend: true });
    try {
      const { stdout, stderr } = await exec(
        process.execPath,
        ["--import", "tsx", "src/index.ts", "frontend", "code", "--json"],
        {
          timeout: 45_000,
          env: {
            ...process.env,
            ASH_ENV_FILE: path.join(dir, "missing.env"),
            ASH_DEMO: "1",
            ASH_SIMULATE: "true",
            ASH_DATA_DIR: dir,
            ASH_MODEL_PROVIDER: "demo",
            TELEGRAM_BOT_TOKEN: "",
            TELEGRAM_CHAT_ID: "",
          },
        },
      );
      assert.equal(stderr, "");
      const result = JSON.parse(stdout);
      assert.equal(result.ok, true);
      assert.equal(result.simulated, true);
      assert.ok(result.code);
      const redeem = await fetch(`${server.session.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ code: result.code }),
      });
      assert.equal(redeem.status, 200);
    } finally {
      await server.close();
      await cleanup(dir);
    }
  },
);

test("overlapping B actions cannot advance past a pending frontend transition", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  const server = await startAshServer({
    config: testConfig(dir, { ASH_SERVER_UI: "false", ASH_SERVER_PORT: "0" }),
    inlineFrontend: true,
  });
  const originalAudit = logger.audit.bind(logger);
  let entered!: () => void;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const headers = { Authorization: `Bearer ${server.session.token}` };
  try {
    logger.audit = async (event, fields) => {
      if (event === "frontend.on") {
        entered();
        await gate;
      }
      return originalAudit(event, fields);
    };
    const first = fetch(`${server.session.url}/api/frontend/cycle`, { method: "POST", headers });
    await pending;
    const overlap = await fetch(`${server.session.url}/api/frontend/cycle`, { method: "POST", headers });
    assert.equal(overlap.status, 409);
    release();
    const result = (await (await first).json()) as { next_action: string; code: string | null };
    assert.equal(result.next_action, "code");
    assert.equal(result.code, null);
  } finally {
    release();
    logger.audit = originalAudit;
    await server.close();
    await cleanup(dir);
  }
});
