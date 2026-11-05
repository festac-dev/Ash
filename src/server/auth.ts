import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const WEB_COOKIE = "ash_web";
export const WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const LOGIN_TICKET_TTL_MS = 5 * 60 * 1_000;
const MAX_WEB_SESSIONS = 64;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_ATTEMPTS = 8;

export interface WebSessionRecord {
  id: string;
  created_at: number;
  expires_at: number;
}

/**
 * Browser sessions are random opaque ids held in memory. The API bearer token
 * is never stored in the cookie; it is exchanged once at login.
 */
export class WebSessionStore {
  private readonly sessions = new Map<string, WebSessionRecord>();

  create(now = Date.now()): WebSessionRecord {
    this.prune(now);
    if (this.sessions.size >= MAX_WEB_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.created_at - b.created_at)[0];
      if (oldest) this.sessions.delete(oldest.id);
    }
    const record: WebSessionRecord = {
      id: randomBytes(32).toString("base64url"),
      created_at: now,
      expires_at: now + WEB_SESSION_TTL_MS,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  get(id: string | null, now = Date.now()): WebSessionRecord | null {
    if (!id) return null;
    const record = this.sessions.get(id);
    if (!record) return null;
    if (record.expires_at <= now) {
      this.sessions.delete(id);
      return null;
    }
    return record;
  }

  revokeAll(): void {
    this.sessions.clear();
  }

  revoke(id: string | null): void {
    if (id) this.sessions.delete(id);
  }

  prune(now = Date.now()): void {
    for (const [id, record] of this.sessions) {
      if (record.expires_at <= now) this.sessions.delete(id);
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** A 64-bit random code; only its SHA-256 digest and expiry remain in memory. */
export class LoginTicket {
  private digest: Buffer | null = null;
  private expiresAt = 0;
  constructor(private readonly ttlMs = LOGIN_TICKET_TTL_MS) {}

  rotate(now = Date.now()): { code: string; expires_at: string } {
    const code = randomBytes(8).toString("hex").toUpperCase().match(/.{4}/g)!.join("-");
    this.digest = this.hash(code);
    this.expiresAt = now + this.ttlMs;
    return { code, expires_at: new Date(this.expiresAt).toISOString() };
  }
  revoke(): void {
    this.digest = null;
    this.expiresAt = 0;
  }
  consume(candidate: string, now = Date.now()): boolean {
    const supplied = this.hash(candidate);
    const expected = this.digest ?? Buffer.alloc(32);
    const matches = timingSafeEqual(supplied, expected);
    if (!this.digest || now >= this.expiresAt || !matches) return false;
    this.revoke();
    return true;
  }
  private hash(code: string): Buffer {
    return createHash("sha256").update(code.replace(/[-\s]/g, "").toUpperCase()).digest();
  }
}

/** Small in-memory limiter for the unauthenticated login route. */
export class LoginLimiter {
  private readonly hits = new Map<string, number[]>();

  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_ATTEMPTS) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 512) {
      const oldest = [...this.hits.entries()].sort((a, b) => (a[1][0] ?? 0) - (b[1][0] ?? 0))[0];
      if (oldest) this.hits.delete(oldest[0]);
    }
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function sessionCookie(id: string, secure: boolean): string {
  const maxAge = Math.floor(WEB_SESSION_TTL_MS / 1_000);
  return `${WEB_COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${WEB_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  const forwarded = req.headers["x-forwarded-proto"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]?.trim().toLowerCase() === "https";
  }
  return false;
}

export function clientAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}
