import { frontendRequest, frontendText, workspaceUrl, type FrontendResult } from "./cli/frontend.js";
import { helpText, completion } from "./cli/commands.js";
import { runJsonCommand } from "./cli/headless.js";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promises as fs, statSync, openSync, closeSync, accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, loadDotEnv, publicConfig, type AppConfig } from "./config.js";
import { runApp } from "./cli/app.js";
import { AshError, errorMessage, isAshError } from "./errors.js";
import { ensurePrivateDir, readTailLines, withFileLock } from "./util/fs.js";
import { redact } from "./util/redact.js";
import { nowIso } from "./util/time.js";
import { readServerSession, sessionFile, type ServerSession } from "./server/server.js";

import { APP_VERSION as VERSION } from "./version.js";
const API_TOKEN_ENV = "ASH_API_TOKEN";
const API_URL_ENV = "ASH_API_URL";
const spawnErrors = new WeakMap<ChildProcess, Error>();

interface BackendHandle {
  session: ServerSession;
  owned: boolean;
  child: ChildProcess | null;
}

export async function runLauncher(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    const target = argv[0] === "help" ? argv[1] : argv.find((arg) => !arg.startsWith("-"));
    process.stdout.write(helpText(target));
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    printVersion();
    return 0;
  }
  const allowed = new Set([
    "--json",
    "--quiet",
    "-q",
    "--verbose",
    "--debug",
    "--no-color",
    "--headless",
    "--shell",
    "--remote",
    "--open",
    "--stop",
  ]);
  const bad = argv.find((arg) => arg.startsWith("-") && !allowed.has(arg));
  if (bad) throw new AshError("VALIDATION_FAILED", `Unknown option ${bad}. Run ash --help.`);
  if (argv.includes("--no-color")) {
    process.env.ASH_COLOR_MODE = "never";
    process.env.NO_COLOR = "1";
  }
  if (argv.includes("--quiet") || argv.includes("-q")) process.env.ASH_NO_SPLASH = "1";
  if (argv.includes("--verbose") || argv.includes("--debug")) process.env.ASH_LOG_LEVEL = "debug";
  argv = argv.filter((arg) => !["--quiet", "-q", "--verbose", "--debug", "--no-color"].includes(arg));
  const [command, ...rest] = argv;
  if (command === "completion") {
    process.stdout.write(completion(rest[0] ?? ""));
    return 0;
  }
  if (command && rest.includes("--json") && !["doctor", "server", "demo", "frontend", "start"].includes(command)) {
    const config = loadOrReportConfig();
    if (!config) return 2;
    return runJsonCommand(
      config,
      command,
      rest.filter((arg) => arg !== "--json"),
    );
  }
  if (process.env.ASH_DEMO === "1" && command === undefined) {
    const { runDemo } = await import("./demo/runtime.js");
    return runDemo(rest);
  }
  switch (command) {
    case undefined:
      if (!process.stdin.isTTY) return legacyShell([]);
      return launchTui({ allowFallback: true });
    case "start":
      if (rest.includes("--json"))
        throw new AshError("VALIDATION_FAILED", "Start is interactive. Use ash server start --json for automation.");
      return launchTui({ allowFallback: true, shell: rest.includes("--shell") || rest.includes("shell") });
    case "demo": {
      const { runDemo } = await import("./demo/runtime.js");
      return runDemo(rest);
    }
    case "tui":
      return launchTui({ allowFallback: false, remote: rest.includes("--remote") });
    case "shell":
      return legacyShell(rest);
    case "--remote":
      return launchTui({ allowFallback: false, remote: true });
    case "frontend":
      return frontendCommand(rest);
    case "server":
      return serverCommand(rest);
    case "web":
    case "remote":
      return webCommand(loadOrReportConfig(), rest);
    case "doctor":
      return doctor(rest.includes("--json"));
    case "logs":
      return logs(rest);
    case "__server__":
      return 1; // Handled by src/index.ts before the launcher.
    default:
      return legacy(command, rest);
  }
}

