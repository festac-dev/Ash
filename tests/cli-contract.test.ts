import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { commands, completion, helpText } from "../src/cli/commands.js";
import { cleanup, tempDir } from "./helpers.js";
const exec = promisify(execFile);

test("every advertised command has usage and an example; shell completions include frontend", () => {
  for (const command of Object.keys(commands)) {
    const text = helpText(command);
    assert.match(text, /Usage: ash/);
    assert.match(text, /Example:/);
  }
  for (const shell of ["bash", "zsh", "fish"]) assert.match(completion(shell), /frontend/);
  assert.throws(() => helpText("unknown"), /Unknown command/);
  assert.throws(() => completion("unknown"), /Choose a completion shell/);
});

test(
  "headless output contains JSON only; flag errors and unsupported JSON have distinct actionable failures",
  { timeout: 180_000 },
  async () => {
    const dir = await tempDir();
    const env = {
      ...process.env,
      ASH_DEMO: "1",
      ASH_SIMULATE: "true",
      ASH_MODEL_PROVIDER: "demo",
      ASH_DATA_DIR: dir,
      ASH_ENV_FILE: path.join(dir, "missing.env"),
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      ASH_SERVER_PORT: "0",
      ASH_SERVER_UI: "false",
    };
    const run = (...args: string[]) =>
      exec(process.execPath, ["--import", "tsx", "src/index.ts", ...args], { env, timeout: 30_000 });
    try {
      for (const command of ["status", "tasks", "verify"]) {
        const result = await run(command, "--json", "--no-color");
        const body = JSON.parse(result.stdout);
        assert.equal(body.ok, true);
        assert.equal(body.simulated, true);
        assert.equal(body.command, command);
        assert.equal(result.stderr, "");
      }
      const quiet = await run("status", "--quiet");
      assert.doesNotMatch(quiet.stdout, /INITIALIZ|STARTUP|Core engine/);
      try {
        for (const [sub, expected] of [
          ["start", true],
          ["status", true],
          ["stop", false],
        ] as const) {
          const response = await run("server", sub, "--json");
          const result = JSON.parse(response.stdout);
          assert.equal(result.running, expected);
          assert.equal(result.simulated, true);
          assert.equal(result.ok, true);
          assert.equal(response.stderr, "");
        }
      } finally {
        await run("server", "stop", "--json");
      }
      for (const args of [
        ["status", "--unknown", "--json"],
        ["cancel", "--json"],
      ]) {
        await assert.rejects(
          () => run(...args),
          (error) => {
            const result = error as Error & { code: number; stdout: string };
            assert.equal(result.code, 2);
            assert.equal(JSON.parse(result.stdout).ok, false);
            return true;
          },
        );
      }
    } finally {
      await cleanup(dir);
    }
  },
);
