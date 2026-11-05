import { promises as fs } from "node:fs";
import { z } from "zod";
import { AshError } from "../errors.js";
import type { AppConfig } from "../config.js";
import type {
  Criterion,
  CriterionResult,
  DeliveryRecord,
  SubtaskPlan,
  TaskRecord,
  VerificationResult,
} from "../domain/types.js";
import { resolveArtifactPath } from "../util/fs.js";
import { extractJsonObject, parseJson } from "../util/json.js";
import { clip, scanForPromptInjection } from "../util/strings.js";
import { nowIso } from "../util/time.js";
import { logger } from "../logger.js";
import { runAllowlistedCommand } from "../security/guard.js";
import type { ModelAdapter } from "./model.js";
import { buildVerifierMessages, VERIFIER_TEXT_LIMIT } from "./prompts.js";

const VerifierOutputSchema = z.object({
  passed: z.boolean(),
  results: z
    .array(
      z.object({
        criterion: z.string().min(1).max(500),
        passed: z.boolean(),
        details: z.string().max(4_000),
      }),
    )
    .max(20),
  summary: z.string().min(1).max(4_000),
});

export interface ManualReview {
  decision: "pass" | "fail";
  note: string;
  at: string;
  reviewer: "human";
}

export interface VerifyOptions {
  task: TaskRecord;
  subtask: SubtaskPlan;
  delivery: DeliveryRecord;
  deliveryText: string;
  workspace: string;
  manualReview?: ManualReview | null;
}

export class DeliverableVerifier {
  private readonly config: AppConfig;
  private readonly model: ModelAdapter;

  constructor(config: AppConfig, model: ModelAdapter) {
    this.config = config;
    this.model = model;
  }