async function launchTui(options: { allowFallback: boolean; remote?: boolean; shell?: boolean }): Promise<number> {
  if (options.remote) return launchRemoteTui();
  const config = loadOrReportConfig();
  if (!config) return 2;
  let backend: BackendHandle | null = null;
  try {
    backend = await ensureBackend(config);
    return await runTerminal(config, backend.session, options);
  } finally {
    if (backend?.owned) await shutdownBackend(backend.session, backend.child, config.dataDir);
  }
}

/** Attach either terminal client to an existing backend; never create another engine. */
export async function runTerminal(
  config: AppConfig,
  session: ServerSession,
  options: { allowFallback?: boolean; shell?: boolean } = {},
): Promise<number> {
  const tui = findTuiBinary();
  if (options.shell || !process.stdin.isTTY || !tui) {
    if (options.allowFallback === false && !options.shell)
      throw new AshError(
        "CONFIG_INVALID",
        "The TUI needs Go and a terminal. Run npm start -- --shell for the command interface.",
      );
    const { runApiShell } = await import("./cli/api-shell.js");
    return runApiShell(session, config);
  }
  const child = spawn(tui, [], {
    cwd: process.cwd(),
    env: {
      ...tuiEnvironment(process.env),
      [API_URL_ENV]: session.url,
      [API_TOKEN_ENV]: session.token,
      ASH_TUI_VERSION: VERSION,
    },
    stdio: "inherit",
  });
  const onSigint = () => child.kill("SIGINT");
  const onSigterm = () => child.kill("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    return await waitForExit(child);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

async function launchRemoteTui(): Promise<number> {
  loadDotEnv();
  const tui = findTuiBinary();
  if (!tui) {
    process.stderr.write("Ash TUI is not built. Run `npm run build:tui` (Go 1.25+ required).\n");
    return 1;
  }
  const url = process.env.ASH_API_URL?.trim();
  const token = process.env.ASH_API_TOKEN?.trim();
  if (!url || !token) {
    process.stderr.write(
      "Remote TUI mode needs ASH_API_URL and ASH_API_TOKEN for the Ash backend it should attach to.\n",
    );
    return 2;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    process.stderr.write("ASH_API_URL must be an http(s) URL.\n");
    return 2;
  }
  const child = spawn(tui, [], {
    cwd: process.cwd(),
    env: { ...tuiEnvironment(process.env), ASH_API_URL: url, ASH_API_TOKEN: token, ASH_TUI_VERSION: VERSION },
    stdio: "inherit",
  });
  const onSigint = (): void => {
    child.kill("SIGINT");
  };
  const onSigterm = (): void => {
    child.kill("SIGTERM");
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    return await waitForExit(child);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

async function serverCommand(argv: string[]): Promise<number> {
  const sub = argv.find((arg) => !arg.startsWith("-")) ?? "status";
  const config = loadOrReportConfig();
  if (!config) return 2;
  if (sub === "start") return startDetached(config, argv.includes("--json"));
  if (sub === "stop") return stopServer(config, argv.includes("--json"));
  if (sub === "status") return statusServer(config, argv.includes("--json"));
  throw new AshError("VALIDATION_FAILED", `Unknown server command "${sub}". Use start, stop or status.`);
}

async function startDetached(config: AppConfig, json = false): Promise<number> {
  if (json) {
    const session = (await healthySession(config)) ?? (await spawnBackend(config, true));
    if (config.server.ui) await controlFrontend(session, true);
    return statusServer(config, true);
  }
  const existing = await healthySession(config);
  if (existing) {
    process.stdout.write(`Ash API is already running at ${existing.url} (pid ${existing.pid}).\n`);
    if (config.server.ui)
      process.stdout.write(
        `Ash web UI: ${existing.remote ? existing.ui_url : (await controlFrontend(existing, true)).url}\n`,
      );
    return 0;
  }
  const session = await spawnBackend(config, true);
  process.stdout.write(`Ash API started at ${session.url} (pid ${session.pid}).\n`);
  if (config.server.ui)
    process.stdout.write(
      `Ash web UI: ${session.remote ? session.ui_url : (await controlFrontend(session, true)).url}\n`,
    );
  if (session.remote) {
    process.stdout.write(`Remote mode: enabled (bind ${session.bind_host}); use TLS or a trusted private network.\n`);
  }
  return 0;
}

async function frontendCommand(args: string[]): Promise<number> {
  const action = args.find((arg) => !arg.startsWith("-")) ?? "status";
  if (!["on", "off", "status", "code", "logout-all"].includes(action))
    throw new AshError("VALIDATION_FAILED", "Use ash frontend on|off|status|code|logout-all.");
  const config = loadOrReportConfig();
  if (!config) return 2;
  let session = await healthySession(config);
  if (!session && action === "on") session = await spawnBackend(config, true);
  if (!session && ["code", "logout-all"].includes(action))
    throw new AshError("CONFLICT", "Frontend is OFF. Run ash frontend on first.");
  const result = session
    ? await frontendRequest(session, action)
    : { running: false, url: null, port: null, next_action: "start" as const };
  if (args.includes("--json"))
    process.stdout.write(
      `${JSON.stringify({ ok: true, simulated: config.simulation, ...result, workspace_url: result.url ? workspaceUrl(result.url) : null })}\n`,
    );
  else {
    process.stdout.write(frontendText(result, config.simulation));
    if (action === "logout-all") process.stdout.write("All browser sessions and unused codes revoked.\n");
  }
  return 0;
}

async function webCommand(_config: AppConfig | null, argv: string[]): Promise<number> {
  const code = await frontendCommand([
    argv.includes("--stop") ? "off" : "on",
    ...argv.filter((arg) => arg === "--json"),
  ]);
  if (code || !argv.includes("--open")) return code;
  const config = loadOrReportConfig();
  if (!config) return 2;
  const session = await healthySession(config);
  if (session) {
    const status = await frontendRequest(session, "status");
    if (status.url && !(await openBrowser(workspaceUrl(status.url))))
      process.stderr.write("No browser opener is available. Open the URL above on your computer.\n");
  }
  return 0;
}

async function controlFrontend(session: ServerSession, running: boolean): Promise<FrontendResult> {
  return frontendRequest(session, running ? "on" : "off");
}

async function frontendUrl(session: ServerSession): Promise<string | null> {
  try {
    const response = await fetch(`${session.url}/api/frontend`, {
      headers: { Authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const status = (await response.json()) as { running: boolean; url: string | null };
    return status.running ? status.url : null;
  } catch {
    return null;
  }
}

export async function openBrowser(url: string): Promise<boolean> {
  const name =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : findExecutable("termux-open-url")
          ? "termux-open-url"
          : "xdg-open";
  const command = findExecutable(name);
  if (!command) return false;
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", timeout: 10_000 });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function stopServer(config: AppConfig, json = false): Promise<number> {
  const report = (message: string) =>
    process.stdout.write(
      json
        ? `${JSON.stringify({ ok: true, simulated: config.simulation, running: false, message })}\n`
        : `${message}\n`,
    );
  const session = await readServerSession(config.dataDir);
  if (!session) {
    report("Ash API is not running (no session file).");
    return 0;
  }
  const healthy = await checkHealth(session);
  if (!healthy) {
    if (processAlive(session.pid))
      throw new AshError(
        "CONFLICT",
        "The recorded server process is still alive but not responding. Its session has been preserved; inspect server.log before retrying.",
      );
    await fs.rm(sessionFile(config.dataDir), { force: true });
    report("Ash API session was stale; removed it. No process was signalled.");
    return 0;
  }
  await shutdownBackend(session, null, config.dataDir);
  report("Ash API stopped.");
  return 0;
}

async function statusServer(config: AppConfig, json: boolean): Promise<number> {
  const session = await readServerSession(config.dataDir);
  if (!session) {
    if (json)
      process.stdout.write(`${JSON.stringify({ ok: true, simulated: config.simulation, running: false }, null, 2)}\n`);
    else process.stdout.write("Ash API is not running.\n");
    return 0;
  }
  const health = await checkHealth(session);
  const uiUrl = health ? await frontendUrl(session) : null;
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: health,
          simulated: config.simulation,
          running: health,
          url: session.url,
          ui_url: uiUrl,
          remote: session.remote,
          bind_host: session.bind_host,
          pid: session.pid,
          started_at: session.started_at,
          version: session.version,
        },
        null,
        2,
      )}\n`,
    );
  } else if (health) {
    process.stdout.write(
      `Ash API: running\nURL: ${session.url}\nUI: ${uiUrl ?? "stopped"}\nRemote: ${session.remote ? `enabled (bind ${session.bind_host})` : "disabled (loopback)"}\nPID: ${session.pid}\nStarted: ${session.started_at}\n`,
    );
  } else {
    process.stdout.write(
      `Ash API: not responding\nSession file: ${sessionFile(config.dataDir)}\nPID: ${session.pid}\n`,
    );
    return 1;
  }
  return health ? 0 : 1;
}

async function doctor(json: boolean): Promise<number> {
  const config = loadOrReportConfig();
  if (!config) return 2;
  const session = await readServerSession(config.dataDir);
  const healthy = session ? await checkHealth(session) : false;
  const uiUrl = healthy && session ? await frontendUrl(session) : null;
  const tui = findTuiBinary();
  const go = findGoBinary();
  const integrity = await (async () => {
    try {
      const { TransactionLedger } = await import("./transactions/ledger.js");
      return await new TransactionLedger(config.dataDir).verify();
    } catch (error) {
      return { ok: false, error: redact(errorMessage(error)) };
    }
  })();
  const view = publicConfig(config);
  const result = {
    version: VERSION,
    simulated: config.simulation,
    node: process.version,
    node_ok:
      Number(process.versions.node.split(".")[0]) > 22 ||
      (Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1]) >= 13),
    data_dir: config.dataDir,
    api: { running: healthy, url: session?.url ?? null, pid: session?.pid ?? null },
    web: {
      enabled: Boolean(uiUrl),
      start_on_boot: config.server.ui,
      remote: session?.remote ?? view.server.remote,
      url: uiUrl,
      public_url: session?.public_url ?? config.server.publicUrl,
    },
    tui: { built: Boolean(tui), path: tui, go: go ?? null },
    model: {
      provider: view.model_provider,
      configured: view.model_provider !== "none",
      key: view.model_key_configured,
    },
    market: {
      url: view.market_url,
      mode: view.market_mode,
      token: view.market_token_configured,
      hiring: view.hiring_mode,
    },
    telegram: { configured: view.telegram_configured },
    integrity,
    generated_at: nowIso(),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `Ash doctor · ${VERSION}`,
        `Node ${process.version}${result.node_ok ? "" : " (requires >=22.13)"}`,
        `Data directory ${config.dataDir}`,
        `API: ${healthy ? `running at ${session?.url}` : "not running"}`,
        `Web UI: ${uiUrl ?? "stopped"}${config.server.allowRemote ? " (remote allowed)" : ""}`,
        `TUI: ${tui ? tui : "not built (npm run build:tui)"}`,
        `Go: ${go ?? "not found"}`,
        `Model: ${view.model_provider}${view.model_provider === "none" ? " (planning disabled)" : ""}`,
        `Market: ${view.market_mode} · token ${view.market_token_configured ? "configured" : "not configured"}`,
        `Telegram: ${view.telegram_configured ? "configured" : "disabled"}`,
        `Receipt chain: ${integrity && "ok" in integrity ? (integrity.ok ? "verified" : "BROKEN") : "unavailable"}`,
        "",
      ].join("\n"),
    );
  }
  return result.node_ok && (!("ok" in integrity) || integrity.ok) ? 0 : 1;
}

async function logs(argv: string[]): Promise<number> {
  const config = loadOrReportConfig();
  if (!config) return 2;
  const lines = Math.max(1, Math.min(500, Number(argv[0] ?? 40) || 40));
  const files = [path.join(config.dataDir, "logs", "ash.log"), path.join(config.dataDir, "logs", "audit.log")];
  let found = false;
  for (const file of files) {
    try {
      const tail = (await readTailLines(file, lines)).join("\n");
      if (tail) {
        found = true;
        process.stdout.write(`# ${file}\n${tail}\n\n`);
      }
    } catch {
      // A missing log is expected before the first run.
    }
  }
  if (!found) process.stdout.write("No Ash logs yet.\n");
  return 0;
}

async function legacy(command: string, rest: string[]): Promise<number> {
  return legacyShell([command, ...rest]);
}

async function legacyShell(argv: string[]): Promise<number> {
  const config = loadOrReportConfig();
  if (!config) return 2;
  return runApp(config, argv);
}

async function ensureBackend(config: AppConfig, detached = false): Promise<BackendHandle> {
  return withFileLock(
    path.join(config.dataDir, "server-start.lock"),
    async () => {
      const existing = await healthySession(config);
      if (existing) return { session: existing, owned: false, child: null };
      await fs.rm(sessionFile(config.dataDir), { force: true });
      const child = await spawnBackendProcess(config, detached);
      const session = await waitForBackend(config, child);
      return { session, owned: true, child };
    },
    { timeoutMs: 30_000, staleMs: 30_000 },
  );
}

async function spawnBackend(config: AppConfig, detached: boolean): Promise<ServerSession> {
  return (await ensureBackend(config, detached)).session;
}

async function spawnBackendProcess(config: AppConfig, detached: boolean): Promise<ChildProcess> {
  const script = process.argv[1];
  if (!script) throw new AshError("STATE_INVALID", "Cannot locate the Ash entry point.");
  const isTs = script.endsWith(".ts");
  const args = isTs ? ["--import", "tsx", script, "__server__"] : [script, "__server__"];
  const logDir = path.join(config.dataDir, "logs");
  await ensurePrivateDir(logDir);
  const logFd = (() => {
    try {
      return openSync(path.join(logDir, "server.log"), "a", 0o600);
    } catch {
      return "ignore" as const;
    }
  })();
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ASH_SERVER_DAEMON: detached ? "1" : "0",
      ASH_LOCAL_CORE: config.server.allowRemote ? "0" : "1",
    },
    detached,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.on("error", (error) => spawnErrors.set(child, error));
  if (detached) child.unref();
  if (typeof logFd === "number") {
    try {
      closeSync(logFd);
    } catch {
      // The child inherited the descriptor.
    }
  }
  return child;
}

