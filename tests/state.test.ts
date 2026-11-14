import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { TaskStore } from "../src/state/store.js";
import { TaskInputSchema } from "../src/domain/schemas.js";
import { adjustBudget } from "../src/ledger/ledger.js";
import { readDeliveryText } from "../src/engine/helpers.js";
import { sha256Hex } from "../src/util/json.js";
import { tempDir, cleanup, testConfig } from "./helpers.js";

const input = {
  description: "Review state recovery",
  budget: "10.00",
  currency: "USDC" as const,
  deadline: null,
  quality_requirements: null,
  preferred_agents: [],
  execution_strategy: "autonomous" as const,
  allow_external: false,
  diy_first: true,
  require_hiring_approval: true,
  max_parallel_jobs: null,
  additional_instructions: null,
};

test("oversized task collections fail without expanding one error per element", () => {
  const result = TaskInputSchema.safeParse({ ...input, preferred_agents: Array(100_000).fill(null) });
  assert.equal(result.success, false);
  if (!result.success)
    assert.ok(result.error.issues.length < 10, "validation amplified an oversized array into unbounded errors");
});

async function fixture() {
  const dir = await tempDir();
  const config = testConfig(dir);
  const store = new TaskStore(config);
  return { dir, config, store, task: await store.create(input) };
}

test("budget approval races cannot diverge task and ledger", async () => {
  const { dir, store, task } = await fixture();
  try {
    const approvals = store.approvals(task.id);
    const requests = [];
    for (const to of ["20.00", "30.00"]) {
      const request = await approvals.request({
        kind: "budget_increase",
        summary: "Change budget",
        amount: to,
        currency: "USDC",
        scope: { from: "10.00", to, currency: "USDC" },
      });
      await approvals.decide(request.id, "approved", approvals.confirmationPhrase(request));
      requests.push(request);
    }
    const results = await Promise.allSettled(requests.map((request) => store.applyBudgetApproval(task.id, request.id)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const ledger = await store.loadLedger(task.id);
    assert.equal(ledger.entries.length, 2);
    assert.equal((await store.load(task.id)).authorized_budget, ledger.authorized_budget);
  } finally {
    await cleanup(dir);
  }
});

test("ledger budget survives an interrupted task snapshot update", async () => {
  const { dir, store, task } = await fixture();
  try {
    await store.mutateLedger(task.id, (ledger) => adjustBudget(ledger, "20.00", "apr_recovery", "approved change"));
    assert.equal(JSON.parse(await fs.readFile(store.taskFile(task.id), "utf8")).authorized_budget, "10.00");
    assert.equal((await store.load(task.id)).authorized_budget, "20.00");
    await store.update(task.id, (current) => {
      current.status_detail = "recovered";
    });
    assert.equal(JSON.parse(await fs.readFile(store.taskFile(task.id), "utf8")).authorized_budget, "20.00");
  } finally {
    await cleanup(dir);
  }
});

test("a corrupt active task never resolves to an unrelated task", async () => {
  const { dir, store, task } = await fixture();
  try {
    await store.create(input);
    await store.setActive(task.id);
    await fs.writeFile(store.taskFile(task.id), "{}");
    await assert.rejects(() => store.resolveRef("active"), /corrupt|schema/);
    await fs.writeFile(store.paths.activeTaskFile, "../bad\n");
    await assert.rejects(() => store.getActive(), /invalid/);
  } finally {
    await cleanup(dir);
  }
});

test("task identity and workspace paths are validated", async () => {
  const { dir, store, task } = await fixture();
  try {
    const wrong = { ...task, id: "task_another" };
    await fs.writeFile(store.taskFile(task.id), JSON.stringify(wrong));
    await assert.rejects(() => store.load(task.id), /another task/);
    assert.throws(() => store.workspaceDir("../escape"), /Invalid/);
    assert.throws(() => store.deliverablesDir(task.id, "../escape"), /Invalid/);
  } finally {
    await cleanup(dir);
  }
});

test("saved delivery content is checked against its recorded hash", async () => {
  const { dir, config } = await fixture();
  try {
    await fs.writeFile(`${dir}/delivery.md`, "original");
    const delivery = { text_path: "delivery.md", sha256: sha256Hex("original") };
    assert.equal(await readDeliveryText(config, delivery), "original");
    await fs.writeFile(`${dir}/delivery.md`, "changed");
    await assert.rejects(() => readDeliveryText(config, delivery), /hash|integrity|changed/i);
  } finally {
    await cleanup(dir);
  }
});

test("an aged engine lease is not stolen from a live process", async () => {
  const { dir, store, task } = await fixture();
  const release = await store.acquireEngineLock(task.id);
  try {
    const past = new Date(Date.now() - 300_000);
    await fs.utimes(`${store.taskDir(task.id)}/engine.lock`, past, past);
    await assert.rejects(() => store.acquireEngineLock(task.id), /already being executed/);
  } finally {
    await release();
    await cleanup(dir);
  }
});
