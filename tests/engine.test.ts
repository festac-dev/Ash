import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { TaskStore } from "../src/state/store.js";
import { SimulatedMarketAdapter } from "../src/market/simulated-adapter.js";
import { ExecutionEngine } from "../src/engine/engine.js";
import { TransactionLedger } from "../src/transactions/ledger.js";
import { DemoModel } from "../src/ai/model.js";
import { validatePlan } from "../src/domain/plan.js";
import type { TaskRecord } from "../src/domain/types.js";
import { summarizeLedger } from "../src/ledger/ledger.js";
import { parseAmount } from "../src/util/money.js";
import { hashJson } from "../src/util/json.js";
import { atomicWriteJson, readJsonIfExists } from "../src/util/fs.js";
import type { ApprovalRecord } from "../src/domain/types.js";
import { tempDir, cleanup, testConfig, waitFor } from "./helpers.js";

const PLAN = {
  schema_version: 1,
  summary: "One external deliverable followed by local handover.",
  final_outcome: "A verified external deliverable and a handover note.",
  assumptions: [],
  risks: [],
  currency: "USDC",
  authorized_budget: "16.00",
  contingency: "2.00",
  external_planned: "14.00",
  subtasks: [
    {
      id: "st_1",
      title: "Produce the reviewed deliverable",
      description:
        "Produce the requested website review and address authentication, dashboard, payments and automated tests.",
      execution: "EXTERNAL",
      dependencies: [],
      complexity: "medium",
      skills: ["review"],
      deliverable: "A review that covers every required area",
      acceptance_criteria: [
        { kind: "deliverable_present", description: "The deliverable is present.", min_chars: 50 },
        {
          kind: "llm_review",
          description: "The deliverable follows the brief.",
          rubric: "Check that authentication, dashboard, payments and automated tests are addressed.",
        },
      ],
      planned_max: "14.00",
      estimated_cost: "12.00",
      rationale: "External independent review.",
    },
  ],
} as const;

async function setup(
  options: {
    strategy?: TaskRecord["execution_strategy"];
    approvePlan?: boolean;
    hiringMode?: "direct" | "board";
    requireApproval?: boolean;
  } = {},
): Promise<{
  dir: string;
  config: ReturnType<typeof testConfig>;
  store: TaskStore;
  task: TaskRecord;
  market: SimulatedMarketAdapter;
  engine: ExecutionEngine;
}> {
  const dir = await tempDir();
  const config = testConfig(dir, {
    ASH_MAX_PARALLEL_JOBS: "2",
    ASH_HIRING_MODE: options.hiringMode ?? "direct",
  });
  const store = new TaskStore(config);
  const created = await store.create({
    description: "Review a production website with authentication, dashboard, payments and automated tests.",
    budget: "16.00",
    currency: "USDC",
    deadline: null,
    quality_requirements: null,
    preferred_agents: [],
    execution_strategy: options.strategy ?? "autonomous",
    allow_external: true,
    diy_first: false,
    require_hiring_approval: options.requireApproval ?? true,
    max_parallel_jobs: 1,
    additional_instructions: null,
  });
  const plan = validatePlan(PLAN, "16.00", "USDC", {
    allowedVerifyCommands: [],
    contingencyRatio: 0.1,
  });
  await store.installPlan(created.id, plan, { planApprovalRef: "strategy:autonomous" });
  await store.update(created.id, (task) => {
    task.status = "executing";
  });
  const market = new SimulatedMarketAdapter(config, { latencyMs: 0 });
  const engine = new ExecutionEngine({ config, store, market, model: new DemoModel() });
  return { dir, config, store, task: await store.load(created.id), market, engine };
}

async function approvePending(store: TaskStore, taskId: string, seen: Set<string>): Promise<void> {
  const pending = await store.approvals(taskId).pending();
  for (const request of pending) {
    if (seen.has(request.id)) continue;
    const manager = store.approvals(taskId);
    await manager.decide(request.id, "approved", manager.confirmationPhrase(request));
    seen.add(request.id);
  }
}

