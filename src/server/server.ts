import { APP_VERSION } from "../version.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, SecureCookieMode } from "../config.js";
import { isLoopbackHost } from "../config.js";
import { createServices, type Services } from "../cli/services.js";
import { AshError, errorMessage, isAshError } from "../errors.js";
import { atomicWriteJson, readJsonIfExists } from "../util/fs.js";
import { nowIso } from "../util/time.js";
import { logger } from "../logger.js";
import { redact, registerSecret } from "../util/redact.js";
import { EventBus } from "./event-bus.js";
import { Readiness } from "./health.js";
import { FrontendServer } from "./frontend.js";
import { ensureFrontendBuild } from "./frontend-build.js";
import { AshService } from "./service.js";
import type { ServerEvent } from "./event-bus.js";
import { persistJourney, persistTrackRun, runJourney, runTrack } from "../journey/index.js";
import { TRACK_MODULE_LIST } from "../trackflows/index.js";
import { NEAR_PROVIDER_BOUNDARIES } from "../providers/near.js";
import {
  LoginLimiter,
  LoginTicket,
  WEB_COOKIE,
  WebSessionStore,
  clearSessionCookie,
  clientAddress,
  isSecureRequest,
  readCookie,
  safeEqual,
  sessionCookie,
} from "./auth.js";

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const SESSION_FILE = "server.json";
const AUTH_SCHEME = "bearer ";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

const WEB_ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/console": { file: "console.html", type: "text/html; charset=utf-8" },
  "/workspace": { file: "workspace.html", type: "text/html; charset=utf-8" },
  "/workspace/": { file: "workspace.html", type: "text/html; charset=utf-8" },
  "/workspace/controls": { file: "console.html", type: "text/html; charset=utf-8" },
  "/assets/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/assets/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

export interface ServerSession {
  schema_version: 1;
  pid: number;
  host: string;
  port: number;
  token: string;
  started_at: string;
  url: string;
  version: string;
  bind_host: string;
  remote: boolean;
  public_url: string;
  ui_url: string;
}

export interface StartServerOptions {
  config: AppConfig;
  host?: string;
  port?: number;
  token?: string | null;
  allowRemote?: boolean;
  publicUrl?: string | null;
  secureCookies?: SecureCookieMode;
  ui?: boolean;
  inlineFrontend?: boolean;
}

export interface RunningAshServer {
  server: Server;
  session: ServerSession;
  services: Services;
  bus: EventBus;
  service: AshService;
  close: () => Promise<void>;
}

export function sessionFile(dataDir: string): string {
  return path.join(dataDir, SESSION_FILE);
}

export async function readServerSession(dataDir: string): Promise<ServerSession | null> {
  const raw = await readJsonIfExists<ServerSession>(sessionFile(dataDir)).catch(() => null);
  if (!raw || raw.schema_version !== 1) return null;
  if (typeof raw.port !== "number" || typeof raw.token !== "string" || typeof raw.host !== "string") return null;
  if (typeof raw.url !== "string") return null;
  return {
    ...raw,
    bind_host: typeof raw.bind_host === "string" ? raw.bind_host : raw.host,
    remote: typeof raw.remote === "boolean" ? raw.remote : !isLoopbackHost(raw.host),
    public_url: typeof raw.public_url === "string" ? raw.public_url : raw.url,
    ui_url: typeof raw.ui_url === "string" ? raw.ui_url : `${raw.url}/`,
  };
}

