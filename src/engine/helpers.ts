import path from "node:path";
import { promises as fs } from "node:fs";
import { AshError } from "../errors.js";
import type { AppConfig } from "../config.js";
import type {
  AttemptRecord,
  SubtaskPhase,
  SubtaskPlan,
  TaskRecord,
  TransactionReceipt,
  VerificationResult,
} from "../domain/types.js";
import { resolveArtifactPath } from "../util/fs.js";
import { sha256Hex } from "../util/json.js";

export const TERMINAL_PHASES: ReadonlySet<SubtaskPhase> = new Set(["completed", "failed", "cancelled", "blocked"]);

export const SCHEDULABLE_PHASES: ReadonlySet<SubtaskPhase> = new Set([
  "pending",
  "ready",
  "running_diy",
  "discovering",
  "awaiting_hire_approval",
  "preparing_draft",
  "awaiting_market_approval",
  "waiting_bids",
  "awaiting_market_award",
  "waiting_job",
  "verifying",
  "awaiting_acceptance_approval",
  "awaiting_market_acceptance",
]);

export const ACTIVE_PHASES: ReadonlySet<SubtaskPhase> = new Set(
  [...SCHEDULABLE_PHASES].filter((phase) => phase !== "pending" && phase !== "ready"),
);

export function isTerminal(phase: SubtaskPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function jobPollSeconds(startedAt: string): number {
  const ageMs = Date.now() - Date.parse(startedAt);
  if (ageMs < 2 * 60_000) return 10;
  if (ageMs < 10 * 60_000) return 30;
  if (ageMs < 60 * 60_000) return 120;
  return 300;
}

export function bidPollSeconds(startedAt: string, latencyMs = 0): number {
  if (latencyMs > 0) return Math.max(1, Math.ceil(latencyMs / 1000));
  const ageMs = Date.now() - Date.parse(startedAt);
  if (ageMs < 2 * 60_000) return 10;
  if (ageMs < 10 * 60_000) return 30;
  return 60;
}

export function buildHireBrief(task: TaskRecord, subtask: SubtaskPlan, isPublicPost = false): string {
  const criteria = subtask.acceptance_criteria
    .map((criterion, index) => `${index + 1}. [${criterion.kind}] ${criterion.description}`)
    .join("\n");
  const lines = [
    `# ${subtask.title}`,
    "",
    "## Deliverable",
    subtask.deliverable,
    "",
    "## Brief",
    subtask.description,
    "",
    "## Project context",
    task.description,
    "",
    "## Acceptance criteria",
    criteria,
    "",
    "## Requirements",
    "- Deliver the actual artifact, not a proposal or a claim that the job is done.",
    "- State any assumptions, limitations and sources inside the deliverable.",
    "- Do not include credentials, private keys, wallet secrets or unrelated personal data.",
    task.deadline ? `- Deadline: ${task.deadline}` : "- No fixed deadline supplied.",
    task.quality_requirements ? `- Quality requirements: ${task.quality_requirements}` : "",
    isPublicPost
      ? "- This job is PUBLIC. Do not include confidential material that should not be visible to other marketplace users."
      : "",
    "",
    "Ash verifies the deliverable against every acceptance criterion before any payment is released.",
  ];
  return lines
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, 8_000);
}

export function verificationFeedback(verification: VerificationResult): string {
  const failures = verification.results.filter((result) => !result.passed);
  const details = failures.map((result) => `- ${result.criterion}: ${result.details}`).join("\n");
  return [
    "The deliverable did not satisfy the acceptance criteria.",
    details || verification.details,
    "Please revise and submit a new version. Keep the original scope; do not add unrelated work.",
  ]
    .join("\n")
    .slice(0, 10_000);
}

export async function workspaceForAttempt(
  config: AppConfig,
  taskId: string,
  subtaskId: string,
  attempt: number,
): Promise<string> {
  const dir = path.join(config.dataDir, "workspaces", taskId, subtaskId, `attempt-${attempt}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function readDeliveryText(
  config: AppConfig,
  delivery: { text_path: string | null; sha256: string | null },
): Promise<string> {
  if (!delivery.text_path) {
    throw new AshError("STATE_INVALID", "The deliverable has no stored text to verify.");
  }
  const target = await resolveArtifactPath(config.dataDir, delivery.text_path);
  const text = await fs.readFile(target, "utf8");
  if (!delivery.sha256 || sha256Hex(text) !== delivery.sha256) {
    throw new AshError("INTEGRITY_FAILED", "Stored deliverable content no longer matches its recorded hash.");
  }
  return text;
}

export function activeAttempt(attempts: AttemptRecord[], active: number): AttemptRecord | null {
  if (active < 1) return null;
  return attempts.find((attempt) => attempt.attempt === active) ?? null;
}

export function receiptStatusFor(
  outcome: "paid" | "unpaid" | "rejected" | "failed" | "walked_away" | "cancelled",
  simulated: boolean,
): TransactionReceipt["status"] {
  if (outcome === "paid") return simulated ? "SIMULATED" : "PAID";
  if (outcome === "unpaid") return "UNPAID";
  if (outcome === "rejected") return "REJECTED";
  if (outcome === "walked_away") return "WALKED_AWAY";
  if (outcome === "cancelled") return "CANCELLED";
  return "FAILED";
}

export function safeDownloadName(filename: string): string {
  const cleaned = filename
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "deliverable.bin";
}
