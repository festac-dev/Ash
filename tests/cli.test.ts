import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Theme } from "../src/cli/theme.js";
import { panel } from "../src/cli/components.js";
import { renderStartup } from "../src/cli/splash.js";
import { Shell } from "../src/cli/app.js";
import { createServices } from "../src/cli/services.js";
import { createDemoTask } from "../src/demo.js";
import { hashJson } from "../src/util/json.js";
import { tempDir, cleanup, testConfig } from "./helpers.js";

function fakeStream(columns: number, isTTY = false): NodeJS.WriteStream {
  return { columns, rows: 24, isTTY } as unknown as NodeJS.WriteStream;
}

test("theme falls back to ASCII and no colour on small terminals", () => {
  const theme = new Theme({ colorMode: "never", unicodeMode: "never" }, fakeStream(40));
  assert.equal(theme.color, false);
  assert.equal(theme.unicode, false);
  const lines = panel(theme, "ASH", ["A budget-safe plan", "Committed 14.00 USDC"], { width: 40, shadow: true });
  assert.ok(lines.every((line) => !line.includes("\u001b[")));
  assert.ok(lines.every((line) => Buffer.byteLength(line, "utf8") <= 42));
  assert.ok(lines.join("\n").includes("+"));
});

test("theme supports colour on a capable TTY when the environment permits it", () => {
  const previous = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM };
  try {
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    const theme = new Theme({ colorMode: "always", unicodeMode: "always" }, fakeStream(80, true));
    assert.equal(theme.color, true);
    const text = theme.gradient("ASH");
    assert.ok(text.includes("\u001b[38;5;"));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("ASCII startup markers do not double their brackets", () => {
  const theme = new Theme({ colorMode: "never", unicodeMode: "never" }, fakeStream(80));
  const lines = renderStartup(theme, [{ label: "Core engine", status: "ok", detail: "online" }]);
  assert.ok(lines.some((line) => line.includes("[OK] Core engine")));
  assert.equal(
    lines.some((line) => line.includes("[[OK]]")),
    false,
  );
});

function runCli(
  args: string[],
  input: string,
  dataDir: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", ...(args.length ? args : ["shell"])], {
    cwd: process.cwd(),
    input,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      ASH_DEMO: "1",
      ASH_SIMULATE: "true",
      ASH_MODEL_PROVIDER: "demo",
      ASH_DATA_DIR: dataDir,
      ASH_COLOR_MODE: "never",
      ASH_UNICODE_MODE: "never",
      ASH_ANIMATION: "false",
      ASH_MAX_PARALLEL_JOBS: "3",
      NO_COLOR: "1",
    },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

test("CLI help and status run with no colour and no task", async () => {
  const dir = await tempDir();
  try {
    const help = runCli(["--help"], "", dir);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /task execution & settlement/);
    assert.doesNotMatch(help.stdout, /general contractor/i);
    assert.equal(help.stdout.includes("\u001b["), false);
    const status = runCli(["status"], "", dir);
    assert.equal(status.status, 0);
    assert.match(status.stdout, /NO ACTIVE TASK/);
    assert.equal(status.stdout.includes("\u001b["), false);
    const shell = runCli(["shell"], "status\nexit\n", dir);
    assert.equal(shell.status, 0);
    assert.match(shell.stdout, /NO ACTIVE TASK/);
  } finally {
    await cleanup(dir);
  }
});

test("headless command errors and broken receipt chains return failure", async () => {
  const dir = await tempDir();
  try {
    assert.equal(runCli([], "unknown\nexit\n", dir).status, 1);
    assert.equal(runCli([], "execute\nexit\n", dir).status, 1);
    await fs.mkdir(path.join(dir, "transactions"), { recursive: true });
    await fs.writeFile(path.join(dir, "transactions", ".chain-head.json"), "corrupt");
    const broken = runCli(["verify"], "", dir);
    assert.equal(broken.status, 1);
    assert.match(broken.stdout, /FAILED/);
  } finally {
    await cleanup(dir);
  }
});

test("read-only CLI commands exit without waiting for stdin EOF", { timeout: 30_000 }, async () => {
  const dir = await tempDir();
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "status"], {
    env: {
      ...process.env,
      ASH_DATA_DIR: dir,
      ASH_DEMO: "1",
      ASH_SIMULATE: "true",
      ASH_MODEL_PROVIDER: "demo",
      ASH_ANIMATION: "false",
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let error = "";
  child.stderr.on("data", (data) => {
    error += String(data);
  });
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on("exit", resolve);
      child.on("error", reject);
    });
    assert.equal(code, 0, error);
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    child.kill();
    await cleanup(dir);
  }
});