export async function startAshServer(options: StartServerOptions): Promise<RunningAshServer> {
  const host = options.host ?? "127.0.0.1";
  const allowRemote = options.allowRemote ?? false;
  const remote = !isLoopbackHost(host);
  if (remote && !allowRemote) {
    throw new AshError(
      "CONFIG_INVALID",
      "The Ash API only binds a non-loopback address when ASH_SERVER_ALLOW_REMOTE=true is explicitly configured.",
    );
  }
  const configuredToken = options.token?.trim() || null;
  if (remote && !configuredToken) {
    throw new AshError("CONFIG_INVALID", "Remote API mode requires an explicit ASH_SERVER_TOKEN.");
  }
  const token = configuredToken || randomBytes(32).toString("base64url");
  if (token.length < 24) throw new AshError("CONFIG_INVALID", "The API session token must be at least 24 characters.");
  registerSecret(token);
  const secureCookies = options.secureCookies ?? "auto";
  const ui = options.ui ?? options.config.server.ui;
  if (ui && process.env.NODE_ENV === "production") await ensureFrontendBuild();
  const sessions = new WebSessionStore();
  const loginLimiter = new LoginLimiter();
  const loginTicket = new LoginTicket(options.config.server.codeTtlMinutes * 60_000);
  const configuredPublicUrl = options.publicUrl ? normalizePublicUrl(options.publicUrl) : null;

  if (remote && !configuredPublicUrl?.startsWith("https://") && !options.config.server.allowInsecureHttp)
    throw new AshError(
      "CONFIG_INVALID",
      "Public binding requires an HTTPS public URL and TLS proxy. Refusing public plain HTTP.",
    );
  if (remote && options.config.server.allowInsecureHttp)
    process.stderr.write(
      "WARNING: ASH_ALLOW_INSECURE_PUBLIC_HTTP is enabled. Codes and sessions can be intercepted without TLS.\n",
    );
  const startedAt = nowIso();
  const bus = new EventBus();
  const services = await createServices(options.config, (event) => {
    bus.publish({ type: "engine", event });
  });
  const service = new AshService(services, bus, startedAt, process.pid);
  await service.initialize();

  const sseClients = new Set<ServerResponse>();
  let closing: Promise<void> | null = null;
  const readiness = new Readiness(options.config.dataDir);
  const close = (): Promise<void> => {
    readiness.drain();
    sessions.revokeAll();
    loginTicket.revoke();
    if (closing) return closing;
    closing = (async () => {
      await removeSessionIfOwned(options.config.dataDir, token).catch(() => undefined);
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          // already closed
        }
      }
      sseClients.clear();
      await frontend.close();
      await services.engine.stop().catch(() => undefined);
      await services.market.disconnect().catch(() => undefined);
      await closeHttp(httpServer);
      await logger.audit("server.stopped", { host });
      logger.info("Ash API server stopped", { host });
      await logger.flush?.();
    })();
    return closing;
  };
  const shutdown = (): void => {
    void close().catch((error) => logger.error("API shutdown failed", { error: redact(errorMessage(error)) }));
  };

  const frontend = new FrontendServer(
    options.config.server.port,
    (req, res, clients, origin) => {
      void handleRequest(req, res, {
        config: options.config,
        token,
        service,
        bus,
        startedAt,
        shutdown,
        sseClients: clients,
        remote: false,
        secureCookies: "auto",
        ui: true,
        publicUrl: origin,
        sessions,
        loginLimiter,
        loginTicket,
        frontend,
        readiness,
      });
    },
    ensureFrontendBuild,
  );
  const httpServer = createServer((req, res) => {
    void handleRequest(req, res, {
      config: options.config,
      token,
      service,
      bus,
      startedAt,
      shutdown,
      sseClients,
      remote,
      secureCookies,
      ui,
      publicUrl: configuredPublicUrl ?? "",
      sessions,
      loginLimiter,
      loginTicket,
      frontend,
      readiness,
    });
  });
  httpServer.headersTimeout = 30_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;

  try {
    await listen(httpServer, host, options.port ?? 0);
  } catch (error) {
    await close();
    throw error;
  }
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeHttp(httpServer);
    throw new AshError("STATE_INVALID", "The API server did not return a TCP address.");
  }
  const port = address.port;
  const url = `http://${hostForUrl(connectHost(host))}:${port}`;
  const publicUrl = configuredPublicUrl ?? url;
  const uiUrl = `${publicUrl.replace(/\/+$/, "")}/`;
  if (remote || options.inlineFrontend || ui) frontend.attach(uiUrl, ui, port);
  const session: ServerSession = {
    schema_version: 1,
    pid: process.pid,
    host: connectHost(host),
    port,
    token,
    started_at: startedAt,
    url,
    version: APP_VERSION,
    bind_host: host,
    remote,
    public_url: publicUrl,
    ui_url: ui ? uiUrl : "",
  };
  try {
    await writeSession(options.config.dataDir, session);
  } catch (error) {
    await close();
    throw error;
  }

  await logger.audit("server.started", { host, port, pid: process.pid, remote, ui });
  logger.info("Ash API server started", { host, port, pid: process.pid, remote, ui });
  if (remote && options.publicUrl && new URL(publicUrl).protocol === "http:" && secureCookies !== "never") {
    logger.warn(
      "Remote UI is served over HTTP. Use TLS termination or set ASH_SERVER_SECURE_COOKIES=never only on a trusted network.",
    );
  }

  return { server: httpServer, session, services, bus, service, close };
}