async function waitForBackend(config: AppConfig, child: ChildProcess): Promise<ServerSession> {
  const deadline = Date.now() + 20_000;
  let lastError = "backend did not write a session file";
  while (Date.now() < deadline) {
    const spawnError = spawnErrors.get(child);
    if (spawnError) throw new AshError("STATE_INVALID", `Could not start Ash API: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      const tail = await tailServerLog(config);
      throw new AshError(
        "STATE_INVALID",
        `Ash API exited during startup (code ${child.exitCode}).${tail ? `\n${tail}` : ""}`,
      );
    }
    const session = await readServerSession(config.dataDir);
    if (session) {
      if (session.pid !== child.pid && child.pid !== undefined) {
        lastError = "another Ash API wrote the session file";
      } else if (await checkHealth(session)) {
        return session;
      } else {
        lastError = "Ash API did not pass its health check";
      }
    }
    await sleep(120);
  }
  child.kill("SIGTERM");
  throw new AshError("STATE_INVALID", `Ash API did not become ready: ${lastError}`, {
    hint: `Inspect ${path.join(config.dataDir, "logs", "server.log")}.`,
  });
}

export async function healthySession(config: AppConfig): Promise<ServerSession | null> {
  const session = await readServerSession(config.dataDir);
  if (!session) return null;
  if (await checkHealth(session, config.simulation ? "SIMULATION" : "LIVE")) return session;
  if (processAlive(session.pid))
    throw new AshError(
      "CONFLICT",
      "The recorded server process is still alive but not responding as ASH. Stop it or inspect server.log before starting another backend.",
    );
  return null;
}

export async function checkHealth(session: ServerSession, expectedMode?: "SIMULATION" | "LIVE"): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${session.url}/api/health`, {
      headers: { Authorization: `Bearer ${session.token}` },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = (await response.json()) as Record<string, unknown>;
    if (
      body?.ok !== true ||
      body.service !== "ash" ||
      body.pid !== session.pid ||
      body.started_at !== session.started_at
    )
      return false;
    if (expectedMode && body.mode !== expectedMode) {
      throw new AshError(
        "CONFIG_INVALID",
        `The running ASH backend is in ${body.mode === "LIVE" ? "LIVE" : "a different"} mode. Stop it before switching to ${expectedMode}.`,
      );
    }
    return true;
  } catch (error) {
    if (isAshError(error)) throw error;
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function shutdownBackend(session: ServerSession, child: ChildProcess | null, dataDir: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    await fetch(`${session.url}/api/admin/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}` },
      signal: controller.signal,
    });
  } catch {
    // If the API is gone, fall through to the waiting/cleanup path.
  } finally {
    clearTimeout(timer);
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processAlive(session.pid)) break;
    await sleep(100);
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    try {
      await waitForExit(child);
    } finally {
      clearTimeout(forceKill);
    }
  }
  if (processAlive(session.pid))
    throw new AshError(
      "CONFLICT",
      "The server has not finished shutting down. Its session has been preserved; retry shortly.",
    );
  const current = await readServerSession(dataDir).catch(() => null);
  if (current?.token === session.token) {
    // The server normally removes its own file; this is a fallback for a hard exit.
    await fs.rm(sessionFile(dataDir), { force: true }).catch(() => undefined);
  }
}

