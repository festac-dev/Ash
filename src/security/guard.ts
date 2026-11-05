import { promises as dns } from "node:dns";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AshError } from "../errors.js";
import { atomicWriteFile, resolveArtifactPath } from "../util/fs.js";
import { sanitizeUntrustedText } from "../util/strings.js";
import { sha256Hex } from "../util/json.js";
import { nowIso } from "../util/time.js";

/** Buyer tools exposed by the NEAR Agent Market MCP server (current + legacy). */
const ALLOWED_BASE_TOOLS = new Set([
  "whoami",
  "browse_agents",
  "get_agent",
  "prepare_job",
  "get_draft_status",
  "create_job",
  "post_job",
  "edit_job",
  "delete_job",
  "list_my_jobs",
  "get_job",
  "list_bids",
  "list_my_connections",
  "read_job_thread",
  "message_worker",
  "award_bid",
  "cancel_job",
  "wait_for_job",
  "get_job_status",
  "get_job_result",
  "accept_result",
  "request_changes",
  "review_agent",
  "reserve_attachment",
  "get_file",
]);

const FORBIDDEN_PATTERN =
  /(withdraw|transfer|payout|top[_ -]?up|deposit|bank|wallet|private[_ -]?key|seed[_ -]?phrase|address[_ -]?book|refund[_ -]?out)/i;

const LEGACY_ALIASES: Record<string, string> = {
  send_message: "message_worker",
  read_messages: "read_job_thread",
};

export function normalizeMarketToolName(rawName: string): string {
  const afterPrefix = rawName.includes("__") ? rawName.slice(rawName.lastIndexOf("__") + 2) : rawName;
  let base = afterPrefix.trim().toLowerCase();
  if (base.startsWith("market_")) base = base.slice("market_".length);
  base = LEGACY_ALIASES[base] ?? base;
  return base;
}

/**
 * Strict tool allowlist. Unknown tools and anything that smells like a money
 * movement or key operation are refused even if a future server advertises
 * them. Ash is a buyer, not a wallet.
 */
export function assertMarketToolAllowed(rawName: string): string {
  const base = normalizeMarketToolName(rawName);
  if (FORBIDDEN_PATTERN.test(base)) {
    throw new AshError(
      "UNSAFE_OPERATION",
      `Marketplace tool "${rawName}" is a wallet/funds operation. Ash never calls it.`,
    );
  }
  if (!ALLOWED_BASE_TOOLS.has(base)) {
    throw new AshError(
      "UNSAFE_OPERATION",
      `Marketplace tool "${rawName}" is not in Ash's buyer allowlist. Refusing to call it.`,
    );
  }
  return base;
}

export function assertSpendToolAllowed(base: string, mode: "standard" | "pro", allowInCallSpend: boolean): void {
  if (base === "create_job" && (mode !== "pro" || !allowInCallSpend)) {
    throw new AshError(
      "UNSAFE_OPERATION",
      "create_job charges inside the tool call. Enable pro mode and ASH_ALLOW_IN_CALL_SPEND only with explicit approval.",
    );
  }
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  outputLimitExceeded: boolean;
}

/**
 * Run an explicitly allowlisted verification command inside a task workspace.
 * The child gets a minimal environment, a hard timeout, a process group kill,
 * and capped output. It never receives model or market credentials.
 */
export async function runAllowlistedCommand(options: {
  command: string;
  cwd: string;
  timeoutMs: number;
  allowedCommands: readonly string[];
  maxOutputBytes?: number;
}): Promise<CommandResult> {
  const { command, cwd, timeoutMs, allowedCommands } = options;
  if (!allowedCommands.includes(command)) {
    throw new AshError(
      "UNSAFE_OPERATION",
      "This verification command is not in ASH_VERIFY_COMMANDS. Refusing to execute it.",
    );
  }
  if (command.includes("\u0000") || command.length > 500) {
    throw new AshError("UNSAFE_OPERATION", "Verification command contains unsafe characters.");
  }
  const resolvedCwd = path.resolve(cwd);
  const stat = await fs.stat(resolvedCwd).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new AshError("VALIDATION_FAILED", "Verification working directory does not exist.");
  }

  const maxOutput = options.maxOutputBytes ?? 512 * 1024;
  const started = Date.now();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: resolvedCwd,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1",
    ASH_VERIFICATION: "1",
  };

  const isWindows = process.platform === "win32";
  const child = isWindows
    ? spawn("cmd.exe", ["/d", "/s", "/c", command], { cwd: resolvedCwd, env, shell: false, windowsHide: true })
    : spawn("/bin/sh", ["-c", command], { cwd: resolvedCwd, env, shell: false, detached: true });

  let stdout = "";
  let stderr = "";
  let outputLimitExceeded = false;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | null = null;
  let forceKillTimer: NodeJS.Timeout | null = null;

  const killTree = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      if (isWindows) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", () => child.kill(signal));
      } else process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };

  const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
    const current = target === "stdout" ? stdout : stderr;
    if (Buffer.byteLength(current) + chunk.byteLength > maxOutput) {
      outputLimitExceeded = true;
      killTree("SIGKILL");
      return;
    }
    if (target === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };

  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

  killTimer = setTimeout(
    () => {
      timedOut = true;
      killTree("SIGTERM");
      forceKillTimer = setTimeout(() => killTree("SIGKILL"), 2_000);
      forceKillTimer.unref();
    },
    Math.max(1_000, Math.min(timeoutMs, 600_000)),
  );

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", () => resolve({ code: null, signal: null }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (killTimer) clearTimeout(killTimer);
  if (forceKillTimer) clearTimeout(forceKillTimer);

  return {
    exitCode: timedOut ? null : exit.code,
    stdout: sanitizeUntrustedText(stdout, maxOutput),
    stderr: sanitizeUntrustedText(stderr, maxOutput),
    timedOut,
    durationMs: Date.now() - started,
    outputLimitExceeded,
  };
}

