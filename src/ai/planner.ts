import { AshError, errorMessage } from "../errors.js";
import type { AppConfig } from "../config.js";
import type { Plan, TaskRecord } from "../domain/types.js";
import { assemblePlan, validatePlan, validateTaskPlan } from "../domain/plan.js";
import { extractJsonObject, hashJson } from "../util/json.js";
import { logger } from "../logger.js";
import type { ChatMessage, ModelAdapter } from "./model.js";
import { buildPlannerMessages } from "./prompts.js";

export class TaskPlanner {
  private readonly config: AppConfig;
  private readonly model: ModelAdapter;

  constructor(config: AppConfig, model: ModelAdapter) {
    this.config = config;
    this.model = model;
  }

  async plan(task: TaskRecord): Promise<{ plan: Plan; planHash: string }> {
    if (!this.model.available) {
      throw new AshError("MODEL_UNAVAILABLE", "Ash cannot reason about this task because no AI model is configured.", {
        hint: "Configure ASH_MODEL_PROVIDER/ASH_MODEL_NAME/ASH_MODEL_BASE_URL/ASH_MODEL_API_KEY, or import a reviewed plan with `plan import <file>`.",
      });
    }

    let lastError: unknown = null;
    const feedback: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const messages: ChatMessage[] = buildPlannerMessages(task, this.config.policy.contingencyRatio);
      if (feedback.length > 0) {
        messages.push({
          role: "user",
          content: `Your previous plan was rejected: ${feedback.join(" ")} Return a corrected JSON plan only.`,
        });
      }
      logger.info("Planner request", { provider: this.model.id, model: this.model.modelName, attempt });
      const response = await this.model.complete(messages, { json: true, temperature: 0.2, maxTokens: 4_500 });
      logger.info("Planner response received", {
        finish_reason: response.finishReason,
        prompt_tokens: response.usage.promptTokens,
        completion_tokens: response.usage.completionTokens,
      });
      if (response.finishReason === "length") {
        lastError = new AshError("MODEL_RESPONSE_INVALID", "The model's plan was cut off before it finished.");
        feedback.push("The response was truncated; produce a shorter plan.");
        continue;
      }

      try {
        const parsed = extractJsonObject(response.text);
        const plan = assemblePlan(parsed, task.currency, task.authorized_budget);
        validateTaskPlan(plan, task);
        const validated = validatePlan(plan, task.authorized_budget, task.currency, {
          allowedVerifyCommands: this.config.policy.allowedVerifyCommands,
          contingencyRatio: this.config.policy.contingencyRatio,
        });
        const planHash = hashJson(validated);
        await logger.audit("plan.created", {
          task_id: task.id,
          plan_hash: planHash,
          subtasks: validated.subtasks.length,
          external_subtasks: validated.subtasks.filter((subtask) => subtask.execution === "EXTERNAL").length,
          external_planned: validated.external_planned,
          contingency: validated.contingency,
          provider: this.model.id,
          model: this.model.modelName,
        });
        return { plan: validated, planHash };
      } catch (error) {
        lastError = error;
        feedback.push(compactError(error));
        logger.warn("Planner output rejected", { attempt, reason: compactError(error) });
      }
    }

    throw new AshError(
      "MODEL_RESPONSE_INVALID",
      `The model could not produce a valid budget-safe plan: ${compactError(lastError)}`,
      {
        cause: lastError,
        hint: "Retry, choose a stronger model, or import a reviewed plan with `plan import <file>`.",
      },
    );
  }
}

function compactError(error: unknown): string {
  const message = errorMessage(error).replace(/\s+/g, " ").trim();
  return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}
