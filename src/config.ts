import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AshError } from "./errors.js";
import { registerSecret } from "./util/redact.js";

export type ModelProvider = "openai-compatible" | "ollama" | "demo" | "none";
export type MarketMode = "standard" | "pro";
export type HiringMode = "direct" | "board";
export type ColorMode = "auto" | "always" | "never";
export type UnicodeMode = "auto" | "always" | "never";
export type LogLevelName = "debug" | "info" | "warn" | "error";
export type SecureCookieMode = "auto" | "always" | "never";

export interface ModelConfig {
  provider: ModelProvider;
  name: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  timeoutMs: number;
  jsonMode: boolean;
}

export interface MarketConfig {
  mcpUrl: string;
  apiToken: string | null;
  mode: MarketMode;
  allowInCallSpend: boolean;
  timeoutMs: number;
  maxRetries: number;
  rateLimitPerMinute: number;
  hiringMode: HiringMode;
}

export interface PolicyConfig {
  maxParallelJobs: number;
  maxRetries: number;
  contingencyRatio: number;
  maxCounterOffersPerVendor: number;
  maxRevisionRounds: number;
  approvalTtlMinutes: number;
  maxAgentCandidates: number;
  maxDeliverableBytes: number;
  allowedVerifyCommands: string[];
}

export interface TelegramConfig {
  botToken: string | null;
  chatId: string | null;
  timeoutMs: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  token: string | null;
  allowRemote: boolean;
  publicUrl: string | null;
  secureCookies: SecureCookieMode;
  ui: boolean;
  codeTtlMinutes: number;
  allowInsecureHttp: boolean;
}

export interface AppConfig {
  simulation: boolean;
  dataDir: string;
  logLevel: LogLevelName;
  colorMode: ColorMode;
  unicodeMode: UnicodeMode;
  animation: boolean;
  model: ModelConfig;
  market: MarketConfig;
  policy: PolicyConfig;
  telegram: TelegramConfig;
  server: ServerConfig;
}

const DEFAULT_MCP_URL = "https://market.near.ai/mcp";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/v1";

/**
 * Load a local .env without overriding variables the shell already set.
 * Secrets stay in the environment; the file is never printed or logged.
 */