const FORBIDDEN_ARTIFACT_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".bat",
  ".cmd",
  ".com",
  ".msi",
  ".jar",
  ".apk",
  ".app",
  ".scr",
  ".pif",
  ".ps1",
]);

export interface GeneratedFile {
  path: string;
  content: string;
}

/**
 * Write model-generated artifacts inside a task workspace only. These are
 * inert text files: Ash never executes them automatically.
 */
export async function writeGeneratedArtifacts(
  workspace: string,
  files: GeneratedFile[],
  limits: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number } = {},
): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const maxFiles = limits.maxFiles ?? 50;
  const maxFileBytes = limits.maxFileBytes ?? 200 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 2 * 1024 * 1024;
  if (files.length > maxFiles) {
    throw new AshError("UNSAFE_INPUT", `A DIY deliverable may contain at most ${maxFiles} files.`);
  }
  let total = 0;
  const written: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const file of files) {
    const target = await resolveArtifactPath(workspace, file.path);
    const basename = path.basename(target);
    const ext = path.extname(basename).toLowerCase();
    if (FORBIDDEN_ARTIFACT_EXTENSIONS.has(ext)) {
      throw new AshError("UNSAFE_INPUT", `Refusing to write executable artifact type "${ext}".`);
    }
    if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
      throw new AshError("UNSAFE_INPUT", "Refusing to write environment/secret files from a model.");
    }
    if (
      file.path
        .replaceAll("\\", "/")
        .split("/")
        .some((segment) => segment.toLowerCase() === ".git" || segment === ".." || segment === ".")
    ) {
      throw new AshError("UNSAFE_INPUT", "Refusing to write inside a .git directory or via path traversal.");
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > maxFileBytes) {
      throw new AshError("UNSAFE_INPUT", `Artifact ${file.path} exceeds the ${maxFileBytes} byte limit.`);
    }
    total += bytes;
    if (total > maxTotalBytes) {
      throw new AshError("UNSAFE_INPUT", `Artifacts exceed the ${maxTotalBytes} byte total limit.`);
    }
    const safeContent = sanitizeUntrustedText(file.content, maxFileBytes);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await atomicWriteFile(target, safeContent, { mode: 0o600 });
    written.push({
      path: path.relative(workspace, target),
      bytes: Buffer.byteLength(safeContent, "utf8"),
      sha256: sha256Hex(safeContent),
    });
  }
  return written;
}

export interface ExternalFetchResult {
  url: string;
  status: number;
  contentType: string | null;
  text: string;
  bytes: number;
  truncated: boolean;
  fetchedAt: string;
}

/**
 * Fetch an HTTPS deliverable link with SSRF protections: credentials denied,
 * DNS answers checked and pinned to the connection address, redirects revalidated,
 * response size and time capped, and no authentication headers forwarded.
 */