interface RequestContext {
  config: AppConfig;
  token: string;
  service: AshService;
  bus: EventBus;
  startedAt: string;
  shutdown: () => void;
  sseClients: Set<ServerResponse>;
  remote: boolean;
  secureCookies: SecureCookieMode;
  ui: boolean;
  publicUrl: string;
  sessions: WebSessionStore;
  loginLimiter: LoginLimiter;
  loginTicket: LoginTicket;
  frontend: FrontendServer;
  readiness: Readiness;
}

interface AuthInfo {
  method: "bearer" | "cookie";
  expires_at: string | null;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
  const started = Date.now();
  const method = req.method ?? "GET";
  let pathname = "/";
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    pathname = url.pathname;
    if (!isAllowedOrigin(req, context.publicUrl)) {
      throw new AshError("UNSAFE_OPERATION", "This API only accepts same-origin or loopback browser requests.");
    }
    if ((method === "GET" || method === "HEAD") && (pathname === "/healthz" || pathname === "/readyz")) {
      const ok = pathname === "/healthz" || (await context.readiness.check());
      if (method === "HEAD") {
        res.writeHead(ok ? 200 : 503, { "Cache-Control": "no-store" });
        res.end();
      } else sendJson(res, ok ? 200 : 503, { ok, service: "ash" });
      return;
    }
    if (isWebPath(pathname)) {
      await serveWebAsset(
        method,
        pathname,
        req,
        res,
        (context.ui || context.frontend.status().running) && !context.frontend.suppressed,
      );
      return;
    }
    if (pathname === "/api/auth/login") {
      await handleLogin(method, req, res, context);
      return;
    }
    if (pathname === "/api/auth/session") {
      await handleSession(method, req, res, context);
      return;
    }
    if (pathname === "/api/auth/logout") {
      await handleLogout(method, req, res, context);
      return;
    }
    if (method === "GET" && pathname === "/api/tracks") {
      sendJson(res, 200, {
        tracks: TRACK_MODULE_LIST,
        providers: NEAR_PROVIDER_BOUNDARIES,
        mode: "LOCAL_SIMULATION",
        note: "All six modules run from deterministic fixtures. Live NEAR integrations require credentials and human approval.",
      });
      return;
    }
    const auth = authenticate(req, context);
    if (!auth) {
      throw new AshError("MARKET_AUTH_REQUIRED", "Missing or invalid Ash session token.");
    }
    await route(method, url, req, res, context, auth);
  } catch (error) {
    const ash = isAshError(error) ? error : new AshError("STATE_INVALID", errorMessage(error), { cause: error });
    if (!res.headersSent) sendError(res, ash);
    else res.end();
    if (ash.code !== "MARKET_AUTH_REQUIRED") {
      logger.warn("API request failed", { method, path: pathname, code: ash.code, status: statusFor(ash) });
    }
  } finally {
    logger.debug("API request", { method, path: pathname, status: res.statusCode, duration_ms: Date.now() - started });
  }
}

function isWebPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/console" ||
    pathname === "/workspace" ||
    pathname === "/workspace/" ||
    pathname === "/workspace/controls" ||
    pathname === "/index.html" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/assets/")
  );
}

