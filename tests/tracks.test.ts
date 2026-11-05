import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT,
  SCOPES,
  getScope,
  isProjectId,
  projectPromptBlock,
  resolveScopes,
  scopeInputKey,
  trackPromptBlock,
  validateProjectInputs,
  validateScopeInputs,
} from "../src/tracks.js";
import { TaskStore } from "../src/state/store.js";
import type { TaskInput } from "../src/domain/types.js";
import { AshError } from "../src/errors.js";
import { tempDir, cleanup, testConfig } from "./helpers.js";

function taskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    description: "Build the real-world money showcase",
    budget: "50.00",
    currency: "USDC",
    deadline: null,
    quality_requirements: null,
    preferred_agents: [],
    execution_strategy: "plan_then_approve",
    allow_external: true,
    diy_first: true,
    require_hiring_approval: true,
    max_parallel_jobs: null,
    additional_instructions: null,
    ...overrides,
  };
}

test("Ash is one project containing the six hackathon workstreams", () => {
  assert.equal(PROJECT.id, "ash");
  assert.equal(PROJECT.name, "Ash");
  assert.equal(isProjectId("ash"), true);
  assert.equal(isProjectId("all"), true);
  assert.equal(isProjectId("realworld"), false);
  assert.deepEqual(
    PROJECT.scopes.map((scope) => scope.id),
    ["realworld", "business", "security", "privacy", "swarms", "social"],
  );
  assert.deepEqual(
    SCOPES.map((scope) => scope.id),
    PROJECT.scopes.map((scope) => scope.id),
  );
  assert.ok(PROJECT.buildOrder.length >= PROJECT.scopes.length);
  assert.ok(PROJECT.approvalGate.includes("explicit OK"));
  assert.ok(PROJECT.constraints.length >= PROJECT.scopes.length);
  assert.deepEqual(
    resolveScopes("ash", null).map((scope) => scope.id),
    PROJECT.scopes.map((scope) => scope.id),
  );
  assert.deepEqual(
    resolveScopes("ash", ["privacy"]).map((scope) => scope.id),
    ["privacy"],
  );
});

test("workstreams expose their approval gate, build order and inputs", () => {
  const realworld = getScope("realworld");
  assert.ok(realworld);
  assert.equal(scopeInputKey(realworld!, "network"), "realworld.network");
  assert.match(realworld!.approvalGate ?? "", /explicit OK/i);
  assert.ok(
    trackPromptBlock(realworld!, { network: "testnet", settlement_asset: "USDC on NEAR" }).includes(
      "MANDATORY BUILD ORDER",
    ),
  );
  assert.deepEqual(validateScopeInputs(realworld!, {}), ["Network is required", "Settlement asset is required"]);
  assert.deepEqual(validateScopeInputs(realworld!, { network: "testnet", settlement_asset: "USDC on NEAR" }), []);
});

test("the unified project validates scope-prefixed inputs", () => {
  const realworld = getScope("realworld");
  const security = getScope("security");
  assert.ok(realworld && security);
  const missing = validateProjectInputs([realworld!, security!], {});
  assert.ok(missing.some((error) => error.includes("Real-World Money: Network is required")));
  assert.ok(missing.some((error) => error.includes("AI Security & Defense: Target chain is required")));
  assert.deepEqual(
    validateProjectInputs([realworld!], {
      "realworld.network": "testnet",
      "realworld.settlement_asset": "USDC on NEAR",
    }),
    [],
  );
  const block = projectPromptBlock([realworld!], {
    "realworld.network": "testnet",
    "realworld.settlement_asset": "USDC on NEAR",
  });
  assert.match(block, /PROJECT: Ash/);
  assert.match(block, /WORKSTREAMS IN SCOPE/);
  assert.match(block, /1Click/);
  assert.match(block, /realworld\.network: testnet/);
  assert.match(block, /explicit OK/i);
});

test("task creation refuses missing or invalid project inputs", async () => {
  const dir = await tempDir();
  try {
    const store = new TaskStore(testConfig(dir));
    await assert.rejects(
      () =>
        store.create(
          taskInput({
            track_id: "ash",
            project_scopes: ["realworld"],
            track_inputs: {},
          }),
        ),
      (error: unknown) =>
        error instanceof AshError && error.code === "VALIDATION_FAILED" && /invalid or missing/i.test(error.message),
    );
    await assert.rejects(
      () =>
        store.create(
          taskInput({
            track_id: "ash",
            project_scopes: ["business"],
            track_inputs: {
              "business.treasury_account": "shop.testnet",
              "business.daily_inference_limit": "5.00",
              "business.revenue_split": "100% treasury",
              "business.kill_switch": "stop",
              "business.api_key": "sk-secret123456789",
            },
          }),
        ),
      /secret/i,
    );
    await assert.rejects(
      () =>
        store.create(
          taskInput({
            track_id: "ash",
            project_scopes: ["nope"],
            track_inputs: {},
          }),
        ),
      /Unknown project workstream/i,
    );
  } finally {
    await cleanup(dir);
  }
});

