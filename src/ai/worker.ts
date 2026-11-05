import path from "node:path";
import { z } from "zod";
import { AshError } from "../errors.js";
import type { AppConfig } from "../config.js";
import type { DeliveryRecord, SubtaskPlan, TaskRecord } from "../domain/types.js";
import { atomicWriteFile, ensurePrivateDir } from "../util/fs.js";
import { sha256Hex } from "../util/json.js";
import { scanForPromptInjection, sanitizeUntrustedText, clip } from "../util/strings.js";
import { nowIso } from "../util/time.js";
import { logger } from "../logger.js";
import { writeGeneratedArtifacts } from "../security/guard.js";
import type { ModelAdapter } from "./model.js";
import { buildDiyMessages } from "./prompts.js";
import { extractJsonObject } from "../util/json.js";

const DiyOutputSchema = z.object({
  summary: z.string().min(1).max(10_000),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        content: z.string().max(200_000),
      }),
    )
    .max(50),
});

export interface DiyResult {
  summary: string;
  delivery: DeliveryRecord;
  workspace: string;
}

export class DiyWorker {
  private readonly config: AppConfig;
  private readonly model: ModelAdapter;

  constructor(config: AppConfig, model: ModelAdapter) {
    this.config = config;
    this.model = model;
  }

  async execute(
    task: TaskRecord,
    subtask: SubtaskPlan,
    attempt: number,
    workspaceRoot: string,
    feedback: string | null = null,
  ): Promise<DiyResult> {
    if (!this.model.available) {
      throw new AshError("MODEL_UNAVAILABLE", "Ash cannot produce a DIY deliverable without a configured model.");
    }
    const attemptDir = path.join(workspaceRoot, `attempt-${attempt}`);
    await ensurePrivateDir(attemptDir);
    const messages = buildDiyMessages(task, subtask, attemptDir, attempt, feedback);
    logger.info("DIY worker request", {
      task_id: task.id,
      subtask_id: subtask.id,
      attempt,
      model: this.model.modelName,
    });
    const response = await this.model.complete(messages, { json: true, temperature: 0.3, maxTokens: 6_000 });
    if (response.finishReason === "length") {
      throw new AshError("MODEL_RESPONSE_INVALID", "The DIY deliverable was cut off before it finished.");
    }
    let output: z.infer<typeof DiyOutputSchema>;
    try {
      output = DiyOutputSchema.parse(extractJsonObject(response.text));
    } catch (error) {
      throw new AshError("MODEL_RESPONSE_INVALID", "The DIY worker did not return the required JSON artifact shape.", {
        cause: error,
      });
    }

    const written = await writeGeneratedArtifacts(attemptDir, output.files, {
      maxFiles: 50,
      maxFileBytes: 200 * 1024,
      maxTotalBytes: 2 * 1024 * 1024,
    });

    const combined = buildDeliveryText(subtask, output.summary, output.files);
    const scan = scanForPromptInjection(combined.text);
    const deliverablesDir = path.join(this.config.dataDir, "tasks", task.id, "deliverables", subtask.id);
    await ensurePrivateDir(deliverablesDir);
    const target = path.join(deliverablesDir, `attempt-${attempt}.md`);
    await atomicWriteFile(target, combined.text, { mode: 0o600 });
    const relative = path.relative(this.config.dataDir, target).split(path.sep).join("/");
    if (relative.startsWith("..")) {
      throw new AshError("STATE_INVALID", "Deliverable path escaped the data directory.");
    }
    const delivery: DeliveryRecord = {
      text_path: relative,
      files: written.map((file) => ({
        path: file.path.split(path.sep).join("/"),
        filename: path.basename(file.path),
        bytes: file.bytes,
        sha256: file.sha256,
      })),
      external_url: null,
      received_at: nowIso(),
      source: `diy:${this.model.id}`,
      sha256: sha256Hex(combined.text),
      suspicious: scan.suspicious,
      injection_signals: scan.signals,
      truncated: combined.truncated,
    };
    await logger.audit("diy.delivered", {
      task_id: task.id,
      subtask_id: subtask.id,
      attempt,
      files: written.length,
      bytes: Buffer.byteLength(combined.text, "utf8"),
      suspicious: scan.suspicious,
      model: this.model.modelName,
    });
    return { summary: output.summary, delivery, workspace: attemptDir };
  }
}

function buildDeliveryText(
  subtask: SubtaskPlan,
  summary: string,
  files: Array<{ path: string; content: string }>,
): { text: string; truncated: boolean } {
  const limit = 200_000;
  const parts = [`# ${subtask.title}`, "", sanitizeUntrustedText(summary, 20_000), "", "## Artifacts", ""];
  let used = parts.join("\n").length;
  let truncated = false;
  for (const file of files) {
    const header = `\n### ${file.path}\n\n`;
    const content = sanitizeUntrustedText(file.content, 200_000);
    if (used + header.length + content.length > limit) {
      parts.push(`\n### ${file.path}\n\n[artifact omitted from verification text at the size limit]\n`);
      truncated = true;
      continue;
    }
    parts.push(header, content, "");
    used += header.length + content.length;
  }
  return { text: clip(parts.join("\n"), limit), truncated };
}
