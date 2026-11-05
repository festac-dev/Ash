import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createDemoConfig, runDemoFlow } from "../src/demo/runtime.js";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/cli/services.js";
import { AshService } from "../src/server/service.js";
import { EventBus } from "../src/server/event-bus.js";
import { TaskStore } from "../src/state/store.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

test("demo configuration ignores all supplied secrets, paths and external providers", async () => {
  const config = await createDemoConfig({
    ASH_DATA_DIR: "/real-user-data",
    ASH_MODEL_PROVIDER: "openai-compatible",
    MARKET_API_TOKEN: "never-use",
    TELEGRAM_BOT_TOKEN: "never-send",
  });
  try {
    assert.notEqual(config.dataDir, "/real-user-data");
    assert.equal(config.model.provider, "demo");
    assert.equal(config.model.apiKey, null);
    assert.equal(config.market.apiToken, null);
    assert.equal(config.telegram.botToken, null);
    assert.equal(config.server.host, "127.0.0.1");
    assert.equal(config.server.allowRemote, false);
    assert.equal(config.server.ui, false);
    assert.deepEqual(config.policy.allowedVerifyCommands, []);
  } finally {
    await cleanup(config.dataDir);
  }
  await assert.rejects(() => createDemoConfig({ NODE_ENV: "production" }), /disabled/);
  assert.throws(() => loadConfig({ ASH_DEMO: "1", NODE_ENV: "production" }), /disabled/);
  assert.throws(() => loadConfig({ ASH_SIMULATE: "true" }), /no longer supported/);
});

test("demo refuses to mix simulated and real user state", async () => {
  const dir = await tempDir();
  try {
    await new TaskStore({ ...testConfig(dir), simulation: false }).init();
    await assert.rejects(() => new TaskStore(testConfig(dir)).init(), /different live\/simulation/);
    const marker = JSON.parse(await fs.readFile(path.join(dir, ".ash-mode.json"), "utf8"));
    assert.equal(marker.simulated, false);
  } finally {
    await cleanup(dir);
  }
});

test(
  "empty-environment demo completes normal planning, approval, engine and receipts with zero outbound calls",
  { timeout: 200_000 },
  async () => {
    const config = await createDemoConfig({});
    let calls = 0;
    const originalFetch = globalThis.fetch;
    const originalConnect = net.Socket.prototype.connect;
    const blocked = () => {
      calls++;
      throw new Error("Demo attempted outbound network I/O");
    };
    globalThis.fetch = blocked;
    net.Socket.prototype.connect = blocked;
    const services = await createServices(config);
    try {
      const service = new AshService(services, new EventBus(), new Date().toISOString(), process.pid);
      await service.initialize();
      const result = await runDemoFlow(service, services);
      assert.equal(result.status, "completed");
      assert.equal(result.simulated, true);
      assert.ok(result.receipt_count >= 4);
      assert.equal(result.integrity, true);
      assert.deepEqual(result.rejected_cases, ["invalid_budget", "wrong_approval"]);
      const task = await services.store.load(result.task_id);
      assert.ok(task.plan_approval_ref?.startsWith("apr_"));
      assert.ok(task.subtasks.some((step) => step.attempts.length > 0));
      const receipts = await services.transactions.list();
      assert.ok(receipts.every((receipt) => receipt.mode === "simulated"));
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = originalFetch;
      net.Socket.prototype.connect = originalConnect;
      await services.engine.stop();
      await services.market.disconnect();
      await cleanup(config.dataDir);
    }
  },
);
