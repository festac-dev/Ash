import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import path from "node:path";
import { Theme } from "../src/cli/theme.js";
import { runApiShell } from "../src/cli/api-shell.js";
import { frontendRequest } from "../src/cli/frontend.js";
import { startAshServer } from "../src/server/server.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

// Codes are captured in memory for assertions, never printed or saved to test artifacts.
test(
  "B starts without a code, second B prints a usable code, third B revokes browser access",
  { timeout: 300_000 },
  async () => {
    const dir = await tempDir();
    const config = testConfig(dir, { ASH_SERVER_UI: "false", ASH_SERVER_PORT: "0" });
    const server = await startAshServer({ config, inlineFrontend: true });
    const run = async (commands: string) => {
      let output = "";
      const code = await runApiShell(server.session, config, {
        input: Readable.from([commands]),
        output: new Writable({
          write(chunk, _encoding, done) {
            output += chunk.toString();
            done();
          },
        }),
      });
      assert.equal(code, 0);
      return output;
    };
    try {
      assert.equal((await frontendRequest(server.session, "status")).next_action, "start");
      const first = await run("B\nquit\n");
      assert.match(first, /Frontend ON/);
      assert.match(first, /generate access code/);
      assert.doesNotMatch(first, /One-time code:/);
      const second = await run("B\nquit\n");
      const code = /One-time code: ([A-F0-9-]+)/.exec(second)?.[1];
      assert.ok(code, "Second B must display the actual code, not a redaction placeholder");
      assert.equal((await frontendRequest(server.session, "status")).next_action, "stop");
      const login = await fetch(`${server.session.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const state = () => fetch(`${server.session.url}/api/state`, { headers: { Cookie: cookie } });
      assert.equal((await state()).status, 200);
      const unused = await frontendRequest(server.session, "code");
      const third = await run("B\nquit\n");
      assert.match(third, /Frontend OFF/);
      assert.equal((await state()).status, 401);
      assert.equal((await frontendRequest(server.session, "status")).next_action, "start");
      await frontendRequest(server.session, "cycle");
      const revoked = await fetch(`${server.session.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ code: unused.code }),
      });
      assert.equal(revoked.status, 401);
      assert.equal((await frontendRequest(server.session, "status")).next_action, "code");
    } finally {
      await server.close();
      await cleanup(dir);
    }
  },
);

test(
  "API shell creates real shared task state, supports reads, and reports invalid commands without traces",
  { timeout: 60_000 },
  async () => {
    const dir = await tempDir();
    const config = testConfig(dir, { ASH_SERVER_UI: "false", ASH_SERVER_PORT: "0" });
    const server = await startAshServer({ config, inlineFrontend: true });
    let output = "";
    try {
      const result = await runApiShell(server.session, config, {
        input: Readable.from([
          "help\nnew Shared terminal task\n25\nUSDC\ntasks\nsettings\nbudget\napprovals\nhistory\ntransactions\nverify\nmarket\nagents\njobs\nchat Summarize my task\nunknown-command\nstatus\nquit\n",
        ]),
        output: new Writable({
          write(chunk, _encoding, done) {
            output += chunk.toString();
            done();
          },
        }),
      });
      assert.equal(result, 1);
      assert.match(output, /Task created:/);
      assert.match(output, /\[DEMO\]/);
      assert.match(output, /Unknown command unknown-command. Type help/);
      assert.doesNotMatch(output, /\n\s+at |Error: (?!Unknown command)/);
      const task = await server.services.store.resolveRef("active");
      assert.equal(task.description, "Shared terminal task");
      assert.equal(task.status, "draft");
      assert.equal(server.services.engine.isRunning(), false);
      const response = await fetch(`${server.session.url}/api/state`, {
        headers: { Authorization: `Bearer ${server.session.token}` },
      });
      assert.equal(((await response.json()) as { active_task_id: string }).active_task_id, task.id);
    } finally {
      await server.close();
      await cleanup(dir);
    }
  },
);

function terminalProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  input: string,
): Promise<{ code: number | null; output: string; error: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], { env, stdio: "pipe" });
    let output = "",
      error = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Terminal did not close after quit/EOF"));
    }, 120_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output, error });
    });
    child.stdin.end(input);
  });
}

