import type { TelegramConfig } from "./config.js";
import { logger } from "./logger.js";
import { registerSecret } from "./util/redact.js";
import { clip } from "./util/strings.js";

export type NotifyLevel = "info" | "success" | "warning" | "error";

const LEVEL_PREFIX: Record<NotifyLevel, string> = {
  info: "ℹ️ INFO",
  success: "✅ SUCCESS",
  warning: "⚠️ WARNING",
  error: "❌ ERROR",
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TelegramNotifierOptions {
  fetchImpl?: FetchLike;
}

/**
 * Best-effort Telegram delivery through the Bot API. Configuration is
 * optional: a missing token or chat id only logs a warning, and no network
 * failure is ever allowed to interrupt a task.
 */
export class TelegramNotifier {
  private readonly fetchImpl: FetchLike;
  private botToken: string | null = null;
  private chatId: string | null = null;
  private timeoutMs = 5_000;
  private warnedPartial = false;

  constructor(options: TelegramNotifierOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  configure(config: TelegramConfig): void {
    this.botToken = config.botToken?.trim() || null;
    this.chatId = config.chatId?.trim() || null;
    this.timeoutMs = config.timeoutMs;
    if (this.botToken) registerSecret(this.botToken);
    if (!this.botToken && !this.chatId) {
      this.warnedPartial = false;
      return;
    }
    if (!this.botToken || !this.chatId) {
      if (!this.warnedPartial) {
        logger.warn(
          "Telegram notifications need both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; notifications are disabled.",
        );
        this.warnedPartial = true;
      }
      return;
    }
    this.warnedPartial = false;
  }

  get configured(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  async notify(message: string, level: NotifyLevel = "info"): Promise<boolean> {
    if (!this.botToken || !this.chatId) return false;
    const text = `[Ash] ${LEVEL_PREFIX[level]} ${clip(message.trim(), 3_500)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn("Telegram notification failed", { status: response.status });
        return false;
      }
      return true;
    } catch (error) {
      logger.warn("Telegram notification failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const telegram = new TelegramNotifier();

export function configureTelegram(config: TelegramConfig): void {
  telegram.configure(config);
}

export function notify(message: string, level: NotifyLevel = "info"): Promise<boolean> {
  return telegram.notify(message, level);
}