function authenticate(req: IncomingMessage, context: RequestContext): AuthInfo | null {
  const header = req.headers.authorization;
  if (header) {
    if (!header.toLowerCase().startsWith(AUTH_SCHEME)) return null;
    const supplied = header.slice(AUTH_SCHEME.length).trim();
    return safeEqual(supplied, context.token) ? { method: "bearer", expires_at: null } : null;
  }
  const id = readCookie(req.headers.cookie, WEB_COOKIE);
  const session = context.sessions.get(id);
  if (!session) return null;
  if (!isSafeMethod(req.method) && req.headers["x-ash-client"] !== "web") {
    throw new AshError("UNSAFE_OPERATION", "Browser mutations require the X-Ash-Client: web header.");
  }
  return { method: "cookie", expires_at: new Date(session.expires_at).toISOString() };
}

function isSafeMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

async function handleLogin(
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  context: RequestContext,
): Promise<void> {
  requireMethod(method, "POST");
  if (context.frontend.suppressed || (!context.ui && !context.frontend.status().running))
    throw new AshError("UNSAFE_OPERATION", "Frontend is OFF. Run ash frontend on in the host terminal.");
  const address = clientAddress(req);
  if (!context.loginLimiter.allow(address)) {
    await logger.audit("auth.login.locked", { address });
    throw new AshError("RATE_LIMITED", "Too many sign-in attempts. Wait a minute and try again.");
  }
  const body = asRecord(await readJson(req));
  const token = optionalString(body, "token");
  const ticket = optionalString(body, "code") ?? optionalString(body, "ticket");
  if ((token && ticket) || (!token && !ticket)) {
    throw new AshError("VALIDATION_FAILED", 'Provide either "token" or "ticket", not both.');
  }
  let authenticated = false;
  if (token) authenticated = safeEqual(token, context.token) || context.loginTicket.consume(token);
  else if (ticket) authenticated = context.loginTicket.consume(ticket);
  if (!authenticated) {
    await logger.audit("auth.login.failed", { address });
    throw new AshError(
      "MARKET_AUTH_REQUIRED",
      "The access token or one-time code is invalid, expired or already used. Run ash frontend code for a fresh code.",
    );
  }
  context.loginLimiter.reset(address);
  // Create before yielding: frontend off/logout-all must also revoke an in-flight login.
  const session = context.sessions.create();
  await logger.audit("auth.login.succeeded", { address });
  res.setHeader("Set-Cookie", sessionCookie(session.id, secureCookiesFor(req, context)));
  sendJson(res, 200, {
    ok: true,
    method: "cookie",
    expires_at: new Date(session.expires_at).toISOString(),
    mode: context.config.simulation ? "SIMULATION" : "LIVE",
  });
}

async function handleSession(
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  context: RequestContext,
): Promise<void> {
  requireMethod(method, "GET");
  const auth = authenticate(req, context);
  sendJson(res, 200, {
    authenticated: Boolean(auth),
    method: auth?.method ?? null,
    expires_at: auth?.expires_at ?? null,
    mode: context.config.simulation ? "SIMULATION" : "LIVE",
  });
}

async function handleLogout(
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  context: RequestContext,
): Promise<void> {
  requireMethod(method, "POST");
  context.sessions.revoke(readCookie(req.headers.cookie, WEB_COOKIE));
  res.setHeader("Set-Cookie", clearSessionCookie(secureCookiesFor(req, context)));
  sendJson(res, 200, { ok: true });
}

function secureCookiesFor(req: IncomingMessage, context: RequestContext): boolean {
  if (context.publicUrl.startsWith("https://") || context.secureCookies === "always") return true;
  if (context.secureCookies === "never") return false;
  return isSecureRequest(req);
}

