import { AshError } from "../errors.js";
import type { Plan, SubtaskPlan, SubtaskState, TaskRecord } from "./types.js";
import { PlannerOutputSchema, PlanSchema, TaskRecordSchema } from "./schemas.js";
import { formatMinor, parseAmount, percentOf, type Minor } from "../util/money.js";
import { nowIso } from "../util/time.js";
import { resolveScopes } from "../tracks.js";

/** Task preferences and workstream sign-offs apply to imported and model plans alike. */
export function validateTaskPlan(plan: Plan, task: TaskRecord): void {
  if (!task.allow_external && plan.subtasks.some((subtask) => subtask.execution === "EXTERNAL")) {
    throw new AshError("VALIDATION_FAILED", "External hiring is disabled, but the plan contains EXTERNAL subtasks.");
  }
  for (const scope of resolveScopes(task.track_id, task.project_scopes)) {
    if (!scope.approvalGate) continue;
    const marker = `Workstream approval gate [${scope.id}]:`;
    if (
      !plan.subtasks.some((subtask) =>
        subtask.acceptance_criteria.some(
          (criterion) =>
            criterion.kind === "human_approval" &&
            criterion.description.startsWith(marker) &&
            criterion.description.slice(marker.length).trim(),
        ),
      )
    ) {
      throw new AshError(
        "VALIDATION_FAILED",
        `The plan must include a human_approval criterion beginning "${marker}" for the ${scope.name} milestone.`,
      );
    }
  }
}

export function assemblePlan(
  raw: unknown,
  currency: Plan["currency"],
  authorizedBudget: string,
  fallbackAssumptions: string[] = [],
): Plan {
  const planner = PlannerOutputSchema.parse(raw);
  const subtasks: SubtaskPlan[] = planner.subtasks.map((subtask) => ({
    ...subtask,
    dependencies: [...new Set(subtask.dependencies)],
    skills: [...new Set(subtask.skills.map((skill) => skill.trim()).filter(Boolean))],
    acceptance_criteria: subtask.acceptance_criteria,
  }));
  const external = subtasks
    .filter((subtask) => subtask.execution === "EXTERNAL")
    .reduce((total, subtask) => total + parseAmount(subtask.planned_max, currency), 0n);

  return {
    schema_version: 1,
    summary: planner.summary,
    final_outcome: planner.final_outcome,
    assumptions: [...new Set([...planner.assumptions, ...fallbackAssumptions])],
    risks: planner.risks,
    currency,
    authorized_budget: authorizedBudget,
    contingency: planner.contingency,
    external_planned: formatMinor(external, currency),
    subtasks,
  };
}

export interface PlanValidationOptions {
  allowedVerifyCommands: readonly string[];
  contingencyRatio: number;
}

