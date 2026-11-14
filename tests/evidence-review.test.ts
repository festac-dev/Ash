import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TaskStore } from "../src/state/store.js";
import { TaskInputSchema } from "../src/domain/schemas.js";
import type { DeliveryRecord, SubtaskPlan } from "../src/domain/types.js";
import { ExecutionEngine } from "../src/engine/engine.js";
import { SimulatedMarketAdapter } from "../src/market/simulated-adapter.js";
import { DeliverableVerifier } from "../src/ai/verifier.js";
import { DemoModel } from "../src/ai/model.js";
import { collectDeliveryEvidence } from "../src/engine/evidence.js";
import { sha256Hex, hashJson } from "../src/util/json.js";
import { AshError } from "../src/errors.js";
import { testConfig, tempDir, cleanup } from "./helpers.js";

const subtask: SubtaskPlan = {
  id: "st_report",
  title: "Write a report",
  description: "Provide the complete report as text.",
  execution: "EXTERNAL",
  dependencies: [],
  complexity: "low",
  skills: [],
  deliverable: "A complete text report",
  acceptance_criteria: [{ kind: "deliverable_present", description: "A substantive report exists", min_chars: 5 }],
  planned_max: "1.00",
  estimated_cost: "1.00",
  rationale: "Independent provider report.",
};
async function fixture(legacy = false, approved = true) {
  const dir = await tempDir("ash-evidence-review-");
  const config = testConfig(dir);
  const store = new TaskStore(config);
  const task = await store.create(
    TaskInputSchema.parse({
      description: "Review actual report and exact approval",
      budget: "10.00",
      currency: "USDC",
      execution_strategy: "autonomous",
      require_hiring_approval: true,
    }),
  );
  await store.installPlan(
    task.id,
    {
      schema_version: 1,
      summary: "Obtain and review a single report",
      final_outcome: "A reviewed complete report",
      assumptions: [],
      risks: [],
      currency: "USDC",
      authorized_budget: "10.00",
      contingency: "1.00",
      external_planned: "1.00",
      subtasks: [subtask],
    },
    { planApprovalRef: "strategy:autonomous" },
  );
  await store.update(task.id, (current) => {
    current.status = "executing";
  });
  const workspace = path.join(dir, "workspaces", task.id, subtask.id, "attempt-1");
  await fs.mkdir(workspace, { recursive: true });
  const text = "Here is the report. The correct value is 42.";
  const relative = `tasks/${task.id}/deliverables/${subtask.id}/attempt-1.md`;
  await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
  await fs.writeFile(path.join(dir, relative), text);
  await fs.writeFile(path.join(workspace, "answer.txt"), "42");
  const delivery: DeliveryRecord = {
    text_path: relative,
    files: [{ path: "answer.txt", filename: "answer.txt", bytes: 2, sha256: sha256Hex("42") }],
    external_url: null,
    received_at: new Date().toISOString(),
    source: "fixture",
    sha256: sha256Hex(text),
    suspicious: false,
    injection_signals: [],
    truncated: false,
  };
  const market = new SimulatedMarketAdapter(config, { latencyMs: 0 });
  await market.connect();
  const engine = new ExecutionEngine({ config, store, market, model: new DemoModel() });
  await engine["beginAttempt"](task.id, subtask.id, "EXTERNAL");
  const verification = await new DeliverableVerifier(config, new DemoModel()).verify({
    task: await store.load(task.id),
    subtask,
    delivery,
    deliveryText: text,
    workspace,
  });
  if (legacy) {
    verification.evidence_version = 1;
    delete verification.evidence_hash;
  }
  const manager = store.approvals(task.id);
  const approval = await manager.request({
    kind: "accept_result",
    summary: "Accept the inspected report",
    amount: "1.00",
    currency: "USDC",
    scope: {
      subtask_id: subtask.id,
      job_id: "job_fixture",
      amount: "1.00",
      currency: "USDC",
      verification_hash: hashJson(verification),
    },
  });
  if (approved) await manager.decide(approval.id, "approved", manager.confirmationPhrase(approval));
  await store.update(task.id, (current) => {
    const state = current.subtasks[0]!,
      attempt = state.attempts[0]!;
    state.phase = "awaiting_acceptance_approval";
    Object.assign(attempt, {
      job_id: "job_fixture",
      agreed_price: "1.00",
      payment_status: "ESCROWED",
      delivery,
      verification,
      acceptance_approval_ref: approval.id,
    });
  });
  let acceptCalls = 0;
  market.acceptResult = async () => {
    acceptCalls++;
    throw new AshError("MARKET_REFUSED", "Fixture intercepts acceptance without a provider effect.");
  };
  return {
    dir,
    config,
    store,
    task,
    workspace,
    text,
    delivery,
    verification,
    manager,
    approval,
    engine,
    market,
    acceptCalls: () => acceptCalls,
    close: async () => {
      await engine.stop();
      await market.disconnect();
      await cleanup(dir);
    },
  };
}