test("the unified project and its selected workstreams are persisted", async () => {
  const dir = await tempDir();
  try {
    const store = new TaskStore(testConfig(dir));
    const task = await store.create(
      taskInput({
        track_id: "ash",
        project_scopes: ["realworld", "security"],
        track_inputs: {
          "realworld.network": "testnet",
          "realworld.settlement_asset": "USDC on NEAR",
          "security.target_chain": "NEAR testnet",
          "security.fail_mode": "BLOCK",
          "security.policy_thresholds": "block below 0.8 confidence",
        },
      }),
    );
    assert.equal(task.track_id, "ash");
    assert.deepEqual(task.project_scopes, ["realworld", "security"]);
    assert.equal(task.track_inputs["realworld.network"], "testnet");
    assert.equal(task.track_inputs["security.fail_mode"], "BLOCK");
  } finally {
    await cleanup(dir);
  }
});

test("legacy single-workstream tasks remain readable", async () => {
  const dir = await tempDir();
  try {
    const store = new TaskStore(testConfig(dir));
    const task = await store.create(
      taskInput({
        track_id: "realworld",
        track_inputs: { network: "testnet", settlement_asset: "USDC on NEAR" },
      }),
    );
    assert.equal(task.track_id, "realworld");
    assert.deepEqual(task.project_scopes, ["realworld"]);
    assert.deepEqual(
      resolveScopes(task.track_id, task.project_scopes).map((scope) => scope.id),
      ["realworld"],
    );
  } finally {
    await cleanup(dir);
  }
});

test("planner context carries every selected workstream and gate", async () => {
  const dir = await tempDir();
  try {
    const store = new TaskStore(testConfig(dir));
    const task = await store.create(
      taskInput({
        track_id: "ash",
        project_scopes: ["realworld", "privacy"],
        track_inputs: {
          "realworld.network": "testnet",
          "realworld.settlement_asset": "USDC on NEAR",
          "privacy.model": "tee-model",
          "privacy.attestation_endpoint": "https://cloud-api.near.ai/v1/attestation",
          "privacy.retention_mode": "no-server-side-persistence",
        },
      }),
    );
    const { buildPlannerMessages } = await import("../src/ai/prompts.js");
    const messages = buildPlannerMessages(task);
    const text = messages.map((message) => message.content).join("\n");
    assert.match(text, /PROJECT: Ash/);
    assert.match(text, /WORKSTREAMS IN SCOPE/);
    assert.match(text, /MANDATORY BUILD ORDER/);
    assert.match(text, /1Click/);
    assert.match(text, /attestation/i);
    assert.match(text, /APPROVAL GATES/);
    assert.match(text, /explicit OK/i);
    assert.match(text, /realworld\.network: testnet/);
    assert.match(text, /privacy\.retention_mode: no-server-side-persistence/);
  } finally {
    await cleanup(dir);
  }
});

test("simulation plans include a human-approval criterion for every selected gate", async () => {
  const dir = await tempDir();
  try {
    const store = new TaskStore(testConfig(dir));
    const task = await store.create(
      taskInput({
        track_id: "ash",
        project_scopes: ["realworld", "privacy"],
        track_inputs: {
          "realworld.network": "testnet",
          "realworld.settlement_asset": "USDC on NEAR",
          "privacy.model": "tee-model",
          "privacy.attestation_endpoint": "https://cloud-api.near.ai/v1/attestation",
          "privacy.retention_mode": "no-server-side-persistence",
        },
      }),
    );
    const [{ buildPlannerMessages }, { DemoModel }] = await Promise.all([
      import("../src/ai/prompts.js"),
      import("../src/ai/model.js"),
    ]);
    const response = await new DemoModel().complete(buildPlannerMessages(task));
    const plan = JSON.parse(response.text) as {
      subtasks: Array<{ acceptance_criteria: Array<{ kind: string; description: string }> }>;
    };
    const gates = plan.subtasks
      .flatMap((subtask) => subtask.acceptance_criteria)
      .filter((criterion) => criterion.kind === "human_approval")
      .map((criterion) => criterion.description);
    assert.ok(gates.some((description) => description.includes("[realworld]")));
    assert.ok(gates.some((description) => description.includes("[privacy]")));
  } finally {
    await cleanup(dir);
  }
});

test("installed plans must retain workstream gates and honor disabled hiring", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig(dir);
    const store = new TaskStore(config);
    const task = await store.create(
      taskInput({ track_id: "realworld", track_inputs: { network: "testnet", settlement_asset: "USDC" } }),
    );
    const { TaskPlanner } = await import("../src/ai/planner.js");
    const { DemoModel } = await import("../src/ai/model.js");
    const { plan } = await new TaskPlanner(config, new DemoModel()).plan(task);
    const missingGate = structuredClone(plan);
    for (const subtask of missingGate.subtasks)
      subtask.acceptance_criteria = subtask.acceptance_criteria.filter((c) => c.kind !== "human_approval");
    await assert.rejects(() => store.installPlan(task.id, missingGate), /Workstream approval gate/);
    await store.update(task.id, (current) => {
      current.allow_external = false;
    });
    await assert.rejects(() => store.installPlan(task.id, plan), /External hiring is disabled/);
    assert.equal((await store.load(task.id)).plan, null);
  } finally {
    await cleanup(dir);
  }
});
