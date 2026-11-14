import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { DeliveryRecord, SubtaskPlan, TaskRecord } from "../domain/types.js";
import { AshError } from "../errors.js";
import { resolveArtifactPath } from "../util/fs.js";
import { hashJson, sha256Hex } from "../util/json.js";
import { scanForPromptInjection, untrustedBlock } from "../util/strings.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HASH_BYTES = 50 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".sql",
  ".sh",
  ".svg",
  ".log",
  ".rst",
]);

/** Bounded reads from the actual artifact, never from a provider's description of it. */
export async function readEvidenceFile(root: string, relative: string, hash: string | null): Promise<Buffer | null> {
  if (!hash) throw new AshError("INTEGRITY_FAILED", `Artifact ${relative} has no recorded hash.`);
  return (await inspectEvidenceFile(root, relative, hash)).content;
}

async function inspectEvidenceFile(root: string, relative: string, hash: string | null) {
  const target = await resolveArtifactPath(root, relative);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new AshError("INTEGRITY_FAILED", `Artifact ${relative} is not a regular file.`);
    if (stat.size > MAX_HASH_BYTES)
      throw new AshError("INTEGRITY_FAILED", `Artifact ${relative} exceeds the 50 MiB integrity-check limit.`);
    const buffer = Buffer.alloc(64 * 1024);
    const chunks: Buffer[] = [];
    const digest = createHash("sha256");
    let used = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
      if (used > stat.size) throw new AshError("INTEGRITY_FAILED", `Artifact ${relative} changed during inspection.`);
      const chunk = buffer.subarray(0, read.bytesRead);
      digest.update(chunk);
      if (stat.size <= MAX_FILE_BYTES) chunks.push(Buffer.from(chunk));
    }
    const actualHash = digest.digest("hex");
    if (used !== stat.size || (hash && actualHash !== hash))
      throw new AshError("INTEGRITY_FAILED", `Artifact ${relative} no longer matches its recorded hash.`);
    return { content: stat.size <= MAX_FILE_BYTES ? Buffer.concat(chunks) : null, sha256: actualHash, bytes: used };
  } finally {
    await handle.close();
  }
}

export async function collectDeliveryEvidence(
  delivery: DeliveryRecord,
  workspace: string,
  deliveryText: string,
  limit = 60_000,
): Promise<{ text: string; issues: string[]; injectionSignals: string[]; fingerprint: string }> {
  const issues: string[] = [];
  const signals = new Set([...delivery.injection_signals, ...scanForPromptInjection(deliveryText).signals]);
  if (delivery.truncated) issues.push("The delivery was truncated when received.");
  let text = deliveryText.slice(0, limit);
  if (text.length !== deliveryText.length) issues.push("The delivery text exceeds the review limit.");
  const seen = new Set<string>();
  const observed: Array<{ path: string; sha256: string; bytes: number }> = [];
  const artifacts: Array<{ path: string; sha256: string; content: string }> = [];
  for (const file of delivery.files) {
    const target = await resolveArtifactPath(workspace, file.path);
    if (seen.has(target)) throw new AshError("INTEGRITY_FAILED", "Delivery contains duplicate artifact paths.");
    seen.add(target);
    if (!file.sha256) {
      issues.push(`Artifact ${file.path} has no recorded hash; human inspection is required.`);
    }
    const inspected = await inspectEvidenceFile(workspace, file.path, file.sha256);
    observed.push({ path: file.path, sha256: inspected.sha256, bytes: inspected.bytes });
    if (inspected.bytes !== file.bytes) throw new AshError("INTEGRITY_FAILED", `Artifact ${file.path} size changed.`);
    const bytes = inspected.content;
    if (!bytes) {
      issues.push(`Artifact ${file.path} exceeds the 2 MiB inspection limit.`);
      continue;
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!TEXT_EXTENSIONS.has(path.extname(file.path).toLowerCase()) || /[\x00-\x08\x0b-\x1f\x7f]/.test(content))
        throw new Error("Unsupported text format");
    } catch {
      issues.push(`Artifact ${file.path} is binary or an unsupported format; human inspection is required.`);
      continue;
    }
    for (const signal of scanForPromptInjection(content).signals) signals.add(signal);
    artifacts.push({ path: file.path, sha256: inspected.sha256, content });
  }
  // Long verbatim copies in the note may refer to the explicit artifact below.
  // Every file retains its own identity, including empty and equal-content files.
  for (const artifact of [...artifacts].sort((a, b) => b.content.length - a.content.length)) {
    if (artifact.content.length >= 128)
      text = text
        .split(artifact.content)
        .join(`[Exact content ${artifact.sha256} is shown in the artifact entries below.]`);
  }
  const included = new Set<string>();
  for (const artifact of artifacts) {
    const content = included.has(artifact.sha256)
      ? `[Same exact content as artifact content ${artifact.sha256} above.]`
      : `${artifact.content.length} characters:\n${artifact.content}`;
    const block = `\n\nArtifact ${JSON.stringify(artifact.path)} (SHA-256 ${artifact.sha256}):\n${content}`;
    if (text.length + block.length > limit) {
      issues.push(`Artifact ${artifact.path} does not fit in the review context.`);
      continue;
    }
    text += block;
    included.add(artifact.sha256);
  }
  return {
    text,
    issues,
    injectionSignals: [...signals],
    fingerprint: hashJson({ delivery, delivery_text_sha256: sha256Hex(deliveryText), observed }),
  };
}

/** A dependency is usable only when its completed, reviewed output can be supplied in full. */
export async function dependencyContext(
  config: AppConfig,
  task: TaskRecord,
  subtask: SubtaskPlan,
  limit = 60_000,
): Promise<string> {
  const parts: string[] = [];
  for (const id of subtask.dependencies) {
    const state = task.subtasks.find((entry) => entry.id === id);
    const attempt = state?.attempts.find((entry) => entry.attempt === state.active_attempt);
    if (state?.phase !== "completed" || !attempt?.verification?.passed || !attempt.delivery?.text_path)
      throw new AshError("UNSAFE_OPERATION", `Dependency ${id} has no completed, verified delivery.`);
    const bytes = await readEvidenceFile(config.dataDir, attempt.delivery.text_path, attempt.delivery.sha256);
    if (!bytes) throw new AshError("UNSAFE_OPERATION", `Dependency ${id} exceeds the artifact handoff limit.`);
    const workspace = path.join(config.dataDir, "workspaces", task.id, id, `attempt-${attempt.attempt}`);
    const evidence = await collectDeliveryEvidence(attempt.delivery, workspace, bytes.toString("utf8"), limit);
    if (evidence.issues.length)
      throw new AshError("UNSAFE_OPERATION", `Cannot hand off dependency ${id}: ${evidence.issues.join(" ")}`);
    // JSON escaping prevents artifact text from closing its untrusted delimiter.
    parts.push(
      untrustedBlock(
        "DEPENDENCY",
        JSON.stringify({
          subtask_id: id,
          attempt: attempt.attempt,
          delivery_sha256: attempt.delivery.sha256,
          injection_signals: evidence.injectionSignals,
          content: evidence.text,
        })
          .replaceAll("<", "\\u003c")
          .replaceAll(">", "\\u003e"),
        limit + 1_000,
      ),
    );
    if (parts.join("\n\n").length > limit)
      throw new AshError(
        "UNSAFE_OPERATION",
        "Completed dependency artifacts exceed the handoff limit. Provide a smaller reviewed text deliverable.",
      );
  }
  return parts.join("\n\n");
}
