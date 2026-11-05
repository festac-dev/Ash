import path from "node:path";
import { promises as fs } from "node:fs";
import type { AppConfig } from "./config.js";
import type { TaskRecord } from "./domain/types.js";
import { TransactionLedger, formatIntegrityReport } from "./transactions/ledger.js";
import { TaskStore } from "./state/store.js";
import { summarizeLedger } from "./ledger/ledger.js";
import { formatMinor } from "./util/money.js";
import { projectLabel } from "./tracks.js";
import { atomicWriteFile, ensureDir, ensurePrivateDir } from "./util/fs.js";
import { nowIso, receiptStamp } from "./util/time.js";
import { redact, redactObject } from "./util/redact.js";

export interface ReportBundle {
  markdown: string;
  html: string;
  json: string;
  generatedAt: string;
}

export async function buildTaskReport(store: TaskStore, config: AppConfig, task: TaskRecord): Promise<ReportBundle> {
  const ledger = await store.loadLedger(task.id).catch(() => null);
  const approvals = await store
    .approvals(task.id)
    .list()
    .catch(() => []);
  const transactions = new TransactionLedger(config.dataDir);
  const snapshot = await transactions.inspect(Number.MAX_SAFE_INTEGER).catch(() => null);
  const receipts = snapshot?.receipts ?? [];
  const integrity = snapshot?.report ?? null;
  const totals = ledger
    ? (() => {
        try {
          return summarizeLedger(ledger);
        } catch {
          return null;
        }
      })()
    : null;
  const relevantReceipts = receipts.filter((receipt) => receipt.task_id === task.id);
  const generatedAt = nowIso();

  const md: string[] = [];
  md.push(`# Ash Task Report`);
  md.push("");
  md.push(`Generated: ${generatedAt}`);
  md.push(`Mode: ${config.simulation ? "SIMULATION (no real funds)" : "LIVE"}`);
  md.push(`Task: ${task.id}`);
  md.push(`Status: ${task.status}${task.status_detail ? ` — ${task.status_detail}` : ""}`);
  md.push("");
  md.push(`## Task`);
  md.push("");
  md.push(redact(task.description));
  if (task.quality_requirements) {
    md.push("");
    md.push(`**Quality requirements:** ${redact(task.quality_requirements)}`);
  }
  if (task.deadline) md.push(`**Deadline:** ${task.deadline}`);
  md.push(`**Project:** ${projectLabel(task.track_id, task.project_scopes)}`);
  if (Object.keys(task.track_inputs).length > 0) {
    md.push(
      `**Project inputs:** ${Object.entries(task.track_inputs)
        .map(([key, value]) => `${key}=${redact(value)}`)
        .join(", ")}`,
    );
  }
  md.push(`**Execution strategy:** ${task.execution_strategy}`);
  md.push(`**External hiring allowed:** ${task.allow_external ? "yes" : "no"}`);
  md.push(`**Per-hire human approval:** ${task.require_hiring_approval ? "yes" : "no"}`);
  md.push("");
  md.push(`## Budget`);
  md.push("");
  md.push(`| Item | Amount |`);
  md.push(`|---|---:|`);
  md.push(`| Authorized | ${task.authorized_budget} ${task.currency} |`);
  if (totals) {
    md.push(`| Committed | ${formatMinor(totals.committed, task.currency)} ${task.currency} |`);
    md.push(`| Paid | ${formatMinor(totals.paid, task.currency)} ${task.currency} |`);
    md.push(`| Refunded | ${formatMinor(totals.refunded, task.currency)} ${task.currency} |`);
    md.push(`| Available | ${formatMinor(totals.available, task.currency)} ${task.currency} |`);
  }
  if (task.market_snapshot) {
    const balance = task.market_snapshot.balances[task.currency];
    md.push(`| Market account balance (snapshot) | ${balance ?? "unreadable"} ${task.currency} |`);
  }
  md.push("");
  if (task.plan) {
    md.push(`## Plan`);
    md.push("");
    md.push(redact(task.plan.summary));
    md.push("");
    md.push(`Final outcome: ${redact(task.plan.final_outcome)}`);
    md.push("");
    md.push(`| ID | Subtask | Mode | Max | State | Receipt |`);
    md.push(`|---|---|---|---:|---|---|`);
    for (const subtask of task.plan.subtasks) {
      const state = task.subtasks.find((candidate) => candidate.id === subtask.id);
      md.push(
        `| ${subtask.id} | ${escapeCell(subtask.title)} | ${subtask.execution} | ${subtask.planned_max} ${task.currency} | ${state?.phase ?? "pending"} | ${state?.receipt_id ?? "—"} |`,
      );
    }
    md.push("");
    if (task.plan.assumptions.length > 0) {
      md.push(`### Assumptions`);
      for (const item of task.plan.assumptions) md.push(`- ${redact(item)}`);
      md.push("");
    }
    if (task.plan.risks.length > 0) {
      md.push(`### Risks`);
      for (const item of task.plan.risks) md.push(`- ${redact(item)}`);
      md.push("");
    }
  }
  md.push(`## Approvals`);
  md.push("");
  if (approvals.length === 0) md.push("No approval requests.");
  else {
    md.push(`| ID | Kind | Status | Amount | Summary |`);
    md.push(`|---|---|---|---:|---|`);
    for (const approval of approvals) {
      md.push(
        `| ${approval.id} | ${approval.kind} | ${approval.status} | ${approval.amount ? `${approval.amount} ${approval.currency}` : "—"} | ${escapeCell(redact(approval.summary))} |`,
      );
    }
  }
  md.push("");
  md.push(`## Transactions`);
  md.push("");
  if (relevantReceipts.length === 0) md.push("No receipts for this task.");
  else {
    md.push(`| File | Status | Item | Vendor | Agreed | Payment | Hash |`);
    md.push(`|---|---|---|---|---:|---|---|`);
    for (const receipt of relevantReceipts) {
      md.push(
        `| ${receipt.metadata.file ?? receipt.transaction_id} | ${receipt.status} | ${escapeCell(receipt.item)} | ${escapeCell(receipt.vendor?.name ?? "—")} | ${receipt.agreed_price ? `${receipt.agreed_price} ${receipt.currency}` : "—"} | ${receipt.payment_status} | ${receipt.hash.slice(0, 16)}… |`,
      );
    }
  }
  md.push("");
  md.push(`## Integrity`);
  md.push("");
  if (integrity) {
    md.push(`Chain: **${integrity.ok ? "VERIFIED" : "BROKEN"}**`);
    md.push("");
    md.push("```");
    md.push(...formatIntegrityReport(integrity));
    md.push("```");
  } else {
    md.push("Integrity check could not run.");
  }
  md.push("");
  md.push(`## Market snapshot`);
  md.push("");
  if (task.market_snapshot) {
    md.push(`Source: ${task.market_snapshot.source} at ${task.market_snapshot.at}`);
    md.push(
      `Account: ${task.market_snapshot.account_id ?? "unknown"}${task.market_snapshot.handle ? ` (${task.market_snapshot.handle})` : ""}`,
    );
    md.push(`Balances: ${JSON.stringify(task.market_snapshot.balances)}`);
    if (task.market_snapshot.note) md.push(`Note: ${redact(task.market_snapshot.note)}`);
  } else {
    md.push("No market balance snapshot was recorded.");
  }
  md.push("");
  md.push("---");
  md.push("This report was generated from Ash's local state. It contains no credentials or wallet keys.");
  md.push("");

  const bundle = {
    generated_at: generatedAt,
    mode: config.simulation ? "simulated" : "live",
    task,
    ledger,
    approvals,
    transactions: relevantReceipts,
    integrity,
  };
  return {
    markdown: redact(md.join("\n")),
    html: proofHtml(task, config.simulation, generatedAt, relevantReceipts, integrity?.ok ?? false),
    json: `${JSON.stringify(redactObject(bundle), null, 2)}\n`,
    generatedAt,
  };
}