export async function safeFetchDeliverable(
  rawUrl: string,
  maxBytes = 2 * 1024 * 1024,
  timeoutMs = 25_000,
): Promise<ExternalFetchResult> {
  let current = parseSafeHttpsUrl(rawUrl);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new AshError("VALIDATION_FAILED", "Deliverable timeout must be positive and finite.");
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new AshError("VERIFICATION_FAILED", "External deliverable download timed out.")),
    Math.min(timeoutMs, 25_000),
  );
  try {
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      // DNS, every redirect and streaming body share one non-resetting deadline.
      const pinned = await resolveDeliverableHost(current.hostname, deadline.signal);
      deadline.signal.throwIfAborted();
      const response = await httpsGet(current, pinned, 20_000, maxBytes, deadline.signal);
      if (response.status >= 300 && response.status < 400) {
        if (!response.location)
          throw new AshError("VERIFICATION_FAILED", "External deliverable returned a redirect without a location.");
        current = parseSafeHttpsUrl(new URL(response.location, current).toString());
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        throw new AshError("VERIFICATION_FAILED", `External deliverable returned HTTP ${response.status}.`);
      if (response.contentType && !/^(text\/|application\/(json|xml|markdown|x-yaml|yaml))/i.test(response.contentType))
        throw new AshError(
          "VERIFICATION_FAILED",
          `External deliverable content type ${response.contentType} is not reviewable text.`,
        );
      return {
        url: current.toString(),
        status: response.status,
        contentType: response.contentType,
        text: sanitizeUntrustedText(response.body.toString("utf8"), maxBytes),
        bytes: response.body.byteLength,
        truncated: response.truncated,
        fetchedAt: nowIso(),
      };
    }
    throw new AshError("VERIFICATION_FAILED", "External deliverable redirected too many times.");
  } catch (error) {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveDeliverableHost(hostname: string, signal: AbortSignal): Promise<PinnedAddress> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  try {
    // Node's OS DNS lookup cannot be cancelled; ignore late results and never open
    // a connection after the caller's deadline. Always remove the abort listener.
    return await Promise.race([
      assertPublicHost(hostname),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

interface PinnedAddress {
  address: string;
  family: number;
}

interface PinnedResponse {
  status: number;
  contentType: string | null;
  location: string | null;
  body: Buffer;
  truncated: boolean;
}

function httpsGet(
  url: URL,
  pinned: PinnedAddress,
  timeoutMs: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: PinnedResponse | Error): void => {
      if (settled) return;
      settled = true;
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const request = https.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "text/plain, text/markdown, application/json, text/html;q=0.8",
          "User-Agent": "AshAI/1.0 deliverable-verifier",
        },
        timeout: timeoutMs,
        signal,
        // Pin the already-validated address. Node uses this callback instead
        // of performing its own DNS lookup for the connection.
        lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
          else callback(null, pinned.address, pinned.family);
        }) as never,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentTypeHeader = response.headers["content-type"];
        const contentType = Array.isArray(contentTypeHeader)
          ? (contentTypeHeader[0] ?? null)
          : (contentTypeHeader ?? null);
        const locationHeader = response.headers.location;
        const location = Array.isArray(locationHeader) ? (locationHeader[0] ?? null) : (locationHeader ?? null);
        if (status >= 300 && status < 400) {
          response.destroy();
          finish({ status, contentType, location, body: Buffer.alloc(0), truncated: false });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        response.on("data", (chunk: Buffer) => {
          if (truncated) return;
          total += chunk.byteLength;
          if (total > maxBytes) {
            truncated = true;
            response.destroy();
            finish({ status, contentType, location, body: Buffer.concat(chunks), truncated: true });
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => finish({ status, contentType, location, body: Buffer.concat(chunks), truncated }));
        response.on("error", (error) => {
          if (truncated) finish({ status, contentType, location, body: Buffer.concat(chunks), truncated: true });
          else finish(error instanceof Error ? error : new Error(String(error)));
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("External deliverable request timed out.")));
    request.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    request.end();
  });
}

function parseSafeHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new AshError("UNSAFE_INPUT", "Deliverable URL is not valid.", { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new AshError("UNSAFE_INPUT", "External deliverables must use https.");
  }
  if (url.username || url.password) {
    throw new AshError("UNSAFE_INPUT", "Deliverable URLs must not embed credentials.");
  }
  return url;
}

async function assertPublicHost(hostname: string): Promise<PinnedAddress> {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new AshError("UNSAFE_INPUT", "Refusing to fetch a localhost deliverable (SSRF protection).");
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new AshError("VERIFICATION_FAILED", `Could not resolve deliverable host: ${hostname}`, { cause: error });
  }
  if (addresses.length === 0) throw new AshError("VERIFICATION_FAILED", "Deliverable host did not resolve.");
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new AshError("UNSAFE_INPUT", "Deliverable host resolves to a private or reserved address.");
    }
  }
  const first = addresses[0];
  if (!first) throw new AshError("VERIFICATION_FAILED", "Deliverable host did not resolve.");
  return first;
}

const privateAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  privateAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  privateAddresses.addSubnet(network, prefix, "ipv6");

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  // BlockList also handles expanded IPv6 and hexadecimal IPv4-mapped forms.
  return family === 0 || privateAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}