/** Validate a plan structurally, topologically, and against the budget. */
export function validatePlan(
  rawPlan: unknown,
  taskAuthorizedBudget: string,
  currency: Plan["currency"],
  options: PlanValidationOptions,
): Plan {
  let plan: Plan;
  try {
    plan = PlanSchema.parse(rawPlan) as Plan;
  } catch (error) {
    throw new AshError("VALIDATION_FAILED", "The execution plan is invalid.", { cause: error });
  }

  if (plan.currency !== currency) {
    throw new AshError("VALIDATION_FAILED", `Plan currency ${plan.currency} does not match task currency ${currency}.`);
  }
  const authorized = parseAmount(taskAuthorizedBudget, currency);
  const planAuthorized = parseAmount(plan.authorized_budget, currency);
  if (planAuthorized > authorized) {
    throw new AshError(
      "BUDGET_EXCEEDED",
      `Plan was built for ${formatMinor(planAuthorized, currency)} ${currency}, above the authorized ${formatMinor(authorized, currency)}.`,
    );
  }

  const ids = new Set<string>();
  for (const subtask of plan.subtasks) {
    if (ids.has(subtask.id)) {
      throw new AshError("VALIDATION_FAILED", `Duplicate subtask id "${subtask.id}" in plan.`);
    }
    ids.add(subtask.id);
  }

  for (const subtask of plan.subtasks) {
    const planned = parseAmount(subtask.planned_max, currency);
    const estimate = parseAmount(subtask.estimated_cost, currency);
    if (subtask.execution === "DIY" && planned !== 0n) {
      throw new AshError("VALIDATION_FAILED", `DIY subtask "${subtask.id}" must have planned_max 0.`);
    }
    if (subtask.execution === "EXTERNAL" && planned === 0n) {
      throw new AshError("VALIDATION_FAILED", `External subtask "${subtask.id}" needs a positive planned_max.`);
    }
    if (estimate > planned) {
      throw new AshError(
        "VALIDATION_FAILED",
        `Subtask "${subtask.id}" estimates ${subtask.estimated_cost} above its planned maximum ${subtask.planned_max}.`,
      );
    }
    for (const dependency of subtask.dependencies) {
      if (dependency === subtask.id) {
        throw new AshError("VALIDATION_FAILED", `Subtask "${subtask.id}" cannot depend on itself.`);
      }
      if (!ids.has(dependency)) {
        throw new AshError("VALIDATION_FAILED", `Subtask "${subtask.id}" depends on unknown subtask "${dependency}".`);
      }
    }
    for (const criterion of subtask.acceptance_criteria) {
      if (criterion.kind === "test_command" && !options.allowedVerifyCommands.includes(criterion.command)) {
        throw new AshError(
          "VALIDATION_FAILED",
          `Acceptance criterion for "${subtask.id}" runs a command that is not in ASH_VERIFY_COMMANDS.`,
        );
      }
    }
  }

  detectCycle(plan);

  const external = plan.subtasks
    .filter((subtask) => subtask.execution === "EXTERNAL")
    .reduce((total, subtask) => total + parseAmount(subtask.planned_max, currency), 0n);
  const declaredExternal = parseAmount(plan.external_planned, currency);
  if (external !== declaredExternal) {
    throw new AshError(
      "VALIDATION_FAILED",
      `Plan external_planned is ${plan.external_planned} but its subtasks total ${formatMinor(external, currency)}.`,
    );
  }
  const contingency = parseAmount(plan.contingency, currency);
  if (external + contingency > authorized) {
    throw new AshError(
      "BUDGET_EXCEEDED",
      `Plan commits ${formatMinor(external + contingency, currency)} ${currency}, above the authorized ${formatMinor(authorized, currency)}.`,
    );
  }
  if (external > 0n) {
    const requiredReserve = percentOf(authorized, options.contingencyRatio);
    if (contingency < requiredReserve) {
      throw new AshError(
        "VALIDATION_FAILED",
        `Plan reserves ${formatMinor(contingency, currency)} but policy requires at least ${formatMinor(requiredReserve, currency)} (${Math.round(options.contingencyRatio * 100)}%).`,
      );
    }
  }

  return plan;
}

export function detectCycle(plan: Plan): void {
  const byId = new Map(plan.subtasks.map((subtask) => [subtask.id, subtask]));
  const state = new Map<string, 0 | 1 | 2>();

  const visit = (id: string, trail: string[]): void => {
    const current = state.get(id) ?? 0;
    if (current === 1) {
      throw new AshError("VALIDATION_FAILED", `Dependency cycle detected: ${[...trail, id].join(" → ")}`);
    }
    if (current === 2) return;
    state.set(id, 1);
    const subtask = byId.get(id);
    for (const dependency of subtask?.dependencies ?? []) {
      visit(dependency, [...trail, id]);
    }
    state.set(id, 2);
  };

  for (const subtask of plan.subtasks) visit(subtask.id, []);
}

export interface Readiness {
  ready: SubtaskState[];
  blocked: Array<{ state: SubtaskState; reason: string }>;
}

/** Subtasks whose dependencies have all completed and that are not terminal. */
export function computeReadiness(task: TaskRecord, plan: Plan): Readiness {
  const states = new Map(task.subtasks.map((state) => [state.id, state]));
  const ready: SubtaskState[] = [];
  const blocked: Array<{ state: SubtaskState; reason: string }> = [];
  for (const subtask of plan.subtasks) {
    const state = states.get(subtask.id);
    if (!state) continue;
    if (["completed", "failed", "cancelled"].includes(state.phase)) continue;
    const unmet: string[] = [];
    const failedDeps: string[] = [];
    for (const dependency of subtask.dependencies) {
      const dep = states.get(dependency);
      if (!dep) {
        failedDeps.push(dependency);
      } else if (dep.phase === "completed") {
        continue;
      } else if (dep.phase === "failed" || dep.phase === "cancelled" || dep.phase === "blocked") {
        failedDeps.push(dependency);
      } else {
        unmet.push(dependency);
      }
    }
    if (failedDeps.length > 0) {
      blocked.push({ state, reason: `dependency ${failedDeps.join(", ")} did not complete` });
    } else if (unmet.length === 0) {
      if (state.phase === "pending" || state.phase === "ready") ready.push(state);
    }
  }
  return { ready, blocked };
}

