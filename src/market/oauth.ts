import fs, { constants } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { AshError } from "../errors.js";
import { atomicWriteJson, ensurePrivateDir, withFileLock } from "../util/fs.js";
import { registerSecret } from "../util/redact.js";

const tokenSchema = z.object({
  access_token: z.string().min(1).max(16000),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  refresh_token: z.string().min(1).max(16000).optional(),
  expires_in: z.number().int().positive().max(31536000),
  scope: z.string().max(1000).optional(),
});
const stateSchema = z
  .object({
    schema_version: z.literal(1),
    issuer: z.string(),
    resource: z.string(),
    client_id: z.string().min(1).max(1000),
    token_endpoint: z.string(),
    device_authorization_endpoint: z.string(),
    revocation_endpoint: z.string().optional(),
    tokens: tokenSchema.omit({ expires_in: true }).extend({ expires_at: z.number().finite().positive() }).optional(),
  })
  .strict();
type OAuthState = z.infer<typeof stateSchema>;
export interface DeviceChallenge {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_at: number;
  client_id: string;
}

function readState(file: string): OAuthState | null {
  let descriptor: number | undefined;
  try {
    const entry = fs.lstatSync(file);
    if (!entry.isFile()) throw new Error("Regular file required");
    descriptor = fs.openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.dev !== entry.dev ||
      stat.ino !== entry.ino ||
      stat.size > 64 * 1024 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      throw new Error("Private file required");
    const parsed = stateSchema.safeParse(JSON.parse(fs.readFileSync(descriptor, "utf8")));
    if (!parsed.success) throw new Error("Invalid state");
    if (parsed.data.tokens) {
      registerSecret(parsed.data.tokens.access_token);
      if (parsed.data.tokens.refresh_token) registerSecret(parsed.data.tokens.refresh_token);
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AshError("CONFIG_INVALID", "Marketplace OAuth state must be valid JSON in an owner-only regular file.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function oauthFile(config: AppConfig): string {
  return config.market.oauthFile ?? path.join(config.dataDir, "secrets", "market-oauth.json");
}

export function oauthConfigured(config: AppConfig): boolean {
  try {
    return Boolean(readState(oauthFile(config))?.tokens);
  } catch {
    return false;
  }
}

/** Device consent runs only in the operator terminal; tokens never enter public snapshots. */
export class MarketOAuth {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  constructor(
    private readonly config: AppConfig,
    options: {
      fetcher?: typeof fetch;
      now?: () => number;
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    } = {},
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      (async (ms, signal) => {
        await delay(ms, undefined, { signal });
      });
  }
  private endpoint(value: string): string {
    const origin = new URL(this.config.market.mcpUrl).origin;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new AshError("MARKET_PROTOCOL_ERROR", "OAuth endpoint is invalid.");
    }
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash)
      throw new AshError(
        "MARKET_PROTOCOL_ERROR",
        "OAuth endpoints must stay on the configured HTTPS marketplace origin.",
      );
    return url.toString();
  }
  private live() {
    if (this.config.simulation)
      throw new AshError("UNSAFE_OPERATION", "Marketplace OAuth is unavailable in demo mode.");
  }
  private state(): OAuthState | null {
    const state = readState(oauthFile(this.config));
    if (state) {
      for (const value of [
        state.issuer,
        state.resource,
        state.token_endpoint,
        state.device_authorization_endpoint,
        state.revocation_endpoint,
      ].filter((value): value is string => Boolean(value)))
        this.endpoint(value);
    }
    return state;
  }
  private async request(
    url: string,
    form?: Record<string, string>,
    json?: unknown,
    timeoutMs = this.config.market.timeoutMs,
  ): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const endpoint = this.endpoint(url);
    try {
      const response = await this.fetcher(endpoint, {
        method: form || json ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 30000))),
        headers: form
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : json
            ? { "Content-Type": "application/json" }
            : {},
        body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined,
      });
      if (!response.body) return { ok: response.ok, data: {} };
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 64 * 1024) throw new Error("Response too large");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const data = z.record(z.string(), z.unknown()).safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!data.success) throw new Error("Invalid JSON object");
      return { ok: response.ok, data: data.data };
    } catch {
      throw new AshError("MARKET_UNAVAILABLE", "Marketplace OAuth request failed or returned an invalid response.");
    }
  }
  async status() {
    const state = this.state();
    return {
      credential_present: Boolean(this.config.market.apiToken || state?.tokens),
      source: this.config.market.apiToken ? "configured-bearer" : state?.tokens ? "local-oauth" : "none",
      expires_at: state?.tokens ? new Date(state.tokens.expires_at).toISOString() : null,
      expired: state?.tokens ? state.tokens.expires_at <= this.now() : false,
      refresh_available: Boolean(state?.tokens?.refresh_token),
      note: "Credential presence does not verify buyer permissions or a marketplace operation.",
    };
  }
  async start(): Promise<DeviceChallenge> {
    this.live();
    if (this.config.market.apiToken)
      throw new AshError(
        "CONFIG_INVALID",
        "A manual marketplace bearer token is configured. Remove that setting before using managed OAuth.",
      );
    const file = oauthFile(this.config);
    await ensurePrivateDir(path.dirname(file));
    return withFileLock(`${file}.lock`, async () => {
      let state = this.state();
      if (!state) {
        const origin = new URL(this.config.market.mcpUrl).origin;
        const resource = await this.request(`${origin}/.well-known/oauth-protected-resource`);
        const discovery = z
          .object({ resource: z.string(), authorization_servers: z.array(z.string()).min(1) })
          .safeParse(resource.data);
        if (!resource.ok || !discovery.success)
          throw new AshError("MARKET_PROTOCOL_ERROR", "Marketplace OAuth resource discovery is unavailable.");
        const issuer = this.endpoint(discovery.data.authorization_servers[0]!);
        const metadata = await this.request(new URL("/.well-known/oauth-authorization-server", issuer).toString());
        const parsed = z
          .object({
            issuer: z.string(),
            registration_endpoint: z.string(),
            token_endpoint: z.string(),
            device_authorization_endpoint: z.string(),
            revocation_endpoint: z.string().optional(),
            grant_types_supported: z.array(z.string()),
            scopes_supported: z.array(z.string()),
          })
          .safeParse(metadata.data);
        if (
          !metadata.ok ||
          !parsed.success ||
          new URL(parsed.data.issuer).origin !== new URL(issuer).origin ||
          !parsed.data.grant_types_supported.includes("urn:ietf:params:oauth:grant-type:device_code") ||
          !["mcp", "profile", "hiring"].every((scope) => parsed.data.scopes_supported.includes(scope))
        )
          throw new AshError(
            "MARKET_PROTOCOL_ERROR",
            "Marketplace does not advertise the required buyer device OAuth flow.",
          );
        for (const endpoint of [
          parsed.data.registration_endpoint,
          parsed.data.token_endpoint,
          parsed.data.device_authorization_endpoint,
          parsed.data.revocation_endpoint,
          discovery.data.resource,
        ].filter((value): value is string => Boolean(value)))
          this.endpoint(endpoint);
        const registration = await this.request(parsed.data.registration_endpoint, undefined, {
          client_name: "Ash local operator",
          // Agent Market requires a redirect URI even for device-only clients.
          redirect_uris: ["http://127.0.0.1:8765/oauth/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
          response_types: ["code"],
        });
        const client = z
          .object({ client_id: z.string().min(1), token_endpoint_auth_method: z.literal("none").optional() })
          .safeParse(registration.data);
        if (!registration.ok || !client.success)
          throw new AshError("MARKET_AUTH_REQUIRED", "Marketplace public-client registration was refused.");
        state = {
          schema_version: 1,
          issuer: parsed.data.issuer,
          resource: discovery.data.resource,
          client_id: client.data.client_id,
          token_endpoint: parsed.data.token_endpoint,
          device_authorization_endpoint: parsed.data.device_authorization_endpoint,
          revocation_endpoint: parsed.data.revocation_endpoint,
        };
        await atomicWriteJson(file, state);
      }
      const response = await this.request(state.device_authorization_endpoint, {
        client_id: state.client_id,
        scope: "mcp profile hiring",
        resource: state.resource,
      });
      const device = z
        .object({
          device_code: z.string().min(1).max(16000),
          user_code: z.string().min(1).max(100),
          verification_uri: z.string(),
          expires_in: z.number().int().positive().max(3600),
          interval: z.number().int().positive().max(60).default(5),
        })
        .safeParse(response.data);
      if (!response.ok || !device.success)
        throw new AshError("MARKET_AUTH_REQUIRED", "Marketplace device authorization was refused.");
      this.endpoint(device.data.verification_uri);
      registerSecret(device.data.device_code);
      registerSecret(device.data.user_code);
      return { ...device.data, client_id: state.client_id, expires_at: this.now() + device.data.expires_in * 1000 };
    });
  }
  private tokens(input: unknown, previous?: OAuthState["tokens"]) {
    const parsed = tokenSchema.safeParse(input);
    if (!parsed.success)
      throw new AshError("MARKET_AUTH_REQUIRED", "Marketplace did not return a valid expiring bearer token.");
    const { expires_in, ...value } = parsed.data;
    const scopes = new Set((value.scope ?? previous?.scope ?? "mcp profile hiring").split(/\s+/));
    if (!["mcp", "hiring"].every((scope) => scopes.has(scope)))
      throw new AshError("MARKET_AUTH_REQUIRED", "Marketplace token lacks the requested buyer scopes.");
    registerSecret(value.access_token);
    if (value.refresh_token) registerSecret(value.refresh_token);
    return {
      ...value,
      refresh_token: value.refresh_token ?? previous?.refresh_token,
      scope: value.scope ?? previous?.scope,
      expires_at: this.now() + expires_in * 1000,
    };
  }
  async finish(challenge: DeviceChallenge, signal?: AbortSignal) {
    this.live();
    let interval = challenge.interval * 1000;
    for (;;) {
      if (this.now() + interval >= challenge.expires_at)
        throw new AshError("MARKET_AUTH_REQUIRED", "Marketplace device authorization expired; run market login again.");
      await this.sleep(interval, signal);
      const state = this.state();
      if (!state || state.client_id !== challenge.client_id)
        throw new AshError("MARKET_AUTH_REQUIRED", "Marketplace OAuth client changed during authorization.");
      const response = await this.request(
        state.token_endpoint,
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: challenge.device_code,
          client_id: state.client_id,
          resource: state.resource,
        },
        undefined,
        challenge.expires_at - this.now(),
      );
      if (this.now() >= challenge.expires_at)
        throw new AshError("MARKET_AUTH_REQUIRED", "Marketplace device authorization expired.");
      if (response.ok) {
        const tokens = this.tokens(response.data);
        const file = oauthFile(this.config);
        await withFileLock(`${file}.lock`, async () => {
          const current = this.state();
          if (!current || current.client_id !== state.client_id)
            throw new AshError("MARKET_AUTH_REQUIRED", "Marketplace OAuth client was removed during authorization.");
          await atomicWriteJson(file, { ...current, tokens });
        });
        return this.status();
      }
      if (response.data.error === "authorization_pending") continue;
      if (response.data.error === "slow_down") {
        interval += 5000;
        continue;
      }
      throw new AshError(
        "MARKET_AUTH_REQUIRED",
        response.data.error === "access_denied"
          ? "Marketplace consent was denied. Run market login again, sign into market.near.ai and approve Ash as yourself on its consent page."
          : "Marketplace device authorization failed; run market login again.",
      );
    }
  }
  async token(): Promise<string | null> {
    this.live();
    if (this.config.market.apiToken) return this.config.market.apiToken;
    const state = this.state();
    if (!state?.tokens) return null;
    if (state.tokens.expires_at > this.now() + 30000) return state.tokens.access_token;
    const file = oauthFile(this.config);
    return withFileLock(`${file}.lock`, async () => {
      const current = this.state();
      if (!current?.tokens) return null;
      if (current.tokens.expires_at > this.now() + 30000) return current.tokens.access_token;
      if (!current.tokens.refresh_token)
        throw new AshError("MARKET_AUTH_REQUIRED", "Marketplace token expired; run market login again.");
      const response = await this.request(current.token_endpoint, {
        grant_type: "refresh_token",
        refresh_token: current.tokens.refresh_token,
        client_id: current.client_id,
        resource: current.resource,
      });
      if (!response.ok) {
        if (response.data.error === "invalid_grant") {
          delete current.tokens;
          await atomicWriteJson(file, current);
        }
        throw new AshError("MARKET_AUTH_REQUIRED", "Marketplace token refresh was refused; run market login again.");
      }
      const tokens = this.tokens(response.data, current.tokens);
      await atomicWriteJson(file, { ...current, tokens });
      return tokens.access_token;
    });
  }
  async logout() {
    this.live();
    const file = oauthFile(this.config);
    await ensurePrivateDir(path.dirname(file));
    return withFileLock(`${file}.lock`, async () => {
      const state = this.state();
      let revoked = true;
      if (state?.tokens) {
        if (!state.revocation_endpoint) revoked = false;
        else
          for (const token of [state.tokens.refresh_token, state.tokens.access_token].filter((value): value is string =>
            Boolean(value),
          )) {
            try {
              const response = await this.request(state.revocation_endpoint, { token, client_id: state.client_id });
              revoked = revoked && response.ok;
            } catch {
              revoked = false;
            }
          }
      }
      await fsp.rm(file, { force: true });
      return {
        local_credentials_removed: true,
        provider_revocation_confirmed: revoked,
        manual_bearer_still_configured: Boolean(this.config.market.apiToken),
      };
    });
  }
}