export function loadDotEnv(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  const file = path.resolve(cwd, env.ASH_ENV_FILE?.trim() || ".env");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[match[1]] === undefined) env[match[1]] = value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const simulation = env.ASH_DEMO === "1" || envBool(env, "ASH_SIMULATE", false);
  if (simulation && env.NODE_ENV === "production")
    throw new AshError("CONFIG_INVALID", "Simulation is disabled when NODE_ENV=production.");
  if (simulation && env.ASH_DEMO !== "1")
    throw new AshError(
      "CONFIG_INVALID",
      "ASH_SIMULATE alone is no longer supported. Run npm run demo or explicitly set ASH_DEMO=1.",
    );

  const providerRaw = (env.ASH_MODEL_PROVIDER ?? "none").trim().toLowerCase();
  if (!["openai-compatible", "ollama", "demo", "none"].includes(providerRaw)) {
    throw new AshError(
      "CONFIG_INVALID",
      `ASH_MODEL_PROVIDER must be one of openai-compatible, ollama, demo, none (got "${providerRaw}").`,
    );
  }
  let provider = providerRaw as ModelProvider;
  if (provider === "demo" && !simulation) {
    throw new AshError(
      "CONFIG_INVALID",
      "ASH_MODEL_PROVIDER=demo requires ASH_DEMO=1. Run npm run demo to try Ash without setup. Production planning requires a real model.",
    );
  }
  if (provider === "none" && simulation) {
    provider = "demo";
  }

  const modelName = optionalString(env.ASH_MODEL_NAME);
  const modelBase = optionalString(env.ASH_MODEL_BASE_URL);
  const modelKey = resolveSecret(env, "ASH_MODEL_API_KEY", "ASH_MODEL_API_KEY_FILE");
  if (provider === "openai-compatible" || provider === "ollama") {
    if (!modelName) {
      throw new AshError("CONFIG_INVALID", "ASH_MODEL_NAME is required when a model provider is configured.");
    }
  }
  let baseUrl: string | null = null;
  if (provider === "openai-compatible") {
    if (!modelBase) {
      throw new AshError("CONFIG_INVALID", "ASH_MODEL_BASE_URL is required for openai-compatible providers.");
    }
    baseUrl = validateHttpUrl(modelBase, "ASH_MODEL_BASE_URL");
  } else if (provider === "ollama") {
    baseUrl = validateHttpUrl(modelBase ?? DEFAULT_OLLAMA_URL, "ASH_MODEL_BASE_URL");
  }
  if (modelKey) registerSecret(modelKey);

  const marketToken = resolveSecret(env, "MARKET_API_TOKEN", "MARKET_API_TOKEN_FILE");
  if (marketToken) registerSecret(marketToken);

  const telegramBotToken = optionalString(env.TELEGRAM_BOT_TOKEN);
  if (telegramBotToken) registerSecret(telegramBotToken);
  const telegramChatId = optionalString(env.TELEGRAM_CHAT_ID);

  const marketUrl = validateHttpUrl(env.MARKET_MCP_URL?.trim() || DEFAULT_MCP_URL, "MARKET_MCP_URL");
  const marketMode = (env.ASH_MARKET_MODE ?? "standard").trim().toLowerCase();
  if (marketMode !== "standard" && marketMode !== "pro") {
    throw new AshError("CONFIG_INVALID", 'ASH_MARKET_MODE must be "standard" or "pro".');
  }
  const allowInCallSpend = envBool(env, "ASH_ALLOW_IN_CALL_SPEND", false);
  if (marketMode === "pro" && !allowInCallSpend) {
    throw new AshError(
      "CONFIG_INVALID",
      "ASH_MARKET_MODE=pro requires the legacy ASH_ALLOW_IN_CALL_SPEND=true opt-in. Unbounded charges remain disabled; use standard mode.",
    );
  }

  const hiringMode = (env.ASH_HIRING_MODE ?? "direct").trim().toLowerCase();
  if (hiringMode !== "direct" && hiringMode !== "board") {
    throw new AshError("CONFIG_INVALID", 'ASH_HIRING_MODE must be "direct" or "board".');
  }

  const dataDirRaw = env.ASH_DATA_DIR?.trim() || path.join(cwd, ".ash-data");
  const dataDir = path.resolve(cwd, expandHome(dataDirRaw));
  if (dataDir === path.parse(dataDir).root) {
    throw new AshError("CONFIG_INVALID", "ASH_DATA_DIR must not be the filesystem root.");
  }

  const colorMode = (env.ASH_COLOR_MODE ?? "auto").trim().toLowerCase();
  if (!["auto", "always", "never"].includes(colorMode)) {
    throw new AshError("CONFIG_INVALID", 'ASH_COLOR_MODE must be "auto", "always" or "never".');
  }
  const unicodeMode = (env.ASH_UNICODE_MODE ?? "auto").trim().toLowerCase();
  if (!["auto", "always", "never"].includes(unicodeMode)) {
    throw new AshError("CONFIG_INVALID", 'ASH_UNICODE_MODE must be "auto", "always" or "never".');
  }

  const logLevel = (env.ASH_LOG_LEVEL ?? "info").trim().toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new AshError("CONFIG_INVALID", 'ASH_LOG_LEVEL must be "debug", "info", "warn" or "error".');
  }

  const allowedVerifyCommands = parseCommandList(env.ASH_VERIFY_COMMANDS);

  const serverHost = (env.ASH_BIND_HOST?.trim() || env.ASH_SERVER_HOST || "127.0.0.1").trim();
  if (!serverHost || /[\s/]/.test(serverHost)) {
    throw new AshError("CONFIG_INVALID", "ASH_SERVER_HOST must be a hostname or IP address without a port or path.");
  }
  const serverAllowRemote = envBool(env, "ASH_SERVER_ALLOW_REMOTE", false);
  const serverRemote = !isLoopbackHost(serverHost);
  const serverToken = optionalString(env.ASH_SERVER_TOKEN);
  if (serverToken) registerSecret(serverToken);
  if (serverRemote && !serverAllowRemote) {
    throw new AshError(
      "CONFIG_INVALID",
      "ASH_SERVER_HOST is not loopback. Set ASH_SERVER_ALLOW_REMOTE=true only for a reviewed remote deployment.",
    );
  }
  if (serverRemote && !serverToken) {
    throw new AshError(
      "CONFIG_INVALID",
      "Remote API mode requires an explicit ASH_SERVER_TOKEN of at least 24 characters.",
    );
  }
  if (serverToken && serverToken.length < 24) {
    throw new AshError("CONFIG_INVALID", "ASH_SERVER_TOKEN must be at least 24 characters.");
  }
  const serverPort = envInt(
    { ...env, ASH_SERVER_PORT: env.ASH_SERVER_PORT || env.PORT },
    "ASH_SERVER_PORT",
    5050,
    0,
    65_535,
  );
  const serverPublicUrl = optionalString(env.ASH_PUBLIC_URL) || optionalString(env.ASH_SERVER_PUBLIC_URL);
  const allowInsecureHttp = envBool(env, "ASH_ALLOW_INSECURE_PUBLIC_HTTP", false);
  if (serverRemote && !serverPublicUrl?.startsWith("https://") && !allowInsecureHttp)
    throw new AshError(
      "CONFIG_INVALID",
      "Public binding requires ASH_PUBLIC_URL=https://... and a TLS reverse proxy. ASH_ALLOW_INSECURE_PUBLIC_HTTP=true is an unsafe explicit override.",
    );
  const serverSecureCookies = (env.ASH_SERVER_SECURE_COOKIES ?? "auto").trim().toLowerCase();
  if (!["auto", "always", "never"].includes(serverSecureCookies)) {
    throw new AshError("CONFIG_INVALID", 'ASH_SERVER_SECURE_COOKIES must be "auto", "always" or "never".');
  }

  const config: AppConfig = {
    simulation,
    dataDir,
    logLevel: logLevel as LogLevelName,
    colorMode: colorMode as ColorMode,
    unicodeMode: unicodeMode as UnicodeMode,
    animation: envBool(env, "ASH_ANIMATION", true),
    model: {
      provider,
      name: provider === "demo" ? "ash-simulation-planner" : modelName,
      baseUrl,
      apiKey: modelKey,
      timeoutMs: envInt(env, "ASH_MODEL_TIMEOUT_MS", 120_000, 10_000, 600_000),
      jsonMode: envBool(env, "ASH_MODEL_JSON_MODE", true),
    },
    market: {
      mcpUrl: marketUrl,
      apiToken: marketToken,
      mode: marketMode,
      allowInCallSpend,
      timeoutMs: envInt(env, "ASH_MARKET_TIMEOUT_MS", 60_000, 5_000, 120_000),
      maxRetries: envInt(env, "ASH_MARKET_MAX_RETRIES", 3, 0, 5),
      rateLimitPerMinute: envInt(env, "ASH_MARKET_RATE_LIMIT", 60, 1, 600),
      hiringMode,
    },
    policy: {
      maxParallelJobs: envInt(env, "ASH_MAX_PARALLEL_JOBS", 3, 1, 8),
      maxRetries: envInt(env, "ASH_MAX_RETRIES", 3, 0, 5),
      contingencyRatio: envRatio(env, "ASH_CONTINGENCY_RATIO", 0.1),
      maxCounterOffersPerVendor: 1,
      maxRevisionRounds: 1,
      approvalTtlMinutes: envInt(env, "ASH_APPROVAL_TTL_MINUTES", 30, 5, 1_440),
      maxAgentCandidates: envInt(env, "ASH_MAX_AGENT_CANDIDATES", 6, 3, 20),
      maxDeliverableBytes: envInt(env, "ASH_MAX_DELIVERABLE_MB", 10, 1, 50) * 1024 * 1024,
      allowedVerifyCommands,
    },
    telegram: {
      botToken: telegramBotToken,
      chatId: telegramChatId,
      timeoutMs: envInt(env, "TELEGRAM_TIMEOUT_MS", 5_000, 1_000, 30_000),
    },
    server: {
      host: serverHost,
      port: serverPort,
      token: serverToken,
      allowRemote: serverAllowRemote,
      publicUrl: serverPublicUrl ? validatePublicUrl(serverPublicUrl) : null,
      secureCookies: serverSecureCookies as SecureCookieMode,
      ui: envBool(env, "ASH_SERVER_UI", false),
      codeTtlMinutes: envInt(env, "ASH_CODE_TTL_MINUTES", 5, 1, 10),
      allowInsecureHttp,
    },
  };

  if (config.market.mode === "pro" && !config.market.allowInCallSpend) {
    throw new AshError("CONFIG_INVALID", "Pro market mode requires ASH_ALLOW_IN_CALL_SPEND=true.");
  }

  return Object.freeze(config);
}

