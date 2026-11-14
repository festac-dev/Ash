import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleModel } from "../src/ai/model.js";
import { testConfig } from "./helpers.js";

test("empty token-limited output preserves finish reason and usage without identical retries", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({
      choices: [{ message: { content: "", reasoning_content: "Output budget exhausted" }, finish_reason: "length" }],
      usage: { prompt_tokens: 12, completion_tokens: 4000 },
    });
  });
  const config = testConfig("unused");
  config.model.baseUrl = "https://model.example/v1";
  config.model.name = "reasoning-model";
  const result = await new OpenAICompatibleModel(config).complete([{ role: "user", content: "Make a plan" }]);
  assert.equal(calls, 1);
  assert.equal(result.finishReason, "length");
  assert.equal(result.usage.completionTokens, 4000);
  assert.equal(result.text, "");
});

test("a completed but empty model response is not retried as a transport failure", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: "" }, finish_reason: "stop" }] });
  });
  const config = testConfig("unused");
  config.model.baseUrl = "https://model.example/v1";
  config.model.name = "empty-model";
  await assert.rejects(() => new OpenAICompatibleModel(config).complete([]), /empty response/);
  assert.equal(calls, 1);
});

test("oversized streaming model responses are cancelled without retries", async (t) => {
  let calls = 0;
  let cancelled = false;
  let chunks = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          chunks++;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const config = testConfig("unused");
  config.model.baseUrl = "https://model.example/v1";
  config.model.name = "test";
  const model = new OpenAICompatibleModel(config);
  await assert.rejects(() => model.complete([{ role: "user", content: "test" }]), /8 MiB safety limit/);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.ok(chunks <= 10, "response continued buffering past the limit");
});
