import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load } from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const docker = process.argv.includes("--docker");
const stage = await fs.mkdtemp(path.join(os.tmpdir(), "ash-deployment-review-"));
const app = path.join(stage, "app");
const osEnv = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
const report = {
  simulated_infrastructure: !docker,
  container_runtime: false,
  mode: docker ? "docker" : "hosting-simulation",
  started_at: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  hosted_deployment: false,
  ok: false,
  negative_checks: [],
  scenarios: [],
  limitations: [],
};
let activeStage = "preflight";
let safeFailure;
const resultPath = path.join(
  root,
  "docs",
  docker ? "container-runtime-results.json" : "deployment-simulation-results.json",
);
await fs.writeFile(resultPath, JSON.stringify(report, null, 2) + "\n");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execute = (command, args, options = {}) =>
  exec(command, args, { timeout: 45_000, maxBuffer: 2 * 1024 * 1024, ...options });
async function waitFor(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`${label} timed out`);
}
async function port() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}
async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}
async function proxyFor(upstreamPort, tls) {
  const forward = (req, res) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, "x-forwarded-proto": tls ? "https" : "http", "x-forwarded-for": "192.0.2.10" },
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  };
  const ca = await fs.readFile(path.join(stage, "cert.pem"));
  const server = tls
    ? https.createServer({ cert: ca, key: await fs.readFile(path.join(stage, "key.pem")) }, forward)
    : http.createServer(forward);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `${tls ? "https" : "http"}://localhost:${server.address().port}`;
  const request = (route, options = {}) =>
    new Promise((resolve, reject) => {
      const req = (tls ? https : http).request(
        new URL(route, origin),
        {
          family: 4,
          ca,
          method: options.method ?? "GET",
          headers: { Origin: origin, ...options.headers },
        },
        (response) => {
          if (options.stream) {
            resolve(response);
            return;
          }
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }),
          );
          response.on("error", reject);
        },
      );
      req.on("error", reject);
      req.setTimeout(15_000, () => req.destroy(new Error("Proxy request timed out")));
      req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
    });
  return { server, origin, request };
}
async function localRuntime(env, entrypoint = false) {
  let child,
    exited,
    session,
    output = "";
  const start = async () => {
    const previous = session?.started_at;
    child = spawn(
      entrypoint ? "/bin/sh" : process.execPath,
      entrypoint
        ? [path.join(app, "ash-entrypoint.sh"), process.execPath, "dist/server/main.js"]
        : ["dist/server/main.js"],
      { cwd: app, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    exited = once(child, "exit");
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output = (output + chunk).slice(-200_000);
      });
    await waitFor(async () => {
      assert.equal(child.exitCode, null, "Production server exited during startup; inspect the test configuration");
      session = await fs
        .readFile(path.join(env.ASH_DATA_DIR, "server.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null);
      return session && session.started_at !== previous;
    }, "Production server startup");
    assert.equal(session.port, Number(env.ASH_SERVER_PORT || env.PORT));
  };
  const stop = async (signal = "SIGTERM") => {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      let timer;
      try {
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("Shutdown exceeded 15 seconds"));
            }, 15_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (signal === "SIGTERM") assert.equal(child.exitCode, 0);
    }
  };
  const cli = async (action) => {
    const response = await execute(process.execPath, ["dist/index.js", "frontend", action, "--json"], {
      cwd: app,
      env,
    });
    assert.equal(response.stderr, "");
    return JSON.parse(response.stdout);
  };
  const doctor = async () =>
    JSON.parse((await execute(process.execPath, ["dist/index.js", "doctor", "--json"], { cwd: app, env })).stdout);
  return { start, stop, cli, doctor, logs: async () => output, env, session: () => session };
}
async function containerRuntime(env, bindPort) {
  const name = `ash-check-${randomBytes(6).toString("hex")}`;
  const volume = `${name}-data`;
  const image = process.env.ASH_TEST_IMAGE || "ash:ci";
  let created = false;
  let volumeCreated = false;
  const control = (args) => execute("docker", args, { env: { ...process.env, ...env }, timeout: 60_000 });
  const start = async () => {
    if (!volumeCreated) {
      await control(["volume", "create", volume]);
      volumeCreated = true;
    }
    if (!created) {
      await control([
        "create",
        "--pull=never",
        "--name",
        name,
        "--read-only",
        "--ulimit",
        "core=0",
        "--tmpfs",
        "/tmp:rw,size=64m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--mount",
        `type=volume,source=${volume},target=/var/lib/ash`,
        "-p",
        `127.0.0.1:${bindPort}:5050`,
        ...Object.keys(env)
          .filter((key) => key.startsWith("ASH_") || key === "NODE_ENV")
          .flatMap((key) => ["--env", key]),
        image,
      ]);
      created = true;
    }
    await control(["start", name]);
    await waitFor(
      async () => {
        const state = JSON.parse((await control(["inspect", name])).stdout)[0].State;
        assert.equal(state.Running, true, "Container exited during startup");
        return state.Health?.Status === "healthy";
      },
      "Container health",
      60_000,
    );
  };
  const cli = async (action) => JSON.parse((await control(["exec", name, "ash", "frontend", action, "--json"])).stdout);
  const stop = async (signal = "SIGTERM") => {
    if (created) await control(signal === "SIGKILL" ? ["kill", name] : ["stop", "--time", "15", name]);
  };
  const inspect = async () => {
    const details = JSON.parse((await control(["inspect", name])).stdout)[0];
    assert.equal(details.HostConfig.ReadonlyRootfs, true);
    assert.equal(details.Config.User, "node");
    assert.ok(
      details.HostConfig.Ulimits.some((limit) => limit.Name === "core" && limit.Soft === 0 && limit.Hard === 0),
    );
    await control([
      "exec",
      name,
      "node",
      "-e",
      "if(process.getuid()===0)process.exit(1);try{require.resolve('typescript');process.exit(2)}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}",
    ]);
  };
  const cleanup = async () => {
    try {
      if (created) await control(["rm", "-f", name]);
    } finally {
      if (volumeCreated) await control(["volume", "rm", volume]);
    }
  };
  return {
    start,
    stop,
    cli,
    doctor: async () => JSON.parse((await control(["exec", name, "ash", "doctor", "--json"])).stdout),
    inspect,
    cleanup,
    logs: async () => {
      const result = await control(["logs", name]);
      return result.stdout + result.stderr;
    },
  };
}
async function exercise(profile, runtime, proxy, dataDir) {
  const checks = [];
  const pass = (name) => {
    checks.push(name);
    activeStage = `${profile.name}: after ${name}`;
  };
  const request = proxy.request;
  await runtime.start();
  await runtime.inspect?.();
  assert.equal((await request("/readyz")).status, 200);
  assert.equal((await request("/api/state")).status, 401);
  assert.equal((await runtime.cli("status")).running, profile.ui);
  pass("startup, readiness, manifest UI default and unauthenticated denial");
  if (!profile.ui) assert.equal((await request("/")).status, 404);
  const access = await runtime.cli("on");
  assert.equal(access.running, true);
  assert.equal(access.simulated, false, "Production application must not enter demo mode");
  assert.ok(access.code);
  const doctor = await runtime.doctor();
  assert.equal(doctor.web.enabled, true);
  assert.equal(doctor.web.start_on_boot, profile.ui);
  assert.equal(doctor.web.url, access.url);
  const html = await request("/");
  assert.equal(html.status, 200);
  assert.match(html.headers["content-security-policy"], /default-src/);
  assert.equal(html.headers["x-frame-options"], "DENY");
  assert.equal((await request("/workspace")).status, 200);
  assert.equal((await request("/workspace/controls")).status, 200);
  pass("landing, workspace and task controls served through deployment proxy");
  const protectedAdmin = await request("/api/frontend/code", {
    method: "POST",
    headers: { Authorization: `Bearer ${runtime.env?.ASH_SERVER_TOKEN || profile.token}` },
  });
  assert.equal(protectedAdmin.status, 403);
  const signIn = (code) => request("/api/auth/login", { method: "POST", body: { code } });
  const login = await signIn(access.code);
  assert.equal(login.status, 200);
  const setCookie = login.headers["set-cookie"][0];
  assert.ok(setCookie.includes("; HttpOnly"), "Session cookie must be HttpOnly");
  assert.ok(setCookie.includes("; SameSite=Strict"), "Session cookie must use SameSite=Strict");
  assert.equal(setCookie.includes("; Secure"), profile.tls);
  const cookie = setCookie.split(";")[0];
  assert.equal((await signIn(access.code)).status, 401);
  pass("private CLI code, HTTPS/SSH-forwarded login, cookie policy, replay and proxy admin denial");
  const headers = { Cookie: cookie, "X-Ash-Client": "web" };
  const draft = {
    description: `SIMULATED DEPLOYMENT CHECK: ${profile.name} persistent draft; no execution`,
    budget: "5.00",
    currency: "USDC",
  };
  assert.equal((await request("/api/tasks", { method: "POST", headers: { Cookie: cookie }, body: draft })).status, 403);
  assert.equal(
    (
      await request("/api/tasks", {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body: draft,
      })
    ).status,
    403,
  );
  const stream = await request("/api/events", { headers, stream: true });
  let events = "";
  stream.on("data", (chunk) => {
    events += chunk;
  });
  stream.on("error", () => {});
  try {
    const created = await request("/api/tasks", { method: "POST", headers, body: draft });
    assert.equal(created.status, 201);
    const task = created.json().task;
    assert.equal(task.status, "draft");
    await waitFor(() => events.includes("event: refresh"), "Proxy SSE delivery");
    const id = task.id;
    pass("CSRF, real draft persistence and unbuffered SSE");
    const pendingCode = (await runtime.cli("code")).code;
    await runtime.stop();
    await runtime.start();
    assert.equal((await request("/api/state", { headers })).status, 401);
    // Fresh-install OFF defaults return 403; configured ON rejects the stale code with 401.
    const restarted = await runtime.cli("on");
    assert.equal((await signIn(pendingCode)).status, 401);
    const freshLogin = await signIn(restarted.code);
    assert.equal(freshLogin.status, 200);
    const freshHeaders = { Cookie: freshLogin.headers["set-cookie"][0].split(";")[0], "X-Ash-Client": "web" };
    const state = (await request("/api/state", { headers: freshHeaders })).json();
    assert.equal(state.task.id, id);
    assert.equal(state.task.status, "draft");
    assert.equal(state.engine_running, false);
    assert.equal(state.ledger.paid, "0.00");
    pass("SIGTERM with SSE, persistent restart, session/code revocation and no automatic spending");
    if (dataDir) {
      assert.equal((await fs.stat(path.join(dataDir, "server.json"))).mode & 0o777, 0o600);
      const parked = `${dataDir}-parked`;
      await fs.rename(dataDir, parked);
      try {
        await fs.writeFile(dataDir, "isolated simulated storage fault");
        await pause(1_100);
        assert.equal((await request("/readyz")).status, 503);
        assert.equal((await request("/healthz")).status, 200);
      } finally {
        await fs.unlink(dataDir);
        await fs.rename(parked, dataDir);
      }
      await pause(1_100);
      assert.equal((await request("/readyz")).status, 200);
      pass("storage outage returns 503 while liveness stays up; recovery and private file modes");
      await runtime.stop();
      const backup = `${dataDir}-backup`;
      await fs.cp(dataDir, backup, { recursive: true });
      await fs.rename(dataDir, `${dataDir}-original`);
      await fs.cp(backup, dataDir, { recursive: true });
      await runtime.start();
      pass("quiesced backup copied and restored into a new data directory");
    }
    await runtime.stop("SIGKILL");
    await runtime.start();
    pass(
      docker ? "container kill/restart preserves the named volume" : "process crash/restart preserves restored state",
    );
    const finalCode = (await runtime.cli("on")).code;
    const finalLogin = await signIn(finalCode);
    assert.equal(finalLogin.status, 200);
    const finalHeaders = { Cookie: finalLogin.headers["set-cookie"][0].split(";")[0] };
    assert.equal((await request("/api/state", { headers: finalHeaders })).json().task.id, id);
    await runtime.cli("logout-all");
    assert.equal((await request("/api/state", { headers: finalHeaders })).status, 401);
    await runtime.cli("off");
    assert.equal((await request("/")).status, 404);
    const logs = await runtime.logs();
    for (const code of [access.code, pendingCode, restarted.code, finalCode])
      assert.equal(logs.includes(code), false, "A one-time code leaked into service logs");
    assert.equal(
      logs.includes("ASH_TEST_OUTBOUND_BLOCKED"),
      false,
      "Application attempted an unexpected provider call",
    );
    pass("restored task, logout-all, frontend OFF and credential-free service logs");
  } finally {
    stream.destroy();
  }
  await runtime.stop();
  report.scenarios.push({ name: profile.name, passed: true, checks });
  console.log(`${docker ? "[CONTAINER]" : "[SIMULATED HOSTING]"} PASS ${profile.name}: ${checks.length} checks`);
}

