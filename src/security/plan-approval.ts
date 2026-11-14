import path from "node:path";
import { AshError, isAshError } from "../errors.js";
import type { ApprovalRequest, TaskRecord } from "../domain/types.js";
import type { TaskStore } from "../state/store.js";
import { hashJson } from "../util/json.js";
import { withFileLock } from "../util/fs.js";
import { clip } from "../util/strings.js";

function assertReviewable(task: TaskRecord, allowExecuting = false): void {
  if (["completed", "failed", "cancelled"].includes(task.status) || (task.status === "executing" && !allowExecuting)) {
    throw new AshError("CONFLICT", `Task is ${task.status}; its plan cannot be approved or renewed.`);
  }
  if (!task.plan) throw new AshError("STATE_INVALID", "Task has no plan to approve.");
}

export function assertPlanDecisionApplies(task: TaskRecord, request: ApprovalRequest): void {
  assertReviewable(task);
  if (
    request.kind !== "plan" ||
    request.scope.plan_hash !== hashJson(task.plan) ||
    request.currency !== task.currency ||
    request.scope.currency !== task.currency
  ) {
    throw new AshError(
      "APPROVAL_INVALID",
      "The plan changed after this approval was requested. Request a fresh decision.",
    );
  }
}

/** Renew authorization for the persisted plan without replacing its subtasks or attempts. */
export async function ensurePlanApproval(
  store: TaskStore,
  taskId: string,
  options: { allowExecuting?: boolean } = {},
): Promise<{ task: TaskRecord; approval: ApprovalRequest | null }> {
  return withFileLock(path.join(store.taskDir(taskId), "plan-approval.lock"), async () => {
    const task = await store.load(taskId);
    assertReviewable(task, options.allowExecuting);
    if (task.execution_strategy === "autonomous") return { task, approval: null };
    const plan = task.plan!;
    const planHash = hashJson(plan);
    const manager = store.approvals(task.id);
    try {
      await manager.assertApproved(task.plan_approval_ref, "plan", { plan_hash: planHash, currency: task.currency });
      return { task, approval: null };
    } catch (error) {
      if (!isAshError(error) || !["APPROVAL_REQUIRED", "APPROVAL_INVALID"].includes(error.code)) throw error;
    }
    const pending = await manager.pending();
    const approval =
      pending.find(
        (candidate) =>
          candidate.kind === "plan" &&
          candidate.scope.plan_hash === planHash &&
          candidate.currency === task.currency &&
          candidate.scope.currency === task.currency,
      ) ??
      (await manager.request({
        kind: "plan",
        summary: `Approve the execution plan for "${clip(task.description, 120)}" — ${plan.subtasks.length} subtasks, ${plan.external_planned} ${task.currency} external work, ${plan.contingency} reserve. Existing progress will be preserved.`,
        amount: plan.external_planned,
        currency: task.currency,
        scope: {
          plan_hash: planHash,
          currency: task.currency,
          subtasks: String(plan.subtasks.length),
          external_planned: plan.external_planned,
          contingency: plan.contingency,
        },
      }));
    const updated = await store.update(task.id, (current) => {
      assertReviewable(current, options.allowExecuting);
      if (hashJson(current.plan) !== planHash)
        throw new AshError("CONFLICT", "The plan changed while checking its approval.");
      current.plan_approval_ref = null;
      current.plan_approved_at = null;
      current.status = "awaiting_plan_approval";
      current.status_detail = `Plan approval ${approval.id} is required before execution.`;
    });
    return { task: updated, approval };
  });
}