async function serveWebAsset(
  method: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  enabled: boolean,
): Promise<void> {
  if (!enabled) {
    sendText(res, 404, "Ash remote UI is disabled (ASH_SERVER_UI=false).");
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    sendText(res, 405, "Method not allowed.");
    return;
  }
  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  // Only public, built asset names are eligible; never expose arbitrary files.
  const extra = /^\/assets\/([\w-]+\.(?:js|css|woff2|svg))$/.exec(pathname)?.[1];
  const asset =
    WEB_ASSETS[pathname] ??
    (extra
      ? {
          file: `assets/${extra}`,
          type: extra.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : extra.endsWith(".css")
              ? "text/css; charset=utf-8"
              : extra.endsWith(".woff2")
                ? "font/woff2"
                : "image/svg+xml",
        }
      : undefined);
  if (!asset) {
    sendText(res, 404, "Not found.");
    return;
  }
  const encoding = acceptedAssetEncoding(req.headers["accept-encoding"]);
  const compressed = encoding ? await readWebAsset(`${asset.file}.${encoding === "br" ? "br" : "gz"}`) : null;
  const body = compressed ?? (await readWebAsset(asset.file));
  if (!body) {
    sendText(res, 503, "Ash remote UI assets are missing from this build.");
    return;
  }
  const headers: Record<string, string | number> = {
    "Content-Type": asset.type,
    "Cache-Control": /-[\w-]{8,}\.(?:js|css|woff2)$/.test(asset.file)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "Content-Length": body.byteLength,
    Vary: "Accept-Encoding",
  };
  if (compressed && encoding) headers["Content-Encoding"] = encoding;
  if (asset.type.startsWith("text/html")) {
    headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY;
    headers["Cache-Control"] = "no-store";
  }
  res.writeHead(200, headers);
  if (method === "HEAD") res.end();
  else res.end(body);
}

function acceptedAssetEncoding(header: string | undefined): "br" | "gzip" | null {
  const weights = new Map<string, number>();
  for (const part of (header ?? "").split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    const quality = parameters.map((value) => value.trim()).find((value) => value.startsWith("q="));
    const weight = quality ? Number(quality.slice(2)) : 1;
    weights.set(name ?? "", Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0);
  }
  const br = weights.get("br") ?? weights.get("*") ?? 0;
  const gz = weights.get("gzip") ?? weights.get("*") ?? 0;
  if (br > 0 && br >= gz) return "br";
  return gz > 0 ? "gzip" : null;
}

let webRoot: string | null | undefined;

async function readWebAsset(file: string): Promise<Buffer | null> {
  if (webRoot === undefined) {
    const candidates = [
      path.resolve(MODULE_DIR, "..", "web"),
      path.resolve(MODULE_DIR, "..", "..", "dist", "web"),
      path.resolve(MODULE_DIR, "..", "..", "web"),
      path.resolve(process.cwd(), "web"),
    ];
    webRoot = null;
    for (const candidate of candidates) {
      try {
        await fs.access(path.join(candidate, "index.html"));
        webRoot = candidate;
        break;
      } catch {
        // Try the next build layout.
      }
    }
  }
  if (!webRoot) return null;
  try {
    return await fs.readFile(path.join(webRoot, file));
  } catch {
    return null;
  }
}

