import assert from "node:assert/strict";
import test from "node:test";
import { TelegramNotifier } from "../src/notify.js";

test("Telegram is disabled when configuration is missing and never throws", async () => {
  let calls = 0;
  const notifier = new TelegramNotifier({
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
  });
  notifier.configure({ botToken: null, chatId: null, timeoutMs: 5_000 });
  assert.equal(notifier.configured, false);
  assert.equal(await notifier.notify("hello", "info"), false);
  assert.equal(calls, 0);

  notifier.configure({ botToken: "123456:token", chatId: null, timeoutMs: 5_000 });
  assert.equal(notifier.configured, false);
  assert.equal(await notifier.notify("hello", "warning"), false);
  assert.equal(calls, 0);
});

test("Telegram sends a level-prefixed message through the Bot API", async () => {
  let requestedUrl = "";
  let body: Record<string, unknown> = {};
  const notifier = new TelegramNotifier({
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  notifier.configure({ botToken: "123456:test-token", chatId: "42", timeoutMs: 5_000 });
  assert.equal(await notifier.notify("Task completed.", "success"), true);
  assert.equal(requestedUrl, "https://api.telegram.org/bot123456:test-token/sendMessage");
  assert.equal(body.chat_id, "42");
  assert.match(String(body.text), /^\[Ash\] ✅ SUCCESS Task completed\.$/);
  assert.equal(body.disable_web_page_preview, true);
});

test("Telegram delivery failures are swallowed and logged as a warning", async () => {
  const notifier = new TelegramNotifier({
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  notifier.configure({ botToken: "123456:test-token", chatId: "42", timeoutMs: 5_000 });
  assert.equal(await notifier.notify("hello", "error"), false);
});