test("engine completes a simulated hire end-to-end and records one paid receipt", { timeout: 60_000 }, async () => {
  const ctx = await setup();
  const seen = new Set<string>();
  try {
    await ctx.engine.start();
    const finished = await waitFor(
      async () => {
        await approvePending(ctx.store, ctx.task.id, seen);
        const task = await ctx.store.load(ctx.task.id);
        return ["completed", "failed", "cancelled"].includes(task.status) ? task : null;
      },
      { timeoutMs: 40_000, intervalMs: 200, label: "task completion" },
    );
    assert.equal(finished.status, "completed");
    assert.equal(finished.subtasks[0]?.phase, "completed");
    assert.ok(finished.last_receipt_hash);

    const transactions = new TransactionLedger(ctx.dir);
    const receipts = await transactions.list();
    assert.equal(receipts.length, 1);
    const receipt = receipts[0]!;
    assert.equal(receipt.status, "SIMULATED");
    assert.equal(receipt.payment_status, "SIMULATED_RELEASED");
    assert.equal(receipt.agreed_price, "14.00");
    assert.equal(receipt.mode, "simulated");
    assert.equal((await transactions.verify()).ok, true);

    const ledger = await ctx.store.loadLedger(ctx.task.id);
    const totals = summarizeLedger(ledger);
    assert.equal(totals.paid, 14_000_000n);
    assert.equal(totals.committed, 0n);
    assert.equal(totals.available, 2_000_000n);

    const task = await ctx.store.load(ctx.task.id);
    assert.equal(task.last_receipt_file, receipt.metadata.file);
  } finally {
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

test("engine resumes funded work after a full process-state restart", { timeout: 60_000 }, async () => {
  const ctx = await setup();
  const seen = new Set<string>();
  try {
    await ctx.engine.start();
    await waitFor(
      async () => {
        await approvePending(ctx.store, ctx.task.id, seen);
        const task = await ctx.store.load(ctx.task.id);
        const attempt = task.subtasks[0]?.attempts[0];
        return attempt?.payment_status === "ESCROWED" ? task : null;
      },
      { timeoutMs: 30_000, intervalMs: 200, label: "escrow funding" },
    );
    await ctx.engine.stop();

    const before = await ctx.store.load(ctx.task.id);
    assert.equal(before.status, "executing");
    assert.equal(before.subtasks[0]?.phase, "waiting_job");
    const ledgerBefore = summarizeLedger(await ctx.store.loadLedger(ctx.task.id));
    assert.equal(ledgerBefore.committed, 14_000_000n);

    const market2 = new SimulatedMarketAdapter(ctx.config, { latencyMs: 0 });
    const engine2 = new ExecutionEngine({
      config: ctx.config,
      store: ctx.store,
      market: market2,
      model: new DemoModel(),
    });
    try {
      await engine2.start();
      const finished = await waitFor(
        async () => {
          await approvePending(ctx.store, ctx.task.id, seen);
          const task = await ctx.store.load(ctx.task.id);
          return ["completed", "failed", "cancelled"].includes(task.status) ? task : null;
        },
        { timeoutMs: 40_000, intervalMs: 200, label: "restart completion" },
      );
      assert.equal(finished.status, "completed");
      const receipts = await new TransactionLedger(ctx.dir).list();
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]?.status, "SIMULATED");
    } finally {
      await engine2.stop();
    }
  } finally {
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

test("cancelling a funded task records a receipt but leaves escrow unresolved", { timeout: 60_000 }, async () => {
  const ctx = await setup();
  const seen = new Set<string>();
  try {
    await ctx.engine.start();
    await waitFor(
      async () => {
        await approvePending(ctx.store, ctx.task.id, seen);
        const task = await ctx.store.load(ctx.task.id);
        return task.subtasks[0]?.attempts[0]?.payment_status === "ESCROWED" ? task : null;
      },
      { timeoutMs: 30_000, intervalMs: 200, label: "escrow funding" },
    );
    await ctx.engine.cancelTask(ctx.task.id, "Test cancellation");
    await ctx.engine.stop();

    const task = await ctx.store.load(ctx.task.id);
    assert.equal(task.status, "cancelled");
    const receipt = (await new TransactionLedger(ctx.dir).list())[0]!;
    assert.equal(receipt.status, "CANCELLED");
    assert.equal(receipt.payment_status, "REFUND_PENDING");
    const totals = summarizeLedger(await ctx.store.loadLedger(ctx.task.id));
    assert.equal(totals.committed, 14_000_000n);
    assert.equal(totals.refunded, 0n);
  } finally {
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

test("a task cannot start without an approved plan", { timeout: 20_000 }, async () => {
  const ctx = await setup({ strategy: "plan_then_approve" });
  try {
    await ctx.store.update(ctx.task.id, (task) => {
      task.plan_approval_ref = null;
      task.status = "awaiting_plan_approval";
    });
    await assert.rejects(() => ctx.engine.start(), /Approve the plan|plan approved|after the plan is approved/i);
  } finally {
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

test(
  "stopping during engine startup prevents work and releases the newly acquired lease",
  { timeout: 20_000 },
  async () => {
    const ctx = await setup();
    let acquired!: () => void;
    let finishAcquire!: () => void;
    const atLease = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finishAcquire = resolve;
    });
    const originalAcquire = ctx.store.acquireEngineLock.bind(ctx.store);
    ctx.store.acquireEngineLock = async (id) => {
      const release = await originalAcquire(id);
      acquired();
      await gate;
      return release;
    };
    try {
      const starting = ctx.engine.start();
      await atLease;
      const stopping = ctx.engine.stop();
      finishAcquire();
      await Promise.all([starting, stopping]);
      assert.equal(ctx.engine.isRunning(), false);
      assert.equal((await ctx.store.load(ctx.task.id)).subtasks[0]!.attempts.length, 0);
      const release = await originalAcquire(ctx.task.id);
      await release();
    } finally {
      finishAcquire();
      await ctx.engine.stop();
      await cleanup(ctx.dir);
    }
  },
);

for (const invalid of ["missing", "expired", "changed"] as const) {
  test(`engine requires a fresh plan decision when the referenced approval is ${invalid}`, async () => {
    const ctx = await setup({ strategy: "plan_then_approve" });
    try {
      const manager = ctx.store.approvals(ctx.task.id);
      let reference = "apr_missing";
      if (invalid !== "missing") {
        const request = await manager.request({
          kind: "plan",
          summary: "Approve plan",
          amount: "14.00",
          currency: "USDC",
          scope: { plan_hash: invalid === "changed" ? "wrong-plan" : hashJson(ctx.task.plan), currency: "USDC" },
        });
        await manager.decide(request.id, "approved", manager.confirmationPhrase(request));
        reference = request.id;
        if (invalid === "expired") {
          const file = ctx.store.approvalsFile(ctx.task.id);
          const record = (await readJsonIfExists<ApprovalRecord>(file))!;
          record.requests[0]!.expires_at = "2000-01-01T00:00:00.000Z";
          await atomicWriteJson(file, record);
        }
      }
      await ctx.store.update(ctx.task.id, (task) => {
        task.plan_approval_ref = reference;
      });
      await assert.rejects(() => ctx.engine.start(), /Approve the plan/);
      assert.equal(ctx.engine.isRunning(), false);
      const task = await ctx.store.load(ctx.task.id);
      assert.equal(task.status, "awaiting_plan_approval");
      assert.equal(task.plan_approval_ref, null);
      assert.equal(task.subtasks[0]!.attempts.length, 0);
      const requests = await manager.pending();
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.scope.plan_hash, hashJson(task.plan));
      // The fresh request is sufficient once the human actually approves it.
      await manager.decide(requests[0]!.id, "approved", manager.confirmationPhrase(requests[0]!));
      await ctx.store.update(task.id, (current) => {
        current.plan_approval_ref = requests[0]!.id;
        current.plan_approved_at = new Date().toISOString();
        current.status = "executing";
      });
      await ctx.engine.start();
      assert.equal(ctx.engine.isRunning(), true);
    } finally {
      await ctx.engine.stop();
      await cleanup(ctx.dir);
    }
  });
}

test("board mode awards a bid under plan authority without a stale post approval", { timeout: 60_000 }, async () => {
  const ctx = await setup({ hiringMode: "board", requireApproval: false });
  const seen = new Set<string>();
  try {
    await ctx.engine.start();
    let finished;
    try {
      finished = await waitFor(
        async () => {
          await approvePending(ctx.store, ctx.task.id, seen);
          const task = await ctx.store.load(ctx.task.id);
          return ["completed", "failed", "cancelled"].includes(task.status) ? task : null;
        },
        { timeoutMs: 45_000, intervalMs: 200, label: "board task completion" },
      );
    } catch (error) {
      const task = await ctx.store.load(ctx.task.id);
      console.log(
        "DEBUG BOARD",
        JSON.stringify(
          {
            status: task.status,
            detail: task.status_detail,
            subtasks: task.subtasks.map((state) => ({
              id: state.id,
              phase: state.phase,
              next: state.next_check_at,
              err: state.last_error,
              attempts: state.attempts.map((attempt) => ({
                status: attempt.status,
                job: attempt.job_id,
                bid: attempt.bid_id,
                approval: attempt.approval_ref,
                payment: attempt.payment_status,
              })),
            })),
            approvals: (await ctx.store.approvals(ctx.task.id).list()).map((request) => ({
              id: request.id,
              kind: request.kind,
              status: request.status,
              scope: request.scope,
            })),
            events: (await ctx.store.readEvents(ctx.task.id, 30)).map((event) => `${event.code}: ${event.message}`),
          },
          null,
          2,
        ),
      );
      throw error;
    }
    assert.equal(finished.status, "completed");
    const receipts = await new TransactionLedger(ctx.dir).list();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.status, "SIMULATED");
    const totals = summarizeLedger(await ctx.store.loadLedger(ctx.task.id));
    assert.equal(totals.paid > 0n, true);
    assert.equal(totals.committed, 0n);
    assert.equal(totals.paid <= parseAmount("14.00", "USDC"), true);
    assert.equal(totals.available, 16_000_000n - totals.paid);
    const approvals = await ctx.store.approvals(ctx.task.id).list();
    assert.ok(approvals.some((request) => request.kind === "hire" && request.scope.mode === "board_post"));
    assert.equal(
      approvals.some((request) => request.kind === "award"),
      false,
    );
  } finally {
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

async function selected(
  ctx: Awaited<ReturnType<typeof setup>>,
  phase: TaskRecord["subtasks"][number]["phase"] = "awaiting_hire_approval",
) {
  await ctx.engine["beginAttempt"](ctx.task.id, "st_1", "EXTERNAL");
  await ctx.store.update(ctx.task.id, (task) => {
    const state = task.subtasks[0]!;
    const attempt = state.attempts[0]!;
    state.phase = phase;
    attempt.vendor = { id: "agent_test", name: "Test vendor", handle: null };
    attempt.quoted_price = "14.00";
    attempt.negotiated_price = "14.00";
  });
}

test("engine stays busy until concurrent stops drain funding and release the lease", { timeout: 20_000 }, async () => {
  const ctx = await setup({ requireApproval: false });
  let finish!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stops: Promise<void>[] = [];
  try {
    await selected(ctx, "preparing_draft");
    ctx.market.prepareJob = async () => {
      entered();
      await gate;
      return {
        state: "funded",
        job_id: "job_stopping",
        assignment_id: null,
        job_url: null,
        funded: true,
        amount: "14.00",
        currency: "USDC",
        raw: {},
      };
    };
    await ctx.engine.start();
    await called;
    await ctx.store.update(ctx.task.id, (task) => {
      task.status = "paused";
    });
    stops.push(ctx.engine.stop(), ctx.engine.stop());
    assert.equal(ctx.engine.isRunningTask(ctx.task.id), true, "funding must finish before the engine becomes idle");
    await assert.rejects(() => ctx.engine.start(), /stopping/);
    finish();
    await Promise.all(stops);
    assert.equal(ctx.engine.isRunning(), false);
    assert.equal(summarizeLedger(await ctx.store.loadLedger(ctx.task.id)).committed, 14_000_000n);
    const release = await ctx.store.acquireEngineLock(ctx.task.id);
    await release();
    await ctx.store.update(ctx.task.id, (task) => {
      task.status = "executing";
      task.subtasks[0]!.next_check_at = "2099-01-01T00:00:00Z";
    });
    await ctx.engine.start();
    assert.equal(ctx.engine.isRunningTask(ctx.task.id), true);
  } finally {
    finish();
    await Promise.allSettled(stops);
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

test("a tick from a stopped engine cannot launch work after a restart", { timeout: 20_000 }, async () => {
  const ctx = await setup();
  const load = ctx.store.load.bind(ctx.store);
  let finish!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let ticking: Promise<void> | undefined;
  const started: string[] = [];
  try {
    await ctx.store.update(ctx.task.id, (task) => {
      task.subtasks[0]!.next_check_at = "2099-01-01T00:00:00Z";
    });
    await ctx.engine.start();
    await ctx.store.update(ctx.task.id, (task) => {
      task.subtasks[0]!.next_check_at = null;
    });
    ctx.engine["advance"] = async (_taskId, subtaskId) => {
      started.push(subtaskId);
    };
    ctx.store.load = async (id) => {
      ctx.store.load = load;
      const snapshot = await load(id);
      entered();
      await gate;
      return snapshot;
    };
    ticking = ctx.engine["tick"]();
    await reading;
    await ctx.engine.stop();
    await ctx.engine.start();
    finish();
    await ticking;
    assert.deepEqual(started, [], "the old tick scheduled work for the new engine");
    await ctx.engine["tick"]();
    await ctx.engine.stop();
    assert.deepEqual(started, ["st_1"]);
  } finally {
    finish();
    await ticking;
    ctx.store.load = load;
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

test("cancellation cannot overwrite a task that completed before its update", async () => {
  const ctx = await setup();
  const update = ctx.store.update.bind(ctx.store);
  try {
    ctx.store.update = async (id, mutate, options) => {
      ctx.store.update = update;
      await update(id, (task) => {
        task.status = "completed";
      });
      return update(id, mutate, options);
    };
    await assert.rejects(() => ctx.engine.cancelTask(ctx.task.id, "Cancel"), /already completed/);
    assert.equal((await ctx.store.load(ctx.task.id)).status, "completed");
  } finally {
    ctx.store.update = update;
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

for (const dependencyStatus of ["running_diy", "completed", "failed", "blocked"] as const) {
  test(`scheduler honors dependency state ${dependencyStatus}`, async () => {
    const ctx = await setup();
    try {
      const base = { ...PLAN.subtasks[0], execution: "DIY", planned_max: "0.00", estimated_cost: "0.00" };
      const plan = validatePlan(
        { ...PLAN, external_planned: "0.00", subtasks: [base, { ...base, id: "st_2", dependencies: ["st_1"] }] },
        "16.00",
        "USDC",
        { allowedVerifyCommands: [], contingencyRatio: 0.1 },
      );
      await ctx.store.update(ctx.task.id, (task) => {
        task.status = "planned";
      });
      await ctx.store.installPlan(ctx.task.id, plan, { planApprovalRef: "strategy:autonomous" });
      await ctx.store.update(ctx.task.id, (task) => {
        task.status = "executing";
        task.max_parallel_jobs = 2;
        task.subtasks[0]!.phase = dependencyStatus;
        task.subtasks[0]!.next_check_at = "2099-01-01T00:00:00Z";
      });
      const started: string[] = [];
      ctx.engine["advance"] = async (_taskId, subtaskId) => {
        started.push(subtaskId);
      };
      await ctx.engine.start();
      await ctx.engine.stop();
      assert.deepEqual(started, dependencyStatus === "completed" ? ["st_2"] : []);
    } finally {
      await ctx.engine.stop();
      await cleanup(ctx.dir);
    }
  });
}

for (const board of [false, true]) {
  for (const phase of ["awaiting_hire_approval", "preparing_draft"] as const) {
    test(`missing hiring approval requires a fresh decision (board=${board}, phase=${phase})`, async () => {
      const ctx = await setup({ hiringMode: board ? "board" : "direct" });
      try {
        await selected(ctx, phase);
        await ctx.store.update(ctx.task.id, (task) => {
          const attempt = task.subtasks[0]!.attempts[0]!;
          attempt.approval_ref = "apr_missing";
          if (board) attempt.hiring_mode = "board";
        });
        ctx.market.prepareJob = async () => {
          assert.fail("must not hire without approval");
        };
        ctx.market.postJob = async () => {
          assert.fail("must not publish without approval");
        };
        await ctx.engine[phase === "preparing_draft" ? "prepareHire" : "checkHireApproval"](ctx.task.id, "st_1");
        const state = (await ctx.store.load(ctx.task.id)).subtasks[0]!;
        assert.equal(state.phase, "awaiting_hire_approval");
        assert.notEqual(state.attempts[0]!.approval_ref, "apr_missing");
        assert.equal((await ctx.store.approvals(ctx.task.id).pending()).length, 1);
      } finally {
        await ctx.engine.stop();
        await cleanup(ctx.dir);
      }
    });
  }
}

for (const approvalRef of [null, "apr_missing"]) {
  test(`acceptance cannot proceed with missing approval ${approvalRef}`, async () => {
    const ctx = await setup();
    try {
      await selected(ctx, "awaiting_acceptance_approval");
      await ctx.store.update(ctx.task.id, (task) => {
        const attempt = task.subtasks[0]!.attempts[0]!;
        attempt.acceptance_approval_ref = approvalRef;
        attempt.job_id = "job_test";
        attempt.agreed_price = "14.00";
        attempt.payment_status = "ESCROWED";
        attempt.verification = {
          passed: true,
          status: "passed",
          checked_at: new Date().toISOString(),
          details: "Verified",
          results: [],
          injection_flags: [],
          reviewed_by: "ASH",
        };
      });
      ctx.market.acceptResult = async () => {
        assert.fail("must not accept without approval");
      };
      await ctx.engine["checkAcceptApproval"](ctx.task.id, "st_1");
      const state = (await ctx.store.load(ctx.task.id)).subtasks[0]!;
      assert.equal(state.phase, "awaiting_acceptance_approval");
      assert.notEqual(state.attempts[0]!.acceptance_approval_ref, approvalRef);
      assert.equal((await ctx.store.approvals(ctx.task.id).pending())[0]?.kind, "accept_result");
    } finally {
      await ctx.engine.stop();
      await cleanup(ctx.dir);
    }
  });
}

for (const status of ["paused", "cancelled"] as const) {
  test(`funding that returns during ${status} is recorded before cancellation receipts`, async () => {
    const ctx = await setup({ requireApproval: false });
    let complete!: () => void;
    const release = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let entered!: () => void;
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      await selected(ctx, "preparing_draft");
      ctx.market.prepareJob = async () => {
        entered();
        await release;
        return {
          state: "funded",
          job_id: "job_race",
          assignment_id: "assignment_race",
          job_url: null,
          funded: true,
          amount: "14.00",
          currency: "USDC",
          raw: {},
        };
      };
      await ctx.engine.start();
      await called;
      let cancelling: Promise<void> | undefined;
      if (status === "paused")
        await ctx.store.update(ctx.task.id, (task) => {
          task.status = "paused";
        });
      else {
        cancelling = ctx.engine.cancelTask(ctx.task.id, "cancel during funding");
        await waitFor(async () => (await ctx.store.load(ctx.task.id)).status === "cancelled", { timeoutMs: 5000 });
      }
      complete();
      await cancelling;
      await ctx.engine.stop();
      const task = await ctx.store.load(ctx.task.id);
      assert.equal(task.status, status);
      assert.equal(task.subtasks[0]!.attempts[0]!.job_id, "job_race");
      assert.equal(summarizeLedger(await ctx.store.loadLedger(task.id)).committed, 14_000_000n);
      if (status === "cancelled") {
        const receipt = (await new TransactionLedger(ctx.dir).list())[0]!;
        assert.equal(receipt.payment_status, "REFUND_PENDING");
        assert.equal(receipt.marketplace_job_id, "job_race");
      }
    } finally {
      complete();
      await ctx.engine.stop();
      await cleanup(ctx.dir);
    }
  });
}

test("pro mode uses a draft and rejects a changed quote without charging", async () => {
  const ctx = await setup();
  try {
    ctx.config.market.mode = "pro";
    await selected(ctx, "preparing_draft");
    await ctx.engine["prepareHire"](ctx.task.id, "st_1");
    await approvePending(ctx.store, ctx.task.id, new Set());
    const capabilities = ctx.market.capabilities();
    ctx.market.capabilities = () => ({ ...capabilities, can_create_job: true });
    let chargeCalls = 0;
    ctx.market.createJob = async () => {
      chargeCalls += 1;
      throw new Error("unbounded charging must never be called");
    };
    ctx.market.prepareJob = async () => ({
      state: "draft",
      draft_id: "draft_changed",
      approval_url: "https://example.test/draft",
      quoted_price: "20.00",
      currency: "USDC",
      payable_with: ["USDC"],
      required_connections: [],
      replayed: false,
      raw: {},
    });
    await ctx.engine["prepareHire"](ctx.task.id, "st_1");
    assert.equal(chargeCalls, 0);
    const totals = summarizeLedger(await ctx.store.loadLedger(ctx.task.id));
    assert.equal(totals.committed, 0n);
    assert.equal(totals.paid, 0n);
    assert.equal((await ctx.store.load(ctx.task.id)).subtasks[0]!.attempts[0]!.job_id, null);
  } finally {
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

test("an approval that expires between scheduling and hiring is replaced before the call", async () => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const ctx = await setup();
  try {
    await selected(ctx);
    await ctx.engine["checkHireApproval"](ctx.task.id, "st_1");
    await approvePending(ctx.store, ctx.task.id, new Set());
    await ctx.engine["checkHireApproval"](ctx.task.id, "st_1");
    const before = (await ctx.store.load(ctx.task.id)).subtasks[0]!;
    assert.equal(before.phase, "preparing_draft");
    const file = path.join(ctx.dir, "tasks", ctx.task.id, "approvals.json");
    const data = JSON.parse(await readFile(file, "utf8"));
    for (const request of data.requests) request.expires_at = "2000-01-01T00:00:00Z";
    await writeFile(file, JSON.stringify(data));
    ctx.market.prepareJob = async () => {
      assert.fail("expired approval must not hire");
    };
    await ctx.engine["prepareHire"](ctx.task.id, "st_1");
    const after = (await ctx.store.load(ctx.task.id)).subtasks[0]!;
    assert.equal(after.phase, "awaiting_hire_approval");
    assert.notEqual(after.attempts[0]!.approval_ref, before.attempts[0]!.approval_ref);
    assert.equal((await ctx.store.approvals(ctx.task.id).pending()).length, 1);
  } finally {
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

test("a missing board award approval cannot use plan authority when a gate is required", async () => {
  const ctx = await setup({ hiringMode: "board" });
  try {
    await selected(ctx);
    await ctx.store.update(ctx.task.id, (task) => {
      const attempt = task.subtasks[0]!.attempts[0]!;
      attempt.hiring_mode = "board";
      attempt.job_id = "board_job";
      attempt.bid_id = "bid_1";
      attempt.agreed_price = "14.00";
      attempt.approval_ref = null;
    });
    ctx.market.awardBid = async () => {
      assert.fail("cannot award without approval");
    };
    await ctx.engine["awardApproved"](ctx.task.id, "st_1");
    const request = (await ctx.store.approvals(ctx.task.id).pending())[0]!;
    assert.equal(request.kind, "award");
    assert.equal(request.scope.bid_id, "bid_1");
  } finally {
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

test("funded job details survive a rejected ledger commitment", async () => {
  const ctx = await setup();
  try {
    await selected(ctx, "preparing_draft");
    await ctx.engine["handleFunded"](ctx.task.id, "st_1", {
      jobId: "over_budget_job",
      assignmentId: "assignment",
      jobUrl: null,
      amount: "20.00",
      funded: true,
    });
    const task = await ctx.store.load(ctx.task.id);
    assert.equal(task.status, "paused");
    const attempt = task.subtasks[0]!.attempts[0]!;
    assert.equal(attempt.job_id, "over_budget_job");
    assert.equal(attempt.agreed_price, "20.00");
    assert.equal(attempt.payment_status, "ESCROWED");
    assert.equal(summarizeLedger(await ctx.store.loadLedger(task.id)).committed, 0n);
    assert.match(task.status_detail ?? "", /cannot account/);
  } finally {
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

test("concurrent escrow commits and releases are idempotent", async () => {
  const ctx = await setup();
  try {
    await selected(ctx);
    const attempt = (await ctx.store.load(ctx.task.id)).subtasks[0]!.attempts[0]!;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        ctx.engine["ensureCommit"](ctx.task.id, "st_1", attempt, 14_000_000n, "job:concurrent", "concurrent"),
      ),
    );
    const releases = await Promise.all(
      Array.from({ length: 4 }, () =>
        ctx.engine["ensureRelease"](ctx.task.id, "st_1", attempt, "14.00", "job:concurrent"),
      ),
    );
    assert.ok(releases.every(Boolean));
    const ledger = await ctx.store.loadLedger(ctx.task.id);
    assert.equal(ledger.entries.filter((row) => row.kind === "COMMIT").length, 1);
    assert.equal(ledger.entries.filter((row) => row.kind === "RELEASE").length, 1);
    assert.equal(summarizeLedger(ledger).paid, 14_000_000n);
  } finally {
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

test("refund retries cannot double-refund or report a later full payment", async () => {
  const ctx = await setup();
  try {
    await selected(ctx);
    const attempt = (await ctx.store.load(ctx.task.id)).subtasks[0]!.attempts[0]!;
    await ctx.engine["ensureCommit"](ctx.task.id, "st_1", attempt, 14_000_000n, "job:refund", "refund");
    await Promise.all(Array.from({ length: 4 }, () => ctx.engine["ensureRefund"](ctx.task.id, attempt, "job:refund")));
    assert.equal(await ctx.engine["ensureRelease"](ctx.task.id, "st_1", attempt, "14.00", "job:refund"), false);
    const ledger = await ctx.store.loadLedger(ctx.task.id);
    assert.equal(ledger.entries.filter((row) => row.kind === "REFUND").length, 1);
    assert.equal(summarizeLedger(ledger).paid, 0n);
  } finally {
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});

for (const evidence of [
  { amount: null, currency: "USDC" },
  { amount: "14.00", currency: "USD" },
  { amount: "invalid", currency: "USDC" },
]) {
  test(`funding evidence is retained without guessed accounting (${evidence.currency}/${evidence.amount})`, async () => {
    const ctx = await setup();
    try {
      await selected(ctx, "preparing_draft");
      await ctx.engine["handleFunded"](ctx.task.id, "st_1", {
        jobId: "job_evidence",
        assignmentId: "assignment",
        jobUrl: null,
        funded: true,
        ...evidence,
      });
      const task = await ctx.store.load(ctx.task.id);
      assert.equal(task.status, "paused");
      assert.equal(task.subtasks[0]!.attempts[0]!.job_id, "job_evidence");
      assert.equal(task.subtasks[0]!.attempts[0]!.payment_status, "RECONCILIATION_REQUIRED");
      assert.equal(task.subtasks[0]!.attempts[0]!.funding_evidence?.amount, evidence.amount);
      assert.equal(task.subtasks[0]!.attempts[0]!.funding_evidence?.currency, evidence.currency);
      assert.equal(summarizeLedger(await ctx.store.loadLedger(ctx.task.id)).committed, 0n);
      await ctx.store.update(ctx.task.id, (current) => {
        current.status = "executing";
      });
      await assert.rejects(() => ctx.engine.start(), /needs reconciliation/);
      assert.equal(ctx.engine.isRunning(), false);
    } finally {
      await ctx.engine.stop();
      await cleanup(ctx.dir);
    }
  });
}

test("ambiguous board posting is never repeated after resume", async () => {
  const ctx = await setup({ hiringMode: "board", requireApproval: false });
  let posts = 0;
  try {
    await selected(ctx);
    await ctx.store.update(ctx.task.id, (task) => {
      task.subtasks[0]!.attempts[0]!.hiring_mode = "board";
    });
    // Board publication always requires its explicit approval, even under an autonomous plan.
    await ctx.engine["postBoardApproved"](ctx.task.id, "st_1");
    for (const request of await ctx.store.approvals(ctx.task.id).pending()) {
      await ctx.store.approvals(ctx.task.id).decide(request.id, "approved", `APPROVE ${request.id}`);
    }
    ctx.market.postJob = async () => {
      posts++;
      throw new Error("network timeout after posting");
    };
    await ctx.engine["postBoardApproved"](ctx.task.id, "st_1");
    assert.equal(posts, 1);
    await ctx.store.update(ctx.task.id, (task) => {
      task.status = "executing";
    });
    await ctx.engine["postBoardApproved"](ctx.task.id, "st_1");
    assert.equal(posts, 1);
    assert.equal((await ctx.store.load(ctx.task.id)).status, "paused");
  } finally {
    await ctx.engine.stop();
    await cleanup(ctx.dir);
  }
});
