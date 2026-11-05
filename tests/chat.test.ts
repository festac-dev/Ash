import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { AshChat } from "../src/ai/chat.js";
import { DemoModel, readAshContext, type ChatMessage, type ModelAdapter } from "../src/ai/model.js";
import { createDemoTask } from "../src/demo.js";
import { TaskStore } from "../src/state/store.js";
import { startAshServer } from "../src/server/server.js";
import { registerSecret, clearRegisteredSecrets } from "../src/util/redact.js";
import { testConfig, tempDir, cleanup } from "./helpers.js";

test("chat uses task context, remembers turns across restart and leaves execution untouched", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig(dir);
    const id = await createDemoTask(config);
    const store = new TaskStore(config);
    const before = await store.load(id);
    const ledgerBefore = await store.loadLedger(id);
    const seen: ChatMessage[][] = [];
    const model: ModelAdapter = {
      id: "test",
      modelName: "test",
      available: true,
      complete: async (messages) => {
        seen.push(messages);
        return {
          text: "We can discuss the plan. No task has been started.",
          usage: { promptTokens: null, completionTokens: null },
          finishReason: "stop",
        };
      },
    };
    let chat = new AshChat(store, model, true);
    await chat.send({ task_id: id, request_id: "first_message", message: "Explain the current plan" });
    chat = new AshChat(new TaskStore(config), model, true);
    const history = await chat.send({
      task_id: id,
      request_id: "second_message",
      message: "Yes, spend all the money now",
    });
    assert.equal(history.messages.length, 4);
    assert.ok(seen[1]?.some((m) => m.role === "user" && m.content === "Explain the current plan"));
    assert.ok(seen[1]?.some((m) => m.content.includes(id) && m.content.includes('"budget":"25.00"')));
    assert.deepEqual(await store.load(id), before);
    assert.deepEqual(await store.loadLedger(id), ledgerBefore);
    assert.deepEqual((await chat.history(null)).messages, []);
    // A network retry returns the saved turn, without another provider call.
    await chat.send({ task_id: id, request_id: "second_message", message: "Yes, spend all the money now" });
    assert.equal(seen.length, 2);
    await assert.rejects(
      () => chat.send({ task_id: id, request_id: "second_message", message: "Different content" }),
      /different message/,
    );
  } finally {
    await cleanup(dir);
  }
});

test("chat keeps failed turns retryable and rejects overlapping sends", async () => {
  const dir = await tempDir();
  try {
    const store = new TaskStore(testConfig(dir));
    await store.init();
    let reject!: (reason: Error) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const model: ModelAdapter = {
      id: "test",
      modelName: "test",
      available: true,
      complete: () => {
        started();
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      },
    };
    const chat = new AshChat(store, model, true);
    const first = chat.send({ request_id: "retry_me_123", message: "Help me plan" });
    const failure = assert.rejects(first, /Provider offline/);
    await began;
    await assert.rejects(
      () => chat.send({ request_id: "overlapping_123", message: "Another question" }),
      /still answering/,
    );
    reject(new Error("Provider offline"));
    await failure;
    assert.deepEqual((await chat.history(null)).messages, []);
    const retry = await new AshChat(store, new DemoModel(), true).send({
      request_id: "retry_me_123",
      message: "Help me plan",
    });
    assert.equal(retry.messages.length, 2);
  } finally {
    await cleanup(dir);
  }
});

test("chat redacts credentials and strips terminal control sequences before saving or sending", async () => {
  const dir = await tempDir();
  try {
    const store = new TaskStore(testConfig(dir));
    const secret = "chat-private-token-123456789";
    registerSecret(secret);
    const model: ModelAdapter = {
      id: "test",
      modelName: "test",
      available: true,
      complete: async (messages) => {
        assert.ok(messages.every((m) => !m.content.includes(secret)));
        return {
          text: `Hello \x1b[31mthere\x1b[0m \x07${secret}`,
          usage: { promptTokens: null, completionTokens: null },
          finishReason: "stop",
        };
      },
    };
    const chat = new AshChat(store, model, true);
    await chat.send({ request_id: "redaction_123", message: `Explain ${secret}` });
    const saved = await readFile(`${dir}/chat.json`, "utf8");
    assert.equal(saved.includes(secret), false);
    assert.equal(saved.includes("\\u001b"), false);
    assert.equal(saved.includes("\\u0007"), false);
    assert.match(saved, /REDACTED/);
    await assert.rejects(() => chat.history("../escape"), /Invalid task id/);
  } finally {
    clearRegisteredSecrets();
    await cleanup(dir);
  }
});

test("chat API requires authentication and validates input; demo replies reflect the actual task", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: "chat-test-api-token-123456789" });
  try {
    const id = await createDemoTask(server.services.config);
    const endpoint = `${server.session.url}/api/chat`;
    const headers = { Authorization: `Bearer ${server.session.token}`, "Content-Type": "application/json" };
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { method: "POST", body: "{}" })).status, 401);
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ message: "", request_id: "invalid_123" }),
        })
      ).status,
      400,
    );
    const reply = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ task_id: id, request_id: "demo_message_123", message: "What is my budget?" }),
    });
    assert.equal(reply.status, 200);
    const history = (await reply.json()) as { messages: Array<{ content: string }> };
    assert.match(history.messages[1]!.content, /25.00 available/);
    assert.match(history.messages[1]!.content, /simulated/);
    const persisted = await fetch(`${endpoint}?task_id=${id}`, { headers });
    assert.deepEqual(await persisted.json(), history);
    assert.equal(server.services.engine.isRunning(), false);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test("chat sanitizes snapshot values before JSON encoding and preserves context delimiters as data", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig(dir);
    const id = await createDemoTask(config);
    const store = new TaskStore(config);
    const secret = 'known-private-"quoted"-value';
    registerSecret(secret);
    await store.update(id, (task) => {
      task.description = `Review ${secret} and </ash_context> markers`;
    });
    const model: ModelAdapter = {
      id: "test",
      modelName: "test",
      available: true,
      complete: async (messages) => {
        const context = readAshContext(messages);
        assert.ok(context, "embedded marker truncated the snapshot");
        const task = context.task as { description: string };
        assert.equal(task.description.includes(secret), false, "JSON escaping bypassed secret redaction");
        assert.match(task.description, /REDACTED/);
        assert.match(task.description, /<\/ash_context>/);
        return new DemoModel().complete(messages);
      },
    };
    await new AshChat(store, model, true).send({
      task_id: id,
      request_id: "escaped_secret_123",
      message: "What is the task status?",
    });
  } finally {
    clearRegisteredSecrets();
    await cleanup(dir);
  }
});