export async function exportTaskReport(
  store: TaskStore,
  config: AppConfig,
  task: TaskRecord,
  destination?: string,
): Promise<{ markdownPath: string; jsonPath: string; htmlPath: string }> {
  const report = await buildTaskReport(store, config, task);
  const stamp = receiptStamp(new Date(report.generatedAt));
  let markdownPath: string;
  let jsonPath: string;
  if (destination) {
    const resolved = path.resolve(destination);
    const stat = await fs.stat(resolved).catch(() => null);
    if (stat?.isDirectory()) {
      markdownPath = path.join(resolved, `Ash_${stamp}_report.md`);
      jsonPath = path.join(resolved, `Ash_${stamp}_report.json`);
    } else {
      markdownPath = resolved.endsWith(".md") ? resolved : `${resolved}.md`;
      jsonPath = markdownPath.replace(/\.md$/, ".json");
    }
    await ensureDir(path.dirname(markdownPath));
  } else {
    const dir = store.reportsDir(task.id);
    await ensurePrivateDir(dir);
    markdownPath = path.join(dir, `Ash_${stamp}_report.md`);
    jsonPath = path.join(dir, `Ash_${stamp}_report.json`);
  }
  await atomicWriteFile(markdownPath, report.markdown, { mode: 0o600 });
  await atomicWriteFile(jsonPath, report.json, { mode: 0o600 });
  const htmlPath = markdownPath.replace(/\.md$/, ".html");
  await atomicWriteFile(htmlPath, report.html, { mode: 0o600 });
  return { markdownPath, jsonPath, htmlPath };
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function proofHtml(
  task: TaskRecord,
  simulated: boolean,
  generatedAt: string,
  receipts: import("./domain/types.js").TransactionReceipt[],
  verified: boolean,
): string {
  const safe = (value: string): string =>
    redact(value).replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
    );
  const cards = receipts
    .map(
      (receipt) =>
        `<article><h2>${safe(receipt.item)}</h2><p>${safe(receipt.status)} · ${safe(receipt.payment_status)} · ${safe(receipt.agreed_price ?? "0")} ${safe(receipt.currency)}</p><p>${safe(receipt.check_result.details)}</p><ul>${receipt.check_result.criteria.map((check) => `<li>${check.passed ? "PASS" : "FAIL"} — ${safe(check.criterion)}: ${safe(check.details)}</li>`).join("")}</ul><p>Job: ${safe(receipt.marketplace_job_id ?? "local work")} · Approval: ${safe(receipt.approval_ref ?? "none")}</p><code>SHA-256 ${safe(receipt.hash)}</code></article>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Ash proof of work</title><style>body{background:#07100d;color:#e5f7ec;font:16px/1.65 system-ui;margin:auto;max-width:960px;padding:36px}h1{font-size:42px;color:#00ff88}h2{color:#22d3ee}article{border:1px solid #244b38;border-radius:12px;padding:20px;margin:18px 0}code{overflow-wrap:anywhere;color:#a78bfa}header,footer{color:#95b7a5}.badge{color:#fbbf24}p{white-space:pre-wrap}</style><header>ASH / PROOF OF WORK <span class="badge">${simulated ? "SIMULATION — no real funds" : "LIVE"}</span></header><h1>${safe(task.description)}</h1><p>${safe(task.id)} · ${safe(task.status)} · Budget ${safe(task.authorized_budget)} ${safe(task.currency)}</p><p>Receipt chain at export: <strong>${verified ? "VERIFIED" : "NOT VERIFIED"}</strong> · ${safe(generatedAt)}</p>${cards || "<article>No finished-subtask receipts yet.</article>"}<footer>This is a redacted local evidence snapshot, not independent settlement proof. Verify the original receipts with <code>npm run verify</code>. Review task details before sharing. Exported JSON is redacted and is not a replacement for original receipts.</footer></html>`;
}