async function route(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  context: RequestContext,
  auth: AuthInfo,
): Promise<void> {
  const pathname = url.pathname;
  if (
    [
      "/api/frontend",
      "/api/frontend/cycle",
      "/api/frontend/code",
      "/api/frontend/logout-all",
      "/api/auth/ticket",
    ].includes(pathname)
  ) {
    const peer = clientAddress(req).replace(/^::ffff:/, "");
    const host = new URL(`http://${req.headers.host ?? "invalid"}`).hostname;
    if (auth.method !== "bearer" || !isLoopbackHost(peer) || !isLoopbackHost(host) || req.headers["x-forwarded-for"])
      throw new AshError(
        "UNSAFE_OPERATION",
        "Frontend administration requires the local host terminal. SSH into the host and run ash frontend code.",
      );
    if (pathname === "/api/frontend" && method === "GET") {
      sendJson(res, 200, context.frontend.status());
      return;
    }
    return context.frontend.administer(async () => {
      requireMethod(method, "POST");
      if (pathname === "/api/frontend/logout-all") {
        context.sessions.revokeAll();
        context.loginTicket.revoke();
        for (const client of context.sseClients) client.end();
        sendJson(res, 200, { ok: true, ...context.frontend.status() });
        return;
      }
      let status = context.frontend.status();
      if (pathname === "/api/frontend/cycle") {
        if (status.next_action === "start") {
          status = await context.frontend.setRunning(true);
          await logger.audit("frontend.on", {});
          sendJson(res, 200, { ...status, code: null, expires_at: null });
          return;
        }
        if (status.next_action === "stop") status = await context.frontend.setRunning(false);
      }
      if (pathname === "/api/frontend") {
        const body = asRecord(await readJson(req));
        if (body.running !== undefined && typeof body.running !== "boolean")
          throw new AshError("VALIDATION_FAILED", "running must be a boolean.");
        status = await context.frontend.setRunning(body.running as boolean | undefined);
      } else if (!status.running && pathname !== "/api/frontend/cycle")
        throw new AshError("CONFLICT", "Frontend is OFF. Run ash frontend on first.");
      if (!status.running) {
        context.sessions.revokeAll();
        context.loginTicket.revoke();
        for (const client of context.sseClients) client.end();
        await logger.audit("frontend.off", {});
        sendJson(res, 200, { ...status, code: null, expires_at: null });
        return;
      }
      const issued = context.loginTicket.rotate();
      context.frontend.markCodeIssued();
      await logger.audit("frontend.code.issued", { expires_at: issued.expires_at });
      sendJson(res, 200, { ...context.frontend.status(), ...issued });
      return;
    });
  }
  if (method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "ash",
      version: APP_VERSION,
      pid: process.pid,
      started_at: context.startedAt,
      mode: context.config.simulation ? "SIMULATION" : "LIVE",
    });
    return;
  }
  if (method === "GET" && pathname === "/api/events") {
    await streamEvents(req, res, context.bus, context.sseClients, () => authenticate(req, context) !== null);
    return;
  }
  if (pathname === "/api/admin/shutdown") {
    if (method !== "POST") throw new AshError("VALIDATION_FAILED", "Method not allowed.");
    sendJson(res, 202, { ok: true, shutting_down: true });
    setTimeout(context.shutdown, 50).unref();
    return;
  }
  if (pathname === "/api/state" || pathname === "/api/dashboard") {
    requireMethod(method, "GET");
    sendJson(res, 200, await context.service.state());
    return;
  }
  if (pathname === "/api/tracks/verify") {
    if (!context.config.simulation)
      throw new AshError(
        "UNSAFE_OPERATION",
        "These track fixtures require demo mode. Live integrations never return simulated results.",
      );
    requireMethod(method, "POST");
    const body = asRecord(await readJson(req));
    const trackId = optionalString(body, "track_id");
    if (trackId) {
      const track = runTrack(trackId);
      await persistTrackRun(context.config.dataDir, track);
      sendJson(res, 200, { track });
      return;
    }
    const journey = runJourney();
    await persistJourney(context.config.dataDir, journey);
    sendJson(res, 200, journey);
    return;
  }
  if (pathname === "/api/chat") {
    if (method === "GET") {
      sendJson(res, 200, await context.service.chat.history(url.searchParams.get("task_id")));
      return;
    }
    requireMethod(method, "POST");
    sendJson(res, 200, await context.service.chat.send(await readJson(req)));
    return;
  }
  if (pathname === "/api/tasks") {
    if (method === "GET") {
      sendJson(res, 200, { tasks: await context.service.tasks() });
      return;
    }
    if (method === "POST") {
      const body = await readJson(req);
      const task = await context.service.createTask(body);
      sendJson(res, 201, { task });
      return;
    }
    throw new AshError("VALIDATION_FAILED", "Method not allowed.");
  }
  if (pathname === "/api/agents") {
    requireMethod(method, "GET");
    const query = url.searchParams.get("query")?.trim() ?? "";
    sendJson(res, 200, { agents: await context.service.agents(query) });
    return;
  }
  if (pathname === "/api/market") {
    requireMethod(method, "GET");
    sendJson(res, 200, await context.service.market());
    return;
  }
  if (pathname === "/api/jobs") {
    requireMethod(method, "GET");
    sendJson(res, 200, { jobs: await context.service.jobs() });
    return;
  }
  if (pathname === "/api/transactions") {
    requireMethod(method, "GET");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    sendJson(res, 200, await context.service.transactions(Number.isFinite(limit) ? limit : 100));
    return;
  }
  const receiptMatch = /^\/api\/receipts\/(Ash_\d{8}_\d{4}(?:_\d+)?\.json)$/.exec(pathname);
  if (receiptMatch?.[1]) {
    requireMethod(method, "GET");
    const receipt = await context.service.receipt(receiptMatch[1]);
    if (!receipt) throw new AshError("NOT_FOUND", "Receipt not found in the verified chain.");
    sendJson(res, 200, receipt);
    return;
  }
  if (pathname === "/api/security") {
    requireMethod(method, "GET");
    sendJson(res, 200, await context.service.security());
    return;
  }
  if (pathname === "/api/approvals") {
    requireMethod(method, "GET");
    const state = await context.service.state();
    sendJson(res, 200, { approvals: state.approvals, task_id: state.active_task_id });
    return;
  }
  if (pathname === "/api/settings") {
    requireMethod(method, "GET");
    sendJson(res, 200, await context.service.settings());
    return;
  }

  const taskMatch = /^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{1,63})(?:\/([a-z_]+))?$/.exec(pathname);
  if (taskMatch?.[1]) {
    const taskId = taskMatch[1];
    const action = taskMatch[2] ?? null;
    if (!action) {
      requireMethod(method, "GET");
      sendJson(res, 200, { task: await context.service.task(taskId) });
      return;
    }
    if (action === "timeline") {
      requireMethod(method, "GET");
      sendJson(res, 200, await context.service.timeline(taskId));
      return;
    }
    if (method !== "POST") throw new AshError("VALIDATION_FAILED", "Method not allowed.");
    if (action === "proof") {
      sendJson(res, 200, await context.service.exportProof(taskId));
      return;
    }
    if (action === "plan") {
      sendJson(res, 200, await context.service.planTask(taskId));
      return;
    }
    if (action === "approve") {
      const body = asRecord(await readJson(req));
      sendJson(
        res,
        200,
        await context.service.approve(taskId, requiredString(body, "approval_id"), requiredString(body, "phrase")),
      );
      return;
    }
    if (action === "deny") {
      const body = asRecord(await readJson(req));
      sendJson(
        res,
        200,
        await context.service.deny(taskId, requiredString(body, "approval_id"), requiredString(body, "phrase")),
      );
      return;
    }
    if (action === "budget") {
      const body = asRecord(await readJson(req));
      sendJson(res, 200, {
        approval: await context.service.requestBudget(
          taskId,
          requiredString(body, "amount"),
          optionalString(body, "currency") ?? undefined,
        ),
      });
      return;
    }
    if (action === "execute") {
      sendJson(res, 200, { task: await context.service.execute(taskId) });
      return;
    }
    if (action === "activate") {
      sendJson(res, 200, { task: await context.service.activateTask(taskId) });
      return;
    }
    if (action === "pause") {
      sendJson(res, 200, { task: await context.service.pause(taskId) });
      return;
    }
    if (action === "resume") {
      sendJson(res, 200, { task: await context.service.resume(taskId) });
      return;
    }
    if (action === "cancel") {
      const body = asRecord(await readJson(req));
      sendJson(res, 200, { task: await context.service.cancel(taskId, requiredString(body, "phrase")) });
      return;
    }
    if (action === "review") {
      const body = asRecord(await readJson(req));
      sendJson(res, 200, {
        task: await context.service.review(
          taskId,
          requiredString(body, "subtask_id"),
          requiredString(body, "decision"),
          requiredString(body, "phrase"),
          optionalString(body, "note") ?? undefined,
        ),
      });
      return;
    }
    if (action === "settings") {
      const body = asRecord(await readJson(req));
      sendJson(res, 200, {
        task: await context.service.updateSetting(
          taskId,
          requiredString(body, "key"),
          optionalString(body, "value") ?? "",
        ),
      });
      return;
    }
    throw new AshError("NOT_FOUND", `Unknown task action "${action}".`);
  }
  throw new AshError("NOT_FOUND", "API route not found.");
}