export function assertTaskConsistency(rawTask: unknown): TaskRecord {
  const task = TaskRecordSchema.parse(rawTask) as TaskRecord;
  if (!task.plan) {
    if (task.subtasks.length > 0) {
      throw new AshError("STATE_INVALID", "Task has subtask state but no plan.");
    }
    return task;
  }
  const planIds = new Set(task.plan.subtasks.map((subtask) => subtask.id));
  const stateIds = new Set(task.subtasks.map((state) => state.id));
  if (
    planIds.size !== stateIds.size ||
    planIds.size !== task.plan.subtasks.length ||
    stateIds.size !== task.subtasks.length
  ) {
    throw new AshError("STATE_INVALID", "Task subtask state does not match its plan.");
  }
  for (const id of planIds) {
    if (!stateIds.has(id)) throw new AshError("STATE_INVALID", `Missing state for subtask "${id}".`);
  }
  for (const state of task.subtasks) {
    if (!planIds.has(state.id)) throw new AshError("STATE_INVALID", `State for unknown subtask "${state.id}".`);
    if (
      state.attempts.some((attempt, index) => attempt.attempt !== index + 1) ||
      state.active_attempt !== state.attempts.length
    ) {
      throw new AshError("STATE_INVALID", `Subtask "${state.id}" points at a missing attempt.`);
    }
  }
  return task;
}

export function externalPlanned(task: TaskRecord): Minor {
  if (!task.plan) return 0n;
  return task.plan.subtasks
    .filter((subtask) => subtask.execution === "EXTERNAL")
    .reduce((total, subtask) => total + parseAmount(subtask.planned_max, task.currency), 0n);
}

export function remainingExternalPlanned(task: TaskRecord): Minor {
  if (!task.plan) return 0n;
  const states = new Map(task.subtasks.map((state) => [state.id, state]));
  return task.plan.subtasks
    .filter((subtask) => subtask.execution === "EXTERNAL")
    .filter((subtask) => {
      const state = states.get(subtask.id);
      return state && !["completed", "failed", "cancelled"].includes(state.phase);
    })
    .reduce((total, subtask) => total + parseAmount(subtask.planned_max, task.currency), 0n);
}

export function subtaskById(task: TaskRecord, id: string): SubtaskPlan {
  const subtask = task.plan?.subtasks.find((candidate) => candidate.id === id);
  if (!subtask) throw new AshError("NOT_FOUND", `Subtask "${id}" is not in the plan.`);
  return subtask;
}

export function stateById(task: TaskRecord, id: string): SubtaskState {
  const state = task.subtasks.find((candidate) => candidate.id === id);
  if (!state) throw new AshError("NOT_FOUND", `Subtask state "${id}" does not exist.`);
  return state;
}

export function initialSubtaskStates(plan: Plan): SubtaskState[] {
  const at = nowIso();
  return plan.subtasks.map((subtask) => ({
    id: subtask.id,
    phase: subtask.dependencies.length === 0 ? "ready" : "pending",
    attempts: [],
    active_attempt: 0,
    receipt_id: null,
    last_error: null,
    blocked_reason: null,
    started_at: null,
    completed_at: null,
    updated_at: at,
    next_check_at: null,
  }));
}

export function validateBudgetChange(
  newAuthorizedRaw: string,
  currency: Plan["currency"],
  committed: Minor,
  paid: Minor,
): Minor {
  const next = parseAmount(newAuthorizedRaw, currency);
  if (next <= 0n) {
    throw new AshError("VALIDATION_FAILED", "The authorized budget must stay greater than zero.");
  }
  if (next < committed + paid) {
    throw new AshError(
      "BUDGET_INVARIANT",
      `The new budget ${formatMinor(next, currency)} is below already committed and paid funds (${formatMinor(committed + paid, currency)}).`,
    );
  }
  return next;
}
