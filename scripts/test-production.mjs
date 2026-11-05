import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = await fs.mkdtemp(path.join(os.tmpdir(), "ash-production-smoke-"));
let child;
let closed;
try {
  // Match the source-free runtime image without requiring a Docker daemon.
  await fs.cp(path.join(root, "dist"), path.join(stage, "dist"), { recursive: true });
  await fs.copyFile(path.join(root, "package.json"), path.join(stage, "package.json"));
  await fs.symlink(path.join(root, "node_modules"), path.join(stage, "node_modules"), "junction");
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    ASH_ENV_FILE: path.join(stage, "absent.env"),
    ASH_DATA_DIR: path.join(stage, "state"),
    ASH_MODEL_PROVIDER: "ollama",
    ASH_MODEL_NAME: "deployment-smoke-no-inference",
    ASH_MODEL_BASE_URL: "http://127.0.0.1:9",
    ASH_SERVER_HOST: "127.0.0.1",
    ASH_SERVER_PORT: "0",
    ASH_SERVER_UI: "false",
  };
  child = spawn(process.execPath, ["dist/server/main.js"], { cwd: stage, env, stdio: "pipe" });
  closed = once(child, "exit");
  let diagnostics = "";
  child.stdout.on("data", (chunk) => {
    diagnostics += chunk;
  });
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  const file = path.join(env.ASH_DATA_DIR, "server.json");
  let session;
  const deadline = Date.now() + 30_000;
  while (!session) {
    assert.equal(child.exitCode, null, diagnostics);
    assert.ok(Date.now() < deadline, "Production startup timed out");
    session = await fs
      .readFile(file, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (!session) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await fetch(`${session.url}/readyz`)).status, 200);
  assert.equal((await fetch(session.url)).status, 404, "Frontend must start OFF");
  // Explicitly exercise the runtime-only asset resolver too.
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {ensureFrontendBuild} from './dist/server/frontend-build.js'; await ensureFrontendBuild();",
    ],
    { cwd: stage, env },
  );
  const cli = async (action) => {
    const result = await promisify(execFile)(process.execPath, ["dist/index.js", "frontend", action, "--json"], {
      cwd: stage,
      env,
      timeout: 30_000,
    });
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  };
  const on = await cli("on");
  assert.equal(on.simulated, false);
  assert.equal(on.running, true);
  assert.ok(on.code);
  const landing = await (await fetch(session.url)).text();
  assert.match(landing, /landing-page/);
  assert.doesNotMatch(landing, /workspace-main/);
  const workspace = await fetch(`${session.url}/workspace`);
  assert.equal(workspace.status, 200);
  assert.match(await workspace.text(), /Connect your workspace/);
  const controls = await fetch(`${session.url}/workspace/controls`);
  assert.equal(controls.status, 200);
  const controlsHtml = await controls.text();
  const appearance = landing.match(/<link[^>]+href="(\/assets\/[^"<>]+\.css)"[^>]*>/)?.[1];
  assert.ok(appearance, "Landing must reference its shared appearance sheet");
  assert.ok(controlsHtml.includes(appearance), "Task controls must use the same built appearance sheet");
  const stylesheet = await fetch(`${session.url}${appearance}`);
  assert.equal(stylesheet.status, 200);
  assert.match(await stylesheet.text(), /Manrope/);
  assert.equal((await fetch(`${session.url}/assets/theme.js`)).status, 200);
  const login = await fetch(`${session.url}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ code: on.code }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await cli("off")).running, false);
  assert.equal((await fetch(`${session.url}/api/state`, { headers: { Cookie: cookie } })).status, 401);
  child.kill("SIGTERM");
  const [code] = await closed;
  assert.equal(code, 0);
  assert.equal(
    await fs
      .stat(file)
      .then(() => true)
      .catch(() => false),
    false,
  );
  console.log(
    "PASS: source-free production startup, readiness, OFF default, separate landing/workspace assets, non-TTY code login, revocation and SIGTERM cleanup. No model inference or marketplace spending attempted.",
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await closed;
  }
  await fs.rm(stage, { recursive: true, force: true });
}
