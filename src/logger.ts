import { promises as fs } from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "./util/fs.js";
import { redact, redactObject } from "./util/redact.js";
import { nowIso } from "./util/time.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  audit(event: string, fields?: Record<string, unknown>): Promise<void>;
  readonly logFile: string;
  readonly auditFile: string;
  flush?(): Promise<void>;
}

interface LoggerOptions {
  dataDir: string;
  level: LogLevel;
  echo?: boolean;
}

class FileLogger implements Logger {
  readonly logFile: string;
  readonly auditFile: string;
  private readonly level: LogLevel;
  private readonly echo: boolean;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: LoggerOptions) {
    this.logFile = path.join(options.dataDir, "logs", "ash.log");
    this.auditFile = path.join(options.dataDir, "logs", "audit.log");
    this.level = options.level;
    this.echo = options.echo ?? false;
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  async audit(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    const line = `${JSON.stringify({
      at: nowIso(),
      event,
      ...(redactObject(fields) as Record<string, unknown>),
    })}\n`;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await ensurePrivateDir(path.dirname(this.auditFile));
        await fs.appendFile(this.auditFile, line, { mode: 0o600 });
      })
      .catch(() => undefined);
    await this.writeChain;
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const safeMessage = redact(message);
    const line = `${JSON.stringify({
      at: nowIso(),
      level,
      message: safeMessage,
      ...(fields ? (redactObject(fields) as Record<string, unknown>) : {}),
    })}\n`;
    if (this.echo) {
      process.stderr.write(line);
    }
    this.writeChain = this.writeChain
      .then(async () => {
        await ensurePrivateDir(path.dirname(this.logFile));
        await fs.appendFile(this.logFile, line, { mode: 0o600 });
      })
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }
}

class NullLogger implements Logger {
  readonly logFile = "/dev/null";
  readonly auditFile = "/dev/null";
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  async audit(): Promise<void> {}
}

export let logger: Logger = new NullLogger();

export async function initLogger(options: LoggerOptions): Promise<Logger> {
  await ensurePrivateDir(path.join(options.dataDir, "logs"));
  logger = new FileLogger(options);
  return logger;
}

export function setLogger(next: Logger): void {
  logger = next;
}

export function createSilentLogger(): Logger {
  return new NullLogger();
}
