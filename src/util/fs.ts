import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { AshError } from "../errors.js";
import { canonicalJson } from "./json.js";

const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIR_MODE = 0o700;

export async function ensureDir(dir: string, mode = DEFAULT_DIR_MODE): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode });
}

/** Make a data directory private. Never used on user project directories. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await ensureDir(dir);
  try {
    await fs.chmod(dir, DEFAULT_DIR_MODE);
  } catch {
    // Some filesystems (notably FAT on Termux external storage) ignore modes.
  }
}

export async function readFileIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

export async function readJsonIfExists<T>(file: string): Promise<T | null> {
  const text = await readFileIfExists(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new AshError("STATE_INVALID", `Stored file ${file} is not valid JSON.`, { cause: error });
  }
}

/** Bounded backwards read for append-only logs; discard a partial first line. */
export async function readTailLines(file: string, count: number, maxBytes = 20 * 1024 * 1024): Promise<string[]> {
  const limit = Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 40;
  const handle = await fs.open(file, "r");
  try {
    let position = (await handle.stat()).size;
    let total = 0;
    let newlines = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && total < maxBytes && newlines <= limit) {
      const size = Math.min(position, 64 * 1024, maxBytes - total);
      position -= size;
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(chunk, 0, size, position);
      const bytes = chunk.subarray(0, bytesRead);
      for (const byte of bytes) if (byte === 10) newlines++;
      chunks.push(bytes);
      total += bytesRead;
      if (bytesRead < size) break;
    }
    const lines = Buffer.concat(chunks.reverse()).toString("utf8").trimEnd().split("\n");
    if (position > 0) lines.shift();
    return lines.filter(Boolean).slice(-limit);
  } finally {
    await handle.close();
  }
}

/**
 * Atomic write: same-directory temp file, fsync, rename, fsync directory.
 * A crash leaves either the old complete file or the new complete file.
 */
export async function atomicWriteFile(
  file: string,
  data: string,
  options: { mode?: number; exclusive?: boolean } = {},
): Promise<void> {
  const mode = options.mode ?? DEFAULT_FILE_MODE;
  const dir = path.dirname(file);
  await ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await fs.open(temp, "wx", mode);
  try {
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.exclusive) {
      // link(2) is an atomic create that refuses to replace an existing file.
      try {
        await fs.link(temp, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new AshError("CONFLICT", `Refusing to overwrite existing file ${path.basename(file)}.`);
        }
        throw error;
      }
      await fs.rm(temp, { force: true });
    } else {
      await fs.rename(temp, file);
    }
    await fsyncDir(dir);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteJson(
  file: string,
  value: unknown,
  options: { exclusive?: boolean; mode?: number } = {},
): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

async function fsyncDir(dir: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every platform (e.g. Windows).
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Resolve a relative path inside a root, rejecting absolute paths and any
 * traversal. Used for model-generated artifact names and downloaded files.
 */
export function resolveWithin(root: string, relative: string): string {
  const clean = relative.trim().replaceAll("\\", "/");
  if (!clean || clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || /[\x00-\x1f:]/.test(clean)) {
    throw new AshError("UNSAFE_INPUT", `Unsafe absolute path: ${relative}`);
  }
  const normalized = path.posix.normalize(clean);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    throw new AshError("UNSAFE_INPUT", `Unsafe path traversal: ${relative}`);
  }
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, normalized);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new AshError("UNSAFE_INPUT", `Path escapes the workspace: ${relative}`);
  }
  return target;
}

/** Check existing path components as well as lexical containment. The trusted
 * root may itself be a configured alias; artifacts beneath it may not be links. */
export async function resolveArtifactPath(root: string, relative: string): Promise<string> {
  const target = resolveWithin(root, relative);
  let current = path.resolve(root);
  for (const segment of path.relative(current, target).split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new AshError("UNSAFE_INPUT", "Artifact paths may not follow symbolic links.");
  }
  return target;
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

/**
 * Cross-process advisory lock using O_EXCL. Locks are short-lived; a stale
 * lock is removed only after the configured age and a confirmed dead local
 * owner. A slow live writer must never lose its lock. This protects the receipt
 * chain and ledger from concurrent CLI instances.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function acquireFileLock(lockPath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  await ensureDir(path.dirname(lockPath));
  const token = randomBytes(16).toString("hex");

  for (;;) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(
        canonicalJson({ pid: process.pid, token, created_at: new Date().toISOString(), host: hostname() }),
        "utf8",
      );
      break;
    } catch (error) {
      if (handle) await fs.rm(lockPath, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        if (await reclaimDeadLock(lockPath, staleMs)) continue;
      }
      if (Date.now() >= deadline) {
        throw new AshError("LOCK_TIMEOUT", "Another Ash process is writing to this task. Try again shortly.", {
          hint: `If no other Ash process is running, remove the stale lock: ${lockPath}`,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  return async () => {
    // A manually replaced lock belongs to its new owner, even on error paths.
    const owner = await readJsonIfExists<{ token?: string }>(lockPath).catch(() => null);
    if (owner?.token === token) await fs.rm(lockPath, { force: true }).catch(() => undefined);
  };
}

async function reclaimDeadLock(lockPath: string, staleMs: number): Promise<boolean> {
  // Serialize reclaimers, including the final recheck. Otherwise two processes
  // can observe the same dead owner and the second can delete the first's new lock.
  const reclaimPath = `${lockPath}.reclaim`;
  let guard: fs.FileHandle;
  try {
    guard = await fs.open(reclaimPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    const stat = await fs.stat(lockPath).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs <= staleMs) return false;
    const owner = await readJsonIfExists<{ pid?: number; host?: string }>(lockPath).catch(() => null);
    if (
      !owner ||
      !Number.isInteger(owner.pid) ||
      Number(owner.pid) <= 0 ||
      ![hostname(), process.env.HOSTNAME, "local"].includes(owner.host)
    )
      return false;
    try {
      process.kill(owner.pid!, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    await fs.rm(lockPath, { force: true });
    return true;
  } finally {
    await guard.close();
    await fs.rm(reclaimPath, { force: true });
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