  async verify(options: VerifyOptions): Promise<VerificationResult> {
    const { task, subtask, delivery, deliveryText, workspace, manualReview } = options;
    const criteria = subtask.acceptance_criteria;
    const deterministic: CriterionResult[] = [];
    const llmCriteria: Criterion[] = [];
    const pendingHuman: Criterion[] = [];
    const injection = scanForPromptInjection(deliveryText);
    const injectionFlags = [...new Set([...delivery.injection_signals, ...injection.signals])];

    for (const criterion of criteria) {
      if (criterion.kind === "llm_review") {
        llmCriteria.push(criterion);
        continue;
      }
      if (criterion.kind === "human_approval") {
        if (manualReview) {
          deterministic.push({
            criterion: criterion.description,
            kind: criterion.kind,
            passed: manualReview.decision === "pass",
            details:
              manualReview.decision === "pass"
                ? `Human approved: ${manualReview.note}`
                : `Human rejected: ${manualReview.note}`,
          });
        } else {
          pendingHuman.push(criterion);
        }
        continue;
      }
      deterministic.push(await this.runDeterministic(criterion, deliveryText, workspace));
    }

    const results: CriterionResult[] = [...deterministic];
    let llmSummary = "";
    let needsHuman = false;
    let hardFailure = manualReview?.decision === "fail" || deterministic.some((result) => !result.passed);
    const reasons: string[] = [];

    if (llmCriteria.length > 0) {
      if (manualReview) {
        for (const criterion of llmCriteria)
          results.push({
            criterion: criterion.description,
            kind: criterion.kind,
            passed: manualReview.decision === "pass",
            details: `Human reviewed the subjective criterion: ${manualReview.note}`,
          });
      } else if (!this.model.available) {
        needsHuman = true;
        reasons.push("LLM review criteria are present but no model is available.");
        for (const criterion of llmCriteria) {
          results.push({
            criterion: criterion.description,
            kind: criterion.kind,
            passed: false,
            details: "No model is configured; a human must review this criterion.",
          });
        }
      } else {
        try {
          const messages = buildVerifierMessages({
            task,
            subtask,
            deliveryText,
            criteria,
            deterministic: deterministic.map((result) => ({
              criterion: result.criterion,
              passed: result.passed,
              details: result.details,
            })),
            injectionFlags,
          });
          logger.info("Verifier request", { task_id: task.id, subtask_id: subtask.id, model: this.model.modelName });
          const response = await this.model.complete(messages, { json: true, temperature: 0, maxTokens: 2_500 });
          if (response.finishReason === "length")
            throw new AshError("MODEL_RESPONSE_INVALID", "The verifier response was truncated.");
          const output = VerifierOutputSchema.parse(extractJsonObject(response.text));
          llmSummary = output.summary;
          const used = new Set<number>();
          for (const criterion of llmCriteria) {
            const index = output.results.findIndex(
              (result, resultIndex) => !used.has(resultIndex) && result.criterion === criterion.description,
            );
            if (index === -1) {
              needsHuman = true;
              reasons.push(`The verifier omitted criterion "${criterion.description}".`);
              results.push({
                criterion: criterion.description,
                kind: criterion.kind,
                passed: false,
                details: "The verifier did not return a result for this criterion.",
              });
              continue;
            }
            used.add(index);
            const result = output.results[index]!;
            if (!result.passed) hardFailure = true;
            results.push({
              criterion: criterion.description,
              kind: criterion.kind,
              passed: result.passed,
              details: clip(result.details, 4_000),
            });
          }
          if (
            output.passed === false &&
            llmCriteria.every((criterion) =>
              results.some((result) => result.criterion === criterion.description && result.passed),
            )
          ) {
            needsHuman = true;
            reasons.push("The verifier returned an overall failure while individual criteria passed.");
          }
        } catch (error) {
          needsHuman = true;
          reasons.push(`The model verifier failed: ${error instanceof Error ? error.message : String(error)}`);
          for (const criterion of llmCriteria) {
            results.push({
              criterion: criterion.description,
              kind: criterion.kind,
              passed: false,
              details: "The model verifier failed; human review is required.",
            });
          }
        }
      }
    }

    for (const criterion of pendingHuman) {
      needsHuman = true;
      results.push({
        criterion: criterion.description,
        kind: criterion.kind,
        passed: false,
        details: "Awaiting explicit human review.",
      });
    }

    if (injectionFlags.length > 0 && !manualReview) {
      needsHuman = true;
      reasons.push("Prompt-injection signals were detected in the deliverable.");
    }
    if (
      (delivery.truncated || (llmCriteria.length > 0 && deliveryText.length > VERIFIER_TEXT_LIMIT)) &&
      !manualReview
    ) {
      needsHuman = true;
      reasons.push("Only part of the deliverable was available for automated review.");
    }

    const orderedIndices = new Set<number>();
    const ordered = criteria.map((criterion) => {
      const index = results.findIndex(
        (candidate, i) =>
          !orderedIndices.has(i) && candidate.kind === criterion.kind && candidate.criterion === criterion.description,
      );
      if (index !== -1) orderedIndices.add(index);
      const result = results[index];
      return (
        result ?? {
          criterion: criterion.description,
          kind: criterion.kind,
          passed: false,
          details: "No verification result was produced.",
        }
      );
    });

    const failed = ordered.filter(
      (result) =>
        !result.passed && !pendingHuman.some((c) => c.kind === result.kind && c.description === result.criterion),
    );
    if (manualReview && !criteria.some((criterion) => criterion.kind === "human_approval")) {
      ordered.push({
        criterion: "Human review",
        kind: "human_approval",
        passed: manualReview.decision === "pass",
        details: `Human ${manualReview.decision === "pass" ? "approved" : "rejected"}: ${manualReview.note}`,
      });
    }
    const status: VerificationResult["status"] = hardFailure ? "failed" : needsHuman ? "needs_human" : "passed";
    const passed = status === "passed";
    const detailParts: string[] = [];
    if (status === "passed") {
      detailParts.push(
        manualReview ? "Human review passed and all automated checks passed." : "All acceptance criteria passed.",
      );
    } else if (status === "failed") {
      if (manualReview?.decision === "fail") detailParts.push("Human rejected the deliverable.");
      if (failed.length > 0)
        detailParts.push(`Failed criteria: ${failed.map((result) => result.criterion).join("; ")}.`);
    } else {
      detailParts.push(`Human review required: ${reasons.join(" ") || "one or more criteria need a human decision."}`);
    }
    if (injectionFlags.length > 0) detailParts.push(`Injection signals: ${injectionFlags.join(", ")}.`);
    if (llmSummary) detailParts.push(llmSummary);
    if (manualReview) detailParts.push(`Human note: ${manualReview.note}`);

    const verification: VerificationResult = {
      passed,
      status,
      checked_at: nowIso(),
      details: clip(detailParts.join(" "), 8_000),
      results: ordered,
      injection_flags: injectionFlags,
      reviewed_by: manualReview ? "HUMAN" : "ASH",
    };
    await logger.audit("verification.completed", {
      task_id: task.id,
      subtask_id: subtask.id,
      status: verification.status,
      passed: verification.passed,
      injection_flags: injectionFlags,
      reviewed_by: verification.reviewed_by,
    });
    return verification;
  }