export interface PublicConfigView {
  mode: "LIVE" | "SIMULATION";
  data_dir: string;
  model_provider: ModelProvider;
  model_name: string | null;
  model_base_url_host: string | null;
  model_key_configured: boolean;
  market_url: string;
  market_token_configured: boolean;
  market_mode: MarketMode;
  in_call_spend: boolean;
  hiring_mode: HiringMode;
  max_parallel_jobs: number;
  max_retries: number;
  contingency_ratio: number;
  approval_ttl_minutes: number;
  verify_commands_allowlisted: number;
  telegram_configured: boolean;
  server: {
    remote: boolean;
    host: string;
    port: number;
    ui: boolean;
    public_url: string | null;
    secure_cookies: SecureCookieMode;
  };
  log_level: LogLevelName;
  color_mode: ColorMode;
  unicode_mode: UnicodeMode;
  animation: boolean;
}

export function publicConfig(config: AppConfig): PublicConfigView {
  let host: string | null = null;
  if (config.model.baseUrl) {
    try {
      host = new URL(config.model.baseUrl).host;
    } catch {
      host = null;
    }
  }
  return {
    mode: config.simulation ? "SIMULATION" : "LIVE",
    data_dir: config.dataDir,
    model_provider: config.model.provider,
    model_name: config.model.name,
    model_base_url_host: host,
    model_key_configured: Boolean(config.model.apiKey),
    market_url: config.market.mcpUrl,
    market_token_configured: Boolean(config.market.apiToken),
    market_mode: config.market.mode,
    in_call_spend: false, // No supported marketplace call has a binding price ceiling.
    hiring_mode: config.market.hiringMode,
    max_parallel_jobs: config.policy.maxParallelJobs,
    max_retries: config.policy.maxRetries,
    contingency_ratio: config.policy.contingencyRatio,
    approval_ttl_minutes: config.policy.approvalTtlMinutes,
    verify_commands_allowlisted: config.policy.allowedVerifyCommands.length,
    telegram_configured: Boolean(config.telegram.botToken && config.telegram.chatId),
    server: {
      remote: !isLoopbackHost(config.server.host),
      host: config.server.host,
      port: config.server.port,
      ui: config.server.ui,
      public_url: config.server.publicUrl,
      secure_cookies: config.server.secureCookies,
    },
    log_level: config.logLevel,
    color_mode: config.colorMode,
    unicode_mode: config.unicodeMode,
    animation: config.animation,
  };
}

function envBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new AshError("CONFIG_INVALID", `${key} must be true/false (got "${raw}").`);
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new AshError("CONFIG_INVALID", `${key} must be a whole number.`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new AshError("CONFIG_INVALID", `${key} must be between ${min} and ${max}.`);
  }
  return value;
}

function envRatio(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^0(?:\.\d+)?$|^1(?:\.0+)?$/.test(raw.trim())) {
    throw new AshError("CONFIG_INVALID", `${key} must be a decimal ratio between 0 and 1.`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 0.5) {
    throw new AshError("CONFIG_INVALID", `${key} must be between 0 and 0.5.`);
  }
  return value;
}

function optionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function validatePublicUrl(raw: string): string {
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

function validateHttpUrl(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new AshError("CONFIG_INVALID", `${label} is not a valid URL.`, { cause: error });
  }
  if (url.username || url.password) {
    throw new AshError("CONFIG_INVALID", `${label} must not embed credentials. Use a secret environment variable.`);
  }
  const local = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new AshError("CONFIG_INVALID", `${label} must use https (http is allowed only for localhost).`);
  }
  return url.toString();
}

function resolveSecret(env: NodeJS.ProcessEnv, directKey: string, fileKey: string): string | null {
  const direct = env[directKey]?.trim();
  const file = env[fileKey]?.trim();
  if (direct && file) {
    throw new AshError("CONFIG_INVALID", `Set only one of ${directKey} or ${fileKey}, not both.`);
  }
  if (direct) return direct;
  if (!file) return null;
  try {
    const stat = readFileSync(file);
    const value = stat.toString("utf8").trim();
    if (!value) throw new AshError("CONFIG_INVALID", `${fileKey} points to an empty file.`);
    return value;
  } catch (error) {
    if (error instanceof AshError) throw error;
    throw new AshError("CONFIG_INVALID", `Could not read ${fileKey}.`, { cause: error });
  }
}

function parseCommandList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const commands = raw
    .split(raw.includes("\n") ? "\n" : ";")
    .map((command) => command.trim())
    .filter(Boolean);
  if (commands.length > 20) {
    throw new AshError("CONFIG_INVALID", "ASH_VERIFY_COMMANDS allows at most 20 commands.");
  }
  for (const command of commands) {
    if (command.length > 500 || command.includes("\u0000")) {
      throw new AshError(
        "CONFIG_INVALID",
        "Each verification command must be under 500 characters and contain no NUL bytes.",
      );
    }
  }
  return commands;
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}