test("substring, empty and identical attachment contents always retain file identity", async () => {
  const c = await fixture();
  try {
    const contents = [
      { path: "answer.txt", content: "0" },
      { path: "empty.txt", content: "" },
      { path: "same.txt", content: "0" },
    ];
    for (const file of contents) await fs.writeFile(path.join(c.workspace, file.path), file.content);
    const delivery = {
      ...c.delivery,
      files: contents.map((file) => ({
        path: file.path,
        filename: file.path,
        bytes: file.content.length,
        sha256: sha256Hex(file.content),
      })),
    };
    const evidence = await collectDeliveryEvidence(delivery, c.workspace, "The final answer is 10.");
    for (const file of contents) assert.ok(evidence.text.includes(`Artifact "${file.path}"`));
    assert.match(evidence.text, /1 characters:\n0/);
    assert.match(evidence.text, /0 characters:/);
    assert.deepEqual(evidence.issues, []);
  } finally {
    await c.close();
  }
});

test("long duplicate bodies are stored once without dropping either file mapping", async () => {
  const c = await fixture();
  try {
    const content = "A complete reviewed line of report data. ".repeat(15);
    const files = ["one.txt", "two.txt"];
    for (const file of files) await fs.writeFile(path.join(c.workspace, file), content);
    const evidence = await collectDeliveryEvidence(
      {
        ...c.delivery,
        files: files.map((file) => ({
          path: file,
          filename: file,
          bytes: Buffer.byteLength(content),
          sha256: sha256Hex(content),
        })),
      },
      c.workspace,
      `Report follows: ${content}`,
    );
    assert.equal(evidence.text.split(content).length - 1, 1);
    for (const file of files) assert.ok(evidence.text.includes(`Artifact "${file}"`));
    assert.deepEqual(evidence.issues, []);
  } finally {
    await c.close();
  }
});

for (const change of ["attachment", "cover", "manifest", "missing", "oversized"] as const) {
  test(`cached acceptance refuses changed ${change} and retires its approval`, async () => {
    const c = await fixture();
    try {
      if (change === "cover") await fs.writeFile(path.join(c.dir, c.delivery.text_path!), "corrupted cover");
      else if (change === "manifest")
        await c.store.update(c.task.id, (task) => {
          task.subtasks[0]!.attempts[0]!.delivery!.files[0]!.filename = "changed-name.txt";
        });
      else if (change === "missing") await fs.rm(path.join(c.workspace, "answer.txt"));
      else
        await fs.writeFile(
          path.join(c.workspace, "answer.txt"),
          change === "oversized" ? Buffer.alloc(2 * 1024 * 1024 + 1) : "CORRUPTED",
        );
      await c.engine["checkAcceptApproval"](c.task.id, subtask.id);
      const state = (await c.store.load(c.task.id)).subtasks[0]!;
      assert.equal(c.acceptCalls(), 0);
      assert.equal(state.phase, "awaiting_human_review");
      assert.equal(state.attempts[0]!.verification!.passed, false);
      assert.equal(state.attempts[0]!.acceptance_approval_ref, null);
      const old = await c.manager.get(c.approval.id);
      assert.equal(old?.status, "approved");
      assert.ok(old?.superseded_at);
      await assert.rejects(() => c.manager.assertApproved(c.approval.id, "accept_result"), /superseded/);
    } finally {
      await c.close();
    }
  });
}

test("unchanged cached evidence accepts without another model request", async () => {
  const c = await fixture();
  try {
    c.engine["verifier"].verify = async () => {
      throw new Error("Should reuse existing judgment");
    };
    await c.engine["checkAcceptApproval"](c.task.id, subtask.id);
    assert.equal(c.acceptCalls(), 1);
    assert.equal((await c.manager.get(c.approval.id))?.superseded_at, undefined);
  } finally {
    await c.close();
  }
});

for (const approved of [true, false]) {
  test(`legacy review with ${approved ? "approved" : "pending"} authority offers one fresh explicit decision`, async () => {
    const c = await fixture(true, approved);
    try {
      await c.engine["verifyAttempt"](c.task.id, subtask.id);
      const task = await c.store.load(c.task.id),
        attempt = task.subtasks[0]!.attempts[0]!;
      assert.equal(task.status, "executing");
      assert.equal(task.subtasks[0]!.phase, "awaiting_acceptance_approval");
      assert.equal(attempt.verification!.evidence_version, 2);
      assert.match(attempt.verification!.evidence_hash!, /^[a-f0-9]{64}$/);
      const pending = await c.manager.pending();
      assert.equal(pending.length, 1);
      assert.notEqual(pending[0]!.id, c.approval.id);
      assert.equal(pending[0]!.scope.verification_hash, hashJson(attempt.verification));
      assert.ok((await c.manager.get(c.approval.id))?.superseded_at);
      assert.equal(c.acceptCalls(), 0);
      await c.engine["checkAcceptApproval"](c.task.id, subtask.id);
      assert.equal((await c.manager.pending()).length, 1);
      assert.equal(c.acceptCalls(), 0);
      await c.manager.decide(pending[0]!.id, "approved", c.manager.confirmationPhrase(pending[0]!));
      await c.engine["checkAcceptApproval"](c.task.id, subtask.id);
      assert.equal(c.acceptCalls(), 1);
    } finally {
      await c.close();
    }
  });
}