for (const pause of ["manual", "automatic"] as const) {
  for (const command of ["cmdResume", "cmdExecute"] as const) {
    test(`CLI ${command} rechecks an expired plan approval after ${pause} pause`, async () => {
      const dir = await tempDir();
      const config = testConfig(dir);
      const services = await createServices(config);
      const shell = new Shell(services, new Theme(config, fakeStream(80)));
      try {
        const id = await createDemoTask(config);
        const task = await services.store.load(id);
        const manager = services.store.approvals(id);
        const request = await manager.request({
          kind: "plan",
          summary: "Approve local plan",
          amount: "14.00",
          currency: "USDC",
          scope: { plan_hash: hashJson(task.plan), currency: "USDC" },
        });
        await manager.decide(request.id, "approved", manager.confirmationPhrase(request));
        await services.store.update(id, (current) => {
          current.execution_strategy = "plan_then_approve";
          current.plan_approval_ref = request.id;
          current.plan_approved_at = new Date().toISOString();
          for (const state of current.subtasks) state.next_check_at = "2099-01-01T00:00:00Z";
        });
        await shell["cmdExecute"]();
        assert.equal(services.engine.isRunningTask(id), true);
        if (pause === "manual") await shell["cmdPause"]();
        else await services.engine["pauseTask"](id, "Paused after a recoverable marketplace error.");
        assert.equal(services.engine.isRunning(), pause === "automatic");
        assert.equal((await services.store.load(id)).status, "paused");
        const file = path.join(services.store.taskDir(id), "approvals.json");
        const approvals = JSON.parse(await fs.readFile(file, "utf8"));
        approvals.requests[0].expires_at = "2000-01-01T00:00:00Z";
        await fs.writeFile(file, JSON.stringify(approvals));
        await assert.rejects(() => shell[command](), /Approve the plan/);
        assert.equal((await services.store.load(id)).status, "awaiting_plan_approval");
        assert.equal(services.engine.isRunning(), false);
        assert.equal((await manager.pending()).length, 1);
      } finally {
        await shell.close();
        await cleanup(dir);
      }
    });
  }
}

test("CLI wizard creates a dynamic task and a plan without editing source", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  try {
    const input = [
      "Build a production-ready website with authentication, a dashboard, payment integration and automated tests.",
      "realworld",
      "testnet",
      "USDC on NEAR",
      "",
      "",
      "",
      "150 USDC",
      "",
      "",
      "",
      "2",
      "y",
      "y",
      "y",
      "3",
      "",
      "y",
      "y",
      "exit",
    ].join("\n");
    const result = runCli([], `${input}\n`, dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PLAN READY/);
    assert.match(result.stdout, /Plan approval required/);
    const taskDirs = (await fs.readdir(path.join(dir, "tasks"))).filter((name) => name.startsWith("task_"));
    assert.equal(taskDirs.length, 1);
    const task = JSON.parse(await fs.readFile(path.join(dir, "tasks", taskDirs[0]!, "task.json"), "utf8")) as {
      status: string;
      authorized_budget: string;
      currency: string;
      track_id: string | null;
      project_scopes: string[];
      track_inputs: Record<string, string>;
      plan: { subtasks: unknown[] };
    };
    assert.equal(task.authorized_budget, "150");
    assert.equal(task.currency, "USDC");
    assert.equal(task.status, "awaiting_plan_approval");
    assert.equal(task.track_id, "ash");
    assert.deepEqual(task.project_scopes, ["realworld"]);
    assert.equal(task.track_inputs["realworld.network"], "testnet");
    assert.ok(task.plan.subtasks.length >= 3);
    const approvals = JSON.parse(
      await fs.readFile(path.join(dir, "tasks", taskDirs[0]!, "approvals.json"), "utf8"),
    ) as {
      requests: Array<{ id: string; kind: string; status: string }>;
    };
    const planRequest = approvals.requests.find((request) => request.kind === "plan");
    assert.ok(planRequest);

    const wrong = runCli([], `approve ${planRequest!.id}\nAPPROVE wrong\nstatus\nexit\n`, dir);
    assert.match(wrong.stdout, /did not match/i);
    const afterWrong = JSON.parse(
      await fs.readFile(path.join(dir, "tasks", taskDirs[0]!, "approvals.json"), "utf8"),
    ) as {
      requests: Array<{ id: string; status: string }>;
    };
    assert.equal(afterWrong.requests.find((request) => request.id === planRequest!.id)?.status, "pending");

    const correct = runCli([], `approve ${planRequest!.id}\nAPPROVE ${planRequest!.id}\nexit\n`, dir);
    assert.equal(correct.status, 0);
    const afterCorrect = JSON.parse(
      await fs.readFile(path.join(dir, "tasks", taskDirs[0]!, "approvals.json"), "utf8"),
    ) as {
      requests: Array<{ id: string; status: string }>;
    };
    assert.equal(afterCorrect.requests.find((request) => request.id === planRequest!.id)?.status, "approved");
  } finally {
    await cleanup(dir);
  }
});