function findTuiBinary(): string | null {
  const binaryName = process.platform === "win32" ? "ash-tui.exe" : "ash-tui";
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, binaryName),
    path.join(moduleDir, "..", "dist", binaryName),
    path.join(process.cwd(), "dist", binaryName),
    path.join(process.cwd(), "tui", "bin", binaryName),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next location.
    }
  }
  return findExecutable(binaryName);
}

function findExecutable(name: string): string | null {
  const windows = process.platform === "win32";
  const extensions = windows && !path.extname(name) ? [".exe", ".com"] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), name + extension);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, windows ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        /* Continue searching PATH. */
      }
    }
  }
  return null;
}

function findGoBinary(): string | null {
  const candidates = [
    process.env.ASH_GO_BIN,
    findExecutable("go"),
    "/usr/local/go/bin/go",
    path.join(process.env.HOME ?? "", "go", "bin", "go"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["version"], { encoding: "utf8", timeout: 5_000 });
    if (result.status === 0) return candidate;
  }
  return null;
}

function loadOrReportConfig(): AppConfig | null {
  try {
    loadDotEnv();
    const config = loadConfig();
    if (
      !config.simulation &&
      config.model.provider === "none" &&
      ![
        "doctor",
        "status",
        "tasks",
        "transactions",
        "verify",
        "budget",
        "export",
        "history",
        "logs",
        "approvals",
        "server",
        "frontend",
        "web",
      ].includes(process.argv[2] ?? "")
    ) {
      throw new AshError(
        "CONFIG_INVALID",
        "No model provider is configured. Set ASH_MODEL_PROVIDER and ASH_MODEL_* in .env, or run npm run demo to try Ash without setup.",
      );
    }
    return config;
  } catch (error) {
    const message = isAshError(error) ? error.message : errorMessage(error);
    if (process.argv.includes("--json")) throw error;
    process.stderr.write(`Ash configuration: ${redact(message)}\n`);
    return null;
  }
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode ?? 1);
      return;
    }
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.once("error", () => resolve(1));
  });
}

async function tailServerLog(config: AppConfig): Promise<string> {
  try {
    return redact((await readTailLines(path.join(config.dataDir, "logs", "server.log"), 12)).join("\n"));
  } catch {
    return "";
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printVersion(): void {
  const tui = findTuiBinary();
  process.stdout.write(`Ash ${VERSION}\nNode ${process.version}\nTUI ${tui ? "available" : "not built"}\n`);
}

export { API_TOKEN_ENV, API_URL_ENV };

/** Pass terminal/OS integration settings, never backend provider credentials. */
export function tuiEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed =
    /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USER|LOGNAME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|TERM|COLORTERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|WT_SESSION|WT_PROFILE_ID|LANG|LANGUAGE|LC_.*|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|XDG_CURRENT_DESKTOP|DBUS_SESSION_BUS_ADDRESS|BROWSER|PREFIX|ASH_ANIMATION|ASH_COLOR_MODE|ASH_UNICODE_MODE)$/i;
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key)));
}
