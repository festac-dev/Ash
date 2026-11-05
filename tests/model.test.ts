import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleModel } from "../src/ai/model.js";
import { testConfig } from "./helpers.js";

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
