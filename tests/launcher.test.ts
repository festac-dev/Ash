import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkHealth, healthySession, tuiEnvironment } from "../src/launcher.js";
import { startAshServer } from "../src/server/server.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

test("launcher verifies backend identity and refuses live/simulation mode changes", async () => {
  const dir = await tempDir();
  const config = testConfig(dir);
  const ash = await startAshServer({ config });
  const fake = createServer((_req, res) => {
    res.end(JSON.stringify({ ok: true, service: "other" }));
  });
  try {
    assert.equal(await checkHealth(ash.session), true);
    assert.equal((await healthySession(config))?.pid, process.pid);
    await assert.rejects(() => healthySession({ ...config, simulation: false }), /Stop it before switching/);
    assert.equal(await checkHealth({ ...ash.session, pid: process.pid + 1 }), false);
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address() as { port: number };
    assert.equal(await checkHealth({ ...ash.session, url: `http://127.0.0.1:${address.port}` }), false);
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    await ash.close();
    await cleanup(dir);
  }
});

test("TUI subprocess receives terminal settings without backend or unrelated secrets", () => {
  const result = tuiEnvironment({
    PATH: "/bin",
    SystemRoot: "C:\\Windows",
    TERM: "xterm-256color",
    ASH_ANIMATION: "false",
    MARKET_API_TOKEN: "market-secret",
    ASH_MODEL_API_KEY: "model-secret",
    TELEGRAM_BOT_TOKEN: "bot-secret",
    CUSTOM_SECRET: "private",
    ASH_API_TOKEN: "old-token",
  });
  assert.deepEqual(result, { PATH: "/bin", SystemRoot: "C:\\Windows", TERM: "xterm-256color", ASH_ANIMATION: "false" });
});

test("concurrent detached launches share one backend and shutdown releases it", { timeout: 180_000 }, async () => {
  const dir = await tempDir();
  const env = {
    ...process.env,
    ASH_ENV_FILE: path.join(dir, "absent.env"),
    ASH_DATA_DIR: dir,
    ASH_DEMO: "1",
    ASH_SIMULATE: "true",
    ASH_MODEL_PROVIDER: "demo",
    ASH_SERVER_HOST: "127.0.0.1",
    ASH_SERVER_PORT: "0",
    ASH_SERVER_ALLOW_REMOTE: "false",
    ASH_SERVER_PUBLIC_URL: "",
    ASH_SERVER_UI: "false",
    ASH_SERVER_TOKEN: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    MARKET_API_TOKEN: "",
    MARKET_API_TOKEN_FILE: "",
  };
  const run = (...args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ["--import", "tsx", "src/index.ts", "server", ...args],
        { env, timeout: 60_000 },
        (error, stdout, stderr) =>
          error
            ? reject(
                new Error(
                  `${error.message}\n${JSON.stringify({ code: error.code, signal: error.signal, killed: error.killed })}\n${stderr}`,
                ),
              )
            : resolve(stdout),
      );
    });
  try {
    const outputs = await Promise.all([run("start"), run("start")]);
    const pids = outputs.map((output) => /pid (\d+)/.exec(output)?.[1]);
    assert.ok(pids[0]);
    assert.equal(pids[0], pids[1]);
    const session = JSON.parse(await fs.readFile(path.join(dir, "server.json"), "utf8"));
    assert.equal(await checkHealth(session), true);
    assert.ok((await fs.stat(path.join(dir, "logs", "server.log"))).isFile());
    await run("stop");
    assert.equal(await checkHealth(session), false);
    await assert.rejects(() => fs.stat(path.join(dir, "server.json")), /ENOENT/);
  } finally {
    await run("stop").catch(() => undefined);
    await cleanup(dir);
  }
});