  private async runDeterministic(
    criterion: Exclude<Criterion, { kind: "llm_review" } | { kind: "human_approval" }>,
    deliveryText: string,
    workspace: string,
  ): Promise<CriterionResult> {
    const base = { criterion: criterion.description, kind: criterion.kind } as const;
    try {
      switch (criterion.kind) {
        case "deliverable_present": {
          const length = deliveryText.trim().length;
          return {
            ...base,
            passed: length >= criterion.min_chars,
            details: `Deliverable has ${length} characters; at least ${criterion.min_chars} required.`,
          };
        }
        case "contains": {
          const lower = deliveryText.toLowerCase();
          const missing = criterion.all.filter((term) => !lower.includes(term.toLowerCase()));
          return {
            ...base,
            passed: missing.length === 0,
            details: missing.length === 0 ? "All required terms are present." : `Missing terms: ${missing.join(", ")}.`,
          };
        }
        case "json_valid": {
          try {
            parseJson(deliveryText, "Deliverable");
            return { ...base, passed: true, details: "Deliverable is valid JSON." };
          } catch {
            try {
              extractJsonObject(deliveryText);
              return { ...base, passed: true, details: "Deliverable contains a valid JSON object." };
            } catch {
              return { ...base, passed: false, details: "Deliverable is not valid JSON." };
            }
          }
        }
        case "file_exists": {
          const target = await resolveArtifactPath(workspace, criterion.path);
          const stat = await fs.stat(target).catch(() => null);
          if (!stat?.isFile()) {
            return { ...base, passed: false, details: `File ${criterion.path} is missing.` };
          }
          return {
            ...base,
            passed: stat.size >= criterion.min_bytes,
            details: `File ${criterion.path} is ${stat.size} bytes; at least ${criterion.min_bytes} required.`,
          };
        }
        case "test_command": {
          const result = await runAllowlistedCommand({
            command: criterion.command,
            cwd: workspace,
            timeoutMs: criterion.timeout_ms,
            allowedCommands: this.config.policy.allowedVerifyCommands,
          });
          const outputTail = clip(`${result.stdout}\n${result.stderr}`.trim(), 1_500);
          const passed =
            !result.timedOut && !result.outputLimitExceeded && result.exitCode === criterion.expected_exit_code;
          return {
            ...base,
            passed,
            details: [
              result.timedOut
                ? "Command timed out."
                : `Exit code ${result.exitCode}; expected ${criterion.expected_exit_code}.`,
              outputTail ? `Output: ${outputTail}` : "",
            ]
              .filter(Boolean)
              .join(" "),
          };
        }
        default:
          return { ...base, passed: false, details: "Unsupported criterion." };
      }
    } catch (error) {
      return {
        ...base,
        passed: false,
        details: `Verification error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
