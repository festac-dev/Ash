import assert from "node:assert/strict";
import test from "node:test";
import { startAshServer, type RunningAshServer } from "../src/server/server.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";
import { createDemoTask } from "../src/demo.js";
import { commitEscrow } from "../src/ledger/ledger.js";
import { hashJson } from "../src/util/json.js";

const TOKEN = "test-session-token-0123456789";

async function api(server: RunningAshServer, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.session.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) assert.fail(`HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function waitForTask(
  server: RunningAshServer,
  id: string,
  deadlineMs = 45_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const state = await json<{ task: Record<string, unknown> }>(await api(server, "/api/state"));
    const status = state.task.status;
    if (status === "completed" || status === "failed" || status === "cancelled") return state.task;
    if (Date.now() > deadline)
      throw new Error(`task ${id} did not finish before the deadline (status ${String(status)})`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test("authenticated API exposes real state and preserves the financial workflow", { timeout: 90_000 }, async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
  try {
    const unauthorized = await fetch(`${server.session.url}/api/state`);
    assert.equal(unauthorized.status, 401);

    const health = await json<{ ok: boolean; mode: string }>(await api(server, "/api/health"));
    assert.equal(health.ok, true);
    assert.equal(health.mode, "SIMULATION");

    const initial = await json<{ mode: string; task: null; ledger: null; tasks: unknown[] }>(
      await api(server, "/api/state"),
    );
    assert.equal(initial.mode, "SIMULATION");
    assert.equal(initial.task, null);
    assert.equal(initial.ledger, null);
    assert.deepEqual(initial.tasks, []);

    const invalid = await api(server, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ description: "x", budget: "0", currency: "USDC" }),
    });
    assert.equal(invalid.status, 400);

    const created = await json<{ task: { id: string; status: string; currency: string } }>(
      await api(server, "/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          description: "Build a small launch checklist for a community event",
          budget: "50",
          currency: "USDC",
          execution_strategy: "autonomous",
          allow_external: true,
          diy_first: true,
          require_hiring_approval: false,
          max_parallel_jobs: 3,
        }),
      }),
    );
    assert.equal(created.task.status, "draft");
    assert.equal(created.task.currency, "USDC");

    const planned = await json<{ task: { status: string; plan: { subtasks: unknown[] } }; approval: null }>(
      await api(server, `/api/tasks/${created.task.id}/plan`, { method: "POST", body: "{}" }),
    );
    assert.equal(planned.task.status, "planned");
    assert.ok(planned.task.plan.subtasks.length >= 2);

    const started = await json<{ task: { status: string } }>(
      await api(server, `/api/tasks/${created.task.id}/execute`, { method: "POST", body: "{}" }),
    );
    assert.equal(started.task.status, "executing");

    const finished = await waitForTask(server, created.task.id);
    assert.equal(finished.status, "completed");

    const state = await json<{
      ledger: { paid: string; available: string; currency: string };
      integrity: { ok: boolean; receipt_count: number };
      receipts: Array<{ file: string }>;
    }>(await api(server, "/api/state"));
    assert.equal(state.integrity.ok, true);
    assert.ok(state.integrity.receipt_count >= 2);
    assert.equal(state.ledger.currency, "USDC");
    assert.ok(Number(state.ledger.paid) >= 0);

    const transactions = await json<{ integrity: { ok: boolean }; receipts: unknown[]; report: string[] }>(
      await api(server, "/api/transactions"),
    );
    assert.equal(transactions.integrity.ok, true);
    assert.ok(transactions.receipts.length >= 2);
    assert.ok(transactions.report.length > 0);

    const security = await json<{
      integrity: { ok: boolean };
      engine_running: boolean;
      limits: { market_mode: string };
    }>(await api(server, "/api/security"));
    assert.equal(security.integrity.ok, true);
    assert.equal(typeof security.engine_running, "boolean");
    assert.equal(security.limits.market_mode, "standard");

    const second = await json<{ task: { id: string } }>(
      await api(server, "/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          description: "A second task for activation coverage",
          budget: "5",
          currency: "USDC",
          execution_strategy: "plan_then_approve",
          allow_external: true,
          diy_first: true,
          require_hiring_approval: true,
          max_parallel_jobs: 1,
        }),
      }),
    );
    assert.notEqual(second.task.id, created.task.id);
    const activated = await json<{ task: { id: string } }>(
      await api(server, `/api/tasks/${created.task.id}/activate`, { method: "POST", body: "{}" }),
    );
    assert.equal(activated.task.id, created.task.id);

    const settings = await json<{ config: { mode: string }; task: { id: string } }>(await api(server, "/api/settings"));
    assert.equal(settings.config.mode, "SIMULATION");
    assert.equal(settings.task.id, created.task.id);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test("SSE stream authenticates and emits a ready event", { timeout: 30_000 }, async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
  const controller = new AbortController();
  try {
    const response = await fetch(`${server.session.url}/api/events`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 5_000;
    while (!text.includes("event: ready") && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(text, /event: ready/);
  } finally {
    controller.abort();
    await server.close();
    await cleanup(dir);
  }
});

test("shutdown closes an open SSE client instead of hanging", { timeout: 20_000 }, async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
  try {
    const controller = new AbortController();
    const response = await fetch(`${server.session.url}/api/events`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    await reader.read();
    const closed = server.close();
    const next = await Promise.race([
      reader.read(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);
    assert.notEqual(next, "timeout");
    await closed;
  } finally {
    await server.close().catch(() => undefined);
    await cleanup(dir);
  }
});

test("a denied plan can be regenerated", { timeout: 30_000 }, async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
  try {
    const created = await json<{ task: { id: string } }>(
      await api(server, "/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          description: "Plan denial regression coverage",
          budget: "20",
          currency: "USDC",
          execution_strategy: "plan_then_approve",
          allow_external: true,
          diy_first: true,
          require_hiring_approval: true,
          max_parallel_jobs: 1,
        }),
      }),
    );
    const first = await json<{ approval: { id: string } }>(
      await api(server, `/api/tasks/${created.task.id}/plan`, { method: "POST", body: "{}" }),
    );
    const denied = await json<{ task: { status: string } }>(
      await api(server, `/api/tasks/${created.task.id}/deny`, {
        method: "POST",
        body: JSON.stringify({ approval_id: first.approval.id, phrase: `DENY ${first.approval.id}` }),
      }),
    );
    assert.equal(denied.task.status, "awaiting_plan_approval");
    const second = await json<{ approval: { id: string } }>(
      await api(server, `/api/tasks/${created.task.id}/plan`, { method: "POST", body: "{}" }),
    );
    assert.notEqual(second.approval.id, first.approval.id);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test("resuming another task leaves the running task and active selection intact", async () => {
  const { createServices } = await import("../src/cli/services.js");
  const { AshService } = await import("../src/server/service.js");
  const { EventBus } = await import("../src/server/event-bus.js");
  const { validatePlan } = await import("../src/domain/plan.js");
  const dir = await tempDir();
  const services = await createServices(testConfig(dir));
  try {
    const service = new AshService(services, new EventBus(), new Date().toISOString(), process.pid);
    const input = {
      description: "Review the local task plan",
      budget: "10.00",
      currency: "USDC" as const,
      deadline: null,
      quality_requirements: null,
      preferred_agents: [],
      execution_strategy: "autonomous" as const,
      allow_external: false,
      diy_first: true,
      require_hiring_approval: false,
      max_parallel_jobs: 1,
      additional_instructions: null,
    };
    const running = await services.store.create(input);
    const paused = await services.store.create(input);
    const plan = validatePlan(
      {
        schema_version: 1,
        summary: "One local deliverable for this task",
        final_outcome: "A local review",
        assumptions: [],
        risks: [],
        currency: "USDC",
        authorized_budget: "10.00",
        contingency: "1.00",
        external_planned: "0.00",
        subtasks: [
          {
            id: "st_1",
            title: "Review",
            description: "Review the local plan document",
            execution: "DIY",
            dependencies: [],
            complexity: "low",
            skills: [],
            deliverable: "Review document",
            acceptance_criteria: [{ kind: "deliverable_present", description: "Present", min_chars: 10 }],
            planned_max: "0.00",
            estimated_cost: "0.00",
            rationale: "Local review",
          },
        ],
      },
      "10.00",
      "USDC",
      { allowedVerifyCommands: [], contingencyRatio: 0.1 },
    );
    for (const task of [running, paused])
      await services.store.installPlan(task.id, plan, { planApprovalRef: "strategy:autonomous" });
    await services.store.update(running.id, (task) => {
      task.status = "executing";
      task.subtasks[0]!.next_check_at = "2099-01-01T00:00:00Z";
    });
    await services.store.update(paused.id, (task) => {
      task.status = "paused";
    });
    await services.store.setActive(running.id);
    await services.engine.start();
    await assert.rejects(() => service.resume(paused.id), /engine is already running/);
    assert.equal(await services.store.getActive(), running.id);
    assert.equal((await services.store.load(paused.id)).status, "paused");
    assert.equal((await services.store.load(running.id)).status, "executing");
    assert.equal(services.engine.isRunning(), true);
  } finally {
    await services.engine.stop();
    await cleanup(dir);
  }
});

test("renewing a plan approval preserves funded attempts and never regenerates the plan", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
  try {
    const id = await createDemoTask(server.services.config);
    await server.services.store.update(id, (task) => {
      task.status = "executing";
    });
    await server.services.engine["beginAttempt"](id, "st_2", "EXTERNAL");
    await server.services.store.update(id, (task) => {
      task.execution_strategy = "plan_then_approve";
      task.status = "awaiting_plan_approval";
      task.plan_approval_ref = null;
      const state = task.subtasks.find((s) => s.id === "st_2")!;
      state.phase = "waiting_job";
      const attempt = state.attempts[0]!;
      attempt.job_id = "funded_review_job";
      attempt.payment_status = "ESCROWED";
      attempt.agreed_price = "14.00";
    });
    await server.services.store.mutateLedger(id, (ledger) =>
      commitEscrow(ledger, "14.00", "job:funded_review_job", "Existing funding", null, { job_id: "funded_review_job" }),
    );
    const before = await server.services.store.load(id);
    const ledgerBefore = await server.services.store.loadLedger(id);
    const manager = server.services.store.approvals(id);
    await manager.request({
      kind: "plan",
      summary: "Expired decision",
      amount: "14.00",
      currency: "USDC",
      ttlMinutes: -1,
      scope: { plan_hash: hashJson(before.plan), currency: "USDC" },
    });
    const renewed = await server.service.planTask(id);
    assert.ok(renewed.approval);
    assert.deepEqual(renewed.task.plan, before.plan);
    assert.deepEqual(renewed.task.subtasks, before.subtasks);
    assert.deepEqual(await server.services.store.loadLedger(id), ledgerBefore);
    assert.equal((await server.service.planTask(id)).approval?.id, renewed.approval.id);
    await assert.rejects(() => server.services.store.installPlan(id, before.plan), /progress must be preserved/);
    await server.service.approve(id, renewed.approval.id, manager.confirmationPhrase(renewed.approval));
    assert.deepEqual((await server.services.store.load(id)).subtasks, before.subtasks);
    assert.equal(server.services.engine.isRunning(), false);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test("plan decisions cannot resurrect closed tasks or overwrite a concurrent cancellation", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
  try {
    const id = await createDemoTask(server.services.config);
    const task = await server.services.store.load(id);
    const manager = server.services.store.approvals(id);
    const request = await manager.request({
      kind: "plan",
      summary: "Approve plan",
      amount: "14.00",
      currency: "USDC",
      scope: { plan_hash: hashJson(task.plan), currency: "USDC" },
    });
    for (const status of ["cancelled", "completed", "failed", "executing"] as const) {
      await server.services.store.update(id, (current) => {
        current.status = status;
      });
      await assert.rejects(
        () => server.service.approve(id, request.id, manager.confirmationPhrase(request)),
        /cannot be approved/,
      );
      assert.equal((await server.services.store.load(id)).status, status);
      assert.equal((await manager.get(request.id))?.status, "pending");
    }
    await server.services.store.update(id, (current) => {
      current.status = "awaiting_plan_approval";
    });
    const originalUpdate = server.services.store.update.bind(server.services.store);
    server.services.store.update = async (taskId, mutate, options) => {
      await originalUpdate(taskId, (current) => {
        current.status = "cancelled";
      });
      return originalUpdate(taskId, mutate, options);
    };
    await assert.rejects(
      () => server.service.approve(id, request.id, manager.confirmationPhrase(request)),
      /cannot be approved/,
    );
    assert.equal((await server.services.store.load(id)).status, "cancelled");
    server.services.store.update = originalUpdate;
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test("overlapping task controls cannot change the active task during startup", { timeout: 20_000 }, async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
  let finish!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const originalStart = server.services.engine.start.bind(server.services.engine);
  const input = { description: "Create another local task", budget: "10.00", currency: "USDC" };
  try {
    const id = await createDemoTask(server.services.config);
    await server.services.store.update(id, (task) => {
      for (const state of task.subtasks) state.next_check_at = "2099-01-01T00:00:00Z";
    });
    const other = await server.service.createTask(input);
    await server.services.store.setActive(id);
    server.services.engine.start = async () => {
      started();
      await gate;
      await originalStart();
    };
    const first = server.service.execute(id);
    await entering;
    await assert.rejects(() => server.service.execute(id), /control operation/);
    await assert.rejects(() => server.service.activateTask(other.id), /control operation/);
    await assert.rejects(() => server.service.createTask(input), /control operation/);
    assert.equal(await server.services.store.getActive(), id);
    finish();
    await first;
    await assert.rejects(() => server.service.createTask(input), /Pause or finish/);
    assert.equal(await server.services.store.getActive(), id);
    assert.equal((await server.services.store.load(other.id)).status, "draft");
    await server.service.cancel(other.id, `CANCEL ${other.id}`);
    assert.equal((await server.services.store.load(other.id)).status, "cancelled");
    assert.equal(server.services.engine.isRunningTask(id), true, "cancelling another task stopped the active engine");
  } finally {
    finish();
    await server.close();
    await cleanup(dir);
  }
});

test("pause cannot overwrite a concurrent terminal task status", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
  const update = server.services.store.update.bind(server.services.store);
  try {
    const id = await createDemoTask(server.services.config);
    for (const status of ["cancelled", "completed", "failed"] as const) {
      await update(id, (task) => {
        task.status = "executing";
      });
      server.services.store.update = async (taskId, mutate, options) => {
        server.services.store.update = update;
        await update(taskId, (task) => {
          task.status = status;
        });
        return update(taskId, mutate, options);
      };
      await assert.rejects(() => server.service.pause(id), /not executing/);
      assert.equal((await server.services.store.load(id)).status, status);
    }
  } finally {
    server.services.store.update = update;
    await server.close();
    await cleanup(dir);
  }
});

test("settings cannot disable approval after execution starts concurrently", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
  const update = server.services.store.update.bind(server.services.store);
  try {
    const id = await createDemoTask(server.services.config);
    await update(id, (task) => {
      task.status = "paused";
      task.require_hiring_approval = true;
    });
    server.services.store.update = async (taskId, mutate, options) => {
      server.services.store.update = update;
      await update(taskId, (task) => {
        task.status = "executing";
      });
      return update(taskId, mutate, options);
    };
    await assert.rejects(() => server.service.updateSetting(id, "hire_approval", "false"), /Pause the task/);
    assert.equal((await server.services.store.load(id)).require_hiring_approval, true);
  } finally {
    server.services.store.update = update;
    await server.close();
    await cleanup(dir);
  }
});

test("autonomous planning cannot undo cancellation after installing a plan", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
  try {
    const task = await server.service.createTask({
      description: "Create a launch checklist",
      budget: "25.00",
      currency: "USDC",
      execution_strategy: "autonomous",
    });
    const install = server.services.store.installPlan.bind(server.services.store);
    server.services.store.installPlan = async (id, plan, options) => {
      const result = await install(id, plan, options);
      await server.services.store.update(id, (current) => {
        current.status = "cancelled";
      });
      return result;
    };
    await assert.rejects(() => server.service.planTask(task.id), /task changed/);
    assert.equal((await server.services.store.load(task.id)).status, "cancelled");
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test(
  "SSE connections are capped and cross-port loopback browser origins are rejected",
  { timeout: 30_000 },
  async () => {
    const dir = await tempDir();
    const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
    const controllers: AbortController[] = [];
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      const url = new URL(server.session.url);
      url.port = url.port === "65535" ? "65534" : String(Number(url.port) + 1);
      assert.equal((await api(server, "/api/state", { headers: { Origin: url.origin } })).status, 403);
      for (let i = 0; i < 64; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await api(server, "/api/events", { signal: controller.signal });
        assert.equal(response.status, 200);
        const reader = response.body!.getReader();
        await reader.read();
        readers.push(reader);
      }
      const overflow = await api(server, "/api/events");
      assert.equal(overflow.status, 429);
      await overflow.text();
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(readers.map((reader) => reader.cancel()));
      await server.close();
      await cleanup(dir);
    }
  },
);