async function negativeCases() {
  const base = {
    ...osEnv,
    NODE_ENV: "production",
    ASH_ENV_FILE: path.join(stage, "absent.env"),
    ASH_DATA_DIR: path.join(stage, "negative-data"),
    ASH_MODEL_PROVIDER: "ollama",
    ASH_MODEL_NAME: "no-inference",
    ASH_MODEL_BASE_URL: "http://127.0.0.1:9",
    ASH_SERVER_PORT: "0",
  };
  const rejected = async (name, values, expected) => {
    await assert.rejects(
      () =>
        execute(process.execPath, ["dist/server/main.js"], { cwd: app, env: { ...base, ...values }, timeout: 20_000 }),
      (error) => Number(error.code) > 0 && expected.test(error.stderr),
    );
    report.negative_checks.push(name);
  };
  await rejected("missing model configuration", { ASH_MODEL_PROVIDER: "none" }, /No model provider configured/);
  await rejected("demo prohibited in production", { ASH_DEMO: "1" }, /disabled when NODE_ENV=production/);
  await rejected(
    "public plain HTTP refused",
    { ASH_BIND_HOST: "0.0.0.0", ASH_SERVER_ALLOW_REMOTE: "true", ASH_SERVER_TOKEN: randomBytes(32).toString("hex") },
    /Public binding requires/,
  );
  const invalidStore = path.join(stage, "not-a-directory");
  await fs.writeFile(invalidStore, "simulated invalid volume mount");
  await rejected("invalid storage mount", { ASH_DATA_DIR: invalidStore }, /EEXIST|ENOTDIR/);
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  try {
    await rejected(
      "occupied bind port",
      { ASH_SERVER_PORT: String(listener.address().port) },
      /EADDRINUSE|address already in use/,
    );
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
  const index = path.join(app, "dist/web/index.html");
  const html = await fs.readFile(index, "utf8");
  const script = /src="(\/assets\/[^\"]+\.js)"/.exec(html)?.[1];
  assert.ok(script, "Built HTML must reference a module script");
  for (const [name, file] of [
    ["missing entry HTML", index],
    ["missing entry script", path.join(app, "dist/web", script)],
  ]) {
    await fs.rename(file, `${file}.withheld`);
    try {
      await rejected(name, { ASH_SERVER_UI: "true" }, /Frontend asset[s]?.*missing/);
    } finally {
      await fs.rename(`${file}.withheld`, file);
    }
  }
  const env = { ...base, ASH_SERVER_UI: "true", ASH_SERVER_PORT: String(await port()) };
  const running = await localRuntime(env);
  try {
    await running.start();
    await running.cli("off");
    await fs.rename(index, `${index}.withheld`);
    try {
      await assert.rejects(
        () => running.cli("on"),
        (error) => /Frontend assets are missing/.test(error.stdout),
      );
      assert.equal((await running.cli("status")).running, false);
      assert.equal((await fetch(running.session().url)).status, 404);
      report.negative_checks.push("failed frontend activation stays OFF");
    } finally {
      await fs.rename(`${index}.withheld`, index);
    }
  } finally {
    await running.stop();
  }
  console.log(`[SIMULATED HOSTING] PASS ${report.negative_checks.length} startup/activation failure cases`);
}

try {
  console.log(
    docker
      ? "Actual local Docker runtime check; no hosted deployment or paid providers."
      : "SIMULATED HOSTING: actual production processes and local proxy/storage; no cloud deployment or paid providers.",
  );
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    path.join(stage, "key.pem"),
    "-out",
    path.join(stage, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  const compose = load(await fs.readFile(path.join(root, "compose.yaml"), "utf8"));
  const render = load(await fs.readFile(path.join(root, "render.yaml"), "utf8"));
  const railway = JSON.parse(await fs.readFile(path.join(root, "railway.json"), "utf8"));
  assert.equal(railway.deploy.startCommand, "node dist/server/main.js");
  const unit = await fs.readFile(path.join(root, "deploy/ash.service"), "utf8");
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/ash\/dist\/server\/main.js/);
  const privateValues = Object.fromEntries(
    [...unit.matchAll(/^Environment=([^=\n]+)=([^\n]+)$/gm)].map((match) => [match[1], match[2]]),
  );
  const profiles = docker
    ? [{ name: "Docker image", values: compose.services.ash.environment, ui: true, tls: true }]
    : [
        { name: "Docker Compose", values: compose.services.ash.environment, ui: true, tls: true, entrypoint: true },
        {
          name: "Render",
          entrypoint: true,
          values: Object.fromEntries(
            render.services[0].envVars.filter((v) => v.value !== undefined).map((v) => [v.key, String(v.value)]),
          ),
          ui: true,
          tls: true,
        },
        {
          name: "Railway dynamic PORT",
          entrypoint: true,
          values: { ASH_BIND_HOST: "0.0.0.0", ASH_SERVER_ALLOW_REMOTE: "true", ASH_SERVER_UI: "true" },
          dynamicPort: true,
          ui: true,
          tls: true,
        },
        {
          name: "Railway frontend OFF at boot",
          values: { ASH_BIND_HOST: "0.0.0.0", ASH_SERVER_ALLOW_REMOTE: "true", ASH_SERVER_UI: "false" },
          dynamicPort: true,
          entrypoint: true,
          ui: false,
          tls: true,
        },
        { name: "Private server TLS", values: { ...privateValues, ASH_BIND_HOST: "127.0.0.1" }, ui: false, tls: true },
        {
          name: "Private server SSH forwarding",
          values: { ...privateValues, ASH_BIND_HOST: "127.0.0.1" },
          ui: false,
          tls: false,
        },
      ];
  if (!docker) {
    await fs.mkdir(app);
    await fs.cp(path.join(root, "dist"), path.join(app, "dist"), { recursive: true });
    for (const file of ["package.json", "package-lock.json"])
      await fs.copyFile(path.join(root, file), path.join(app, file));
    await fs.copyFile(path.join(root, "deploy/ash-entrypoint.sh"), path.join(app, "ash-entrypoint.sh"));
    console.log("Installing the locked production-only runtime dependencies in a private temporary directory…");
    await execute(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"],
      { cwd: app, timeout: 600_000, env: osEnv },
    );
    assert.equal(
      await fs
        .stat(path.join(app, "node_modules/typescript"))
        .then(() => true)
        .catch(() => false),
      false,
    );
    await fs.writeFile(
      path.join(stage, "guard.mjs"),
      `import net from 'node:net';
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const value = normalized[0];
  const host = typeof value === 'object' ? value.host : typeof normalized[1] === 'string' ? normalized[1] : undefined;
  const port = typeof value === 'object' ? value.port : value;
  const localPort = Number(process.env.ASH_SERVER_PORT || process.env.PORT);
  if ((host && !['127.0.0.1', 'localhost', '::1'].includes(host)) || !localPort || Number(port) !== localPort) {
    process.stderr.write('ASH_TEST_OUTBOUND_BLOCKED\\n');
    throw new Error('Test forbids provider network calls');
  }
  return original.apply(this, args);
};\n`,
    );
    activeStage = "provider network guard self-test";
    await execute(
      process.execPath,
      [
        "--import",
        path.join(stage, "guard.mjs"),
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict'; import net from 'node:net';
for (const args of [[9, '127.0.0.1'], [{host:'192.0.2.1',port:443}], [[{host:'127.0.0.1',port:9}]]]) {
  assert.throws(() => new net.Socket().connect(...args), /Test forbids provider network calls/);
}`,
      ],
      { env: { ...osEnv, ASH_SERVER_PORT: "5050" } },
    );
    report.network_guard_verified = true;
  } else {
    activeStage = "Docker daemon preflight";
    try {
      const version = await execute("docker", ["version", "--format", "{{.Server.Version}}"]);
      assert.ok(/^\d+\.\d+/.test(version.stdout.trim()));
    } catch {
      safeFailure = "No reachable Docker daemon. Start Docker, build ash:ci, then rerun npm run test:container.";
      throw new Error(safeFailure);
    }
    activeStage = "Docker image preflight";
    try {
      await execute("docker", ["image", "inspect", process.env.ASH_TEST_IMAGE || "ash:ci"]);
    } catch {
      safeFailure =
        "Test image is unavailable locally. Run docker build -t ash:ci . or set ASH_TEST_IMAGE to a built image.";
      throw new Error(safeFailure);
    }
  }
  for (const profile of profiles) {
    activeStage = `${profile.name}: setup`;
    const bindPort = await port();
    const proxy = await proxyFor(bindPort, profile.tls);
    const dataDir = path.join(stage, profile.name.replaceAll(" ", "-") + "-data");
    const env = {
      ...osEnv,
      NODE_ENV: "production",
      ASH_MODEL_PROVIDER: "ollama",
      ASH_MODEL_NAME: "deployment-smoke-no-inference",
      ASH_MODEL_BASE_URL: "http://127.0.0.1:9",
      ...profile.values,
      ASH_ENV_FILE: path.join(stage, "absent.env"),
      ASH_DATA_DIR: docker ? "/var/lib/ash" : dataDir,
      ASH_SERVER_TOKEN: randomBytes(32).toString("hex"),
      ASH_SERVER_PORT: docker ? "5050" : String(bindPort),
      ASH_SERVER_SECURE_COOKIES: profile.tls ? "always" : "auto",
      ...(profile.tls ? { ASH_PUBLIC_URL: proxy.origin } : {}),
      ...(!docker ? { NODE_OPTIONS: `--import=${pathToFileURL(path.join(stage, "guard.mjs")).href}` } : {}),
    };
    profile.token = env.ASH_SERVER_TOKEN;
    if (profile.dynamicPort) {
      delete env.ASH_SERVER_PORT;
      env.PORT = String(bindPort);
    }
    let runtime;
    let failure;
    try {
      runtime = docker ? await containerRuntime(env, bindPort) : await localRuntime(env, profile.entrypoint);
      await exercise(profile, runtime, proxy, docker ? null : dataDir);
    } catch (error) {
      failure = error;
    }
    try {
      try {
        await runtime?.stop();
      } finally {
        try {
          await runtime?.cleanup?.();
        } finally {
          await closeServer(proxy.server);
        }
      }
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }
  if (!docker) {
    activeStage = "startup/activation failure cases";
    await negativeCases();
  }
  report.limitations = docker
    ? ["No Render/Railway/private-server account deployment; no paid provider execution"]
    : [
        "No containers, namespaces, cgroups, actual read-only mounts, platform edge routing or cloud account deployment",
        "SSH forwarding transport modeled by a local proxy; SSH authentication is not emulated",
        "Fixed platform ports and data paths remapped to private temporary resources",
        "No model inference, marketplace calls or payments; no production demo-mode override",
      ];
  report.ok = true;
  report.container_runtime = docker;
  report.completed_at = new Date().toISOString();
  console.log(JSON.stringify(report));
} catch (error) {
  report.failure = {
    stage: activeStage,
    reason:
      safeFailure ||
      (error?.code === "ERR_ASSERTION"
        ? "Verification assertion failed. Review the assertions at this stage and rerun."
        : "Runtime check failed. Check local prerequisites and rerun; raw subprocess output is withheld to protect credentials."),
  };
  if (error?.code === "ERR_ASSERTION") {
    report.failure.assertion = {};
    for (const key of ["actual", "expected"])
      if (error[key] === null || ["number", "boolean"].includes(typeof error[key]))
        report.failure.assertion[key] = error[key];
  }
  report.completed_at = new Date().toISOString();
  console.error(`FAIL ${report.failure.stage}: ${report.failure.reason}`);
  process.exitCode = 1;
} finally {
  try {
    await fs.writeFile(resultPath, JSON.stringify(report, null, 2) + "\n");
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