test("start --shell attaches to the existing service and leaves it running on quit", { timeout: 150_000 }, async () => {
  const dir = await tempDir();
  const server = await startAshServer({
    config: testConfig(dir, { ASH_SERVER_UI: "false", ASH_SERVER_PORT: "0" }),
    inlineFrontend: true,
  });
  try {
    const result = await terminalProcess(
      ["start", "--shell"],
      {
        ...process.env,
        ASH_ENV_FILE: path.join(dir, "missing.env"),
        ASH_DATA_DIR: dir,
        ASH_DEMO: "1",
        ASH_SIMULATE: "true",
        ASH_MODEL_PROVIDER: "demo",
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_CHAT_ID: "",
      },
      "status\nquit\n",
    );
    assert.equal(result.code, 0, result.error);
    assert.match(result.output, /ASH WORKSPACE/);
    assert.match(result.output, /Frontend OFF/);
    assert.equal((await fetch(`${server.session.url}/healthz`)).status, 200);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test(
  "demo --shell completes the simulation with empty configuration then accepts terminal commands",
  { timeout: 150_000 },
  async () => {
    const result = await terminalProcess(
      ["demo", "--shell"],
      { PATH: process.env.PATH, ESBUILD_BINARY_PATH: process.env.ESBUILD_BINARY_PATH, NO_COLOR: "1" },
      "tasks\nstatus\nquit\n",
    );
    assert.equal(result.code, 0, result.error);
    assert.match(result.output, /Completed\./);
    assert.match(result.output, /ASH WORKSPACE/);
    assert.match(result.output, /Frontend OFF/);
    assert.match(result.output, /Freelancer launch pack/);
    assert.doesNotMatch(result.output, /One-time code:/);
    const dir = /Private temporary data: (.+)/.exec(result.output)?.[1];
    if (dir) await cleanup(dir);
  },
);

test("demo stops promptly when interrupted during the automated flow", { timeout: 60_000 }, async () => {
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "demo", "--shell"], {
    env: { PATH: process.env.PATH, ESBUILD_BINARY_PATH: process.env.ESBUILD_BINARY_PATH },
    stdio: "pipe",
  });
  let interrupted = false;
  const stopped = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Interrupted demo did not stop"));
    }, 50_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!interrupted && output.includes("Executing with local providers")) {
        interrupted = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.resume();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  try {
    assert.equal(await stopped, 130);
    assert.equal(interrupted, true);
  } finally {
    child.kill("SIGTERM");
    const dir = /Private temporary data: (.+)/.exec(output)?.[1];
    if (dir) await cleanup(dir);
  }
});

test(
  "terminal planning and exact approvals use the shared service's authorization gates",
  { timeout: 120_000 },
  async () => {
    const dir = await tempDir();
    const config = testConfig(dir, { ASH_SERVER_UI: "false", ASH_SERVER_PORT: "0" });
    const server = await startAshServer({ config, inlineFrontend: true });
    const run = async (commands: string) =>
      runApiShell(server.session, config, {
        input: Readable.from([commands]),
        output: new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      });
    try {
      assert.equal(await run("new Terminal approval review\n30\nUSDC\nplan\nquit\n"), 0);
      const task = await server.services.store.resolveRef("active");
      const approval = (await server.service.state()).approvals.find((item) => item.status === "pending")!;
      assert.ok(approval);
      assert.equal(await run(`approve ${approval.id}\nAPPROVE wrong\nquit\n`), 1);
      assert.equal((await server.service.state()).approvals.find((item) => item.id === approval.id)?.status, "pending");
      assert.equal(await run(`approve ${approval.id}\nAPPROVE ${approval.id}\nquit\n`), 0);
      assert.equal((await server.services.store.load(task.id)).status, "planned");
      assert.equal(await run(`cancel\nCANCEL wrong\nquit\n`), 1);
      assert.equal((await server.services.store.load(task.id)).status, "planned");
      assert.equal(await run(`cancel\nCANCEL ${task.id}\nquit\n`), 0);
      assert.equal((await server.services.store.load(task.id)).status, "cancelled");
    } finally {
      await server.close();
      await cleanup(dir);
    }
  },
);

test("text shell respects NO_COLOR and redirected output even when color is configured always", () => {
  const previous = process.env.NO_COLOR;
  try {
    process.env.NO_COLOR = "1";
    const terminal = { isTTY: true, columns: 80, rows: 24 } as NodeJS.WriteStream;
    assert.equal(new Theme({ colorMode: "always", unicodeMode: "never" }, terminal).color, false);
    delete process.env.NO_COLOR;
    const pipe = { isTTY: false, columns: 80, rows: 24 } as NodeJS.WriteStream;
    assert.equal(new Theme({ colorMode: "always", unicodeMode: "never" }, pipe).color, false);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});