async function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  bus: EventBus,
  clients: Set<ServerResponse>,
  authorized: () => boolean,
): Promise<void> {
  if (clients.size >= 64) throw new AshError("RATE_LIMITED", "Too many event streams are open.");
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write('event: ready\ndata: {"ok":true}\n\n');
  clients.add(res);
  const send = (event: ServerEvent): void => {
    if (res.writableEnded) return;
    if (!authorized()) {
      res.end();
      return;
    }
    try {
      if (!res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) res.destroy();
    } catch {
      // The close handler will clean up a dead stream.
    }
  };
  const unsubscribe = bus.subscribe(send);
  const heartbeat = setInterval(() => {
    if (!authorized()) {
      res.end();
      return;
    }
    if (!res.writableEnded && !res.write(": heartbeat\n\n")) res.destroy();
  }, 15_000);
  heartbeat.unref();
  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    clients.delete(res);
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  await new Promise<void>((resolve) => {
    res.once("close", resolve);
    res.once("finish", resolve);
  });
}

function requireMethod(actual: string, expected: string): void {
  if (actual !== expected) throw new AshError("VALIDATION_FAILED", `Method ${actual} not allowed; use ${expected}.`);
}

function isAllowedOrigin(req: IncomingMessage, publicUrl: string): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.origin === publicUrl) return true;
    const host = new URL(`http://${req.headers.host ?? "invalid"}`);
    if (isLoopbackHost(url.hostname) && isLoopbackHost(host.hostname) && url.port === host.port) return true;
    return Boolean(req.headers.host && url.host.toLowerCase() === req.headers.host.toLowerCase());
  } catch {
    return false;
  }
}

function connectHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizePublicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new AshError("CONFIG_INVALID", "ASH_SERVER_PUBLIC_URL is not a valid URL.", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AshError("CONFIG_INVALID", "ASH_SERVER_PUBLIC_URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new AshError("CONFIG_INVALID", "ASH_SERVER_PUBLIC_URL must not embed credentials.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new AshError("CONFIG_INVALID", "ASH_SERVER_PUBLIC_URL must be an origin without a path.");
  }
  return url.origin;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new AshError("VALIDATION_FAILED", "Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AshError("VALIDATION_FAILED", "Request body must be valid JSON.", { cause: error });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AshError("VALIDATION_FAILED", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new AshError("VALIDATION_FAILED", `"${key}" is required.`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, error: AshError): void {
  sendJson(res, statusFor(error), {
    error: {
      code: error.code,
      message: redact(error.message),
      ...(error.hint ? { hint: redact(error.hint) } : {}),
    },
  });
}

function statusFor(error: AshError): number {
  switch (error.code) {
    case "VALIDATION_FAILED":
    case "UNSAFE_INPUT":
      return 400;
    case "MARKET_AUTH_REQUIRED":
      return 401;
    case "APPROVAL_REQUIRED":
    case "APPROVAL_INVALID":
    case "UNSAFE_OPERATION":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "BUDGET_EXCEEDED":
    case "BUDGET_INVARIANT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "MARKET_UNAVAILABLE":
    case "MODEL_UNAVAILABLE":
    case "MODEL_RESPONSE_INVALID":
      return 503;
    default:
      return 500;
  }
}

async function writeSession(dataDir: string, session: ServerSession): Promise<void> {
  await atomicWriteJson(sessionFile(dataDir), session, { mode: 0o600 });
}

async function removeSessionIfOwned(dataDir: string, token: string): Promise<void> {
  const current = await readServerSession(dataDir);
  if (current?.token === token) {
    await fs.rm(sessionFile(dataDir), { force: true });
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeHttp(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
