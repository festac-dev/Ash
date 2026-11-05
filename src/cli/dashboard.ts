import type { AppConfig } from "../config.js";
import type { LedgerRecord, Plan, TaskRecord } from "../domain/types.js";
import type { IntegrityReport } from "../transactions/ledger.js";
import type { MarketConnectionInfo } from "../market/types.js";
import { displayMoney, formatMinor, parseAmount, percentOf, CURRENCIES } from "../util/money.js";
import { formatDuration, formatLocal } from "../util/time.js";
import { clip } from "../util/strings.js";
import { PROJECT, isProjectId, projectLabel, resolveScopes } from "../tracks.js";
import type { Theme } from "./theme.js";
import { progressBar } from "./theme.js";
import { keyValue, panel, table, wrap } from "./components.js";

export interface DashboardData {
  config: AppConfig;
  task: TaskRecord | null;
  ledger: LedgerRecord | null;
  receiptCount: number;
  integrity: IntegrityReport | null;
  market: MarketConnectionInfo | null;
  marketError: string | null;
  pendingApprovals: number;
  engineRunning: boolean;
}

export function renderDashboard(theme: Theme, data: DashboardData): string[] {
  const lines: string[] = [];
  const compact = theme.width < 72;
  const task = data.task;
  const integrity = data.integrity;
  const ledgerTone = integrity?.ok === false ? "red" : integrity?.ok ? "green" : "amber";
  const marketTone = data.market?.connected ? (data.config.simulation ? "magenta" : "green") : "amber";
  const integrityLabel = integrity ? (integrity.ok ? "VERIFIED" : "BROKEN") : "NOT CHECKED";

  lines.push(
    [
      keyValue(theme, "SYSTEM", data.engineRunning ? "ONLINE" : "IDLE", data.engineRunning ? "green" : "grey"),
      keyValue(
        theme,
        "SECURITY",
        data.config.simulation ? "SIMULATED" : "ACTIVE",
        data.config.simulation ? "magenta" : "green",
      ),
    ].join(compact ? "\n" : "   "),
  );
  lines.push(
    [
      keyValue(
        theme,
        "MARKET",
        data.market?.connected ? (data.config.simulation ? "SIMULATED" : "CONNECTED") : "OFFLINE",
        marketTone,
      ),
      keyValue(theme, "LEDGER", `${integrityLabel} · ${data.receiptCount} RCPT`, ledgerTone),
    ].join(compact ? "\n" : "   "),
  );
  lines.push("");

  if (!task) {
    lines.push(theme.paint("amber", "NO ACTIVE TASK"));
    lines.push("Type a task in plain language, or run `new` to start the guided setup.");
    lines.push(theme.dim("Example: build a production-ready website with auth, dashboard and payments"));
    return panel(theme, "ASH COMMAND", lines, { tone: "cyan", shadow: true });
  }

  const totals = data.ledger ? computeTotalsSafe(data.ledger) : null;
  const authorized = parseAmount(task.authorized_budget, task.currency);
  const completed = task.subtasks.filter((state) => state.phase === "completed").length;
  const failed = task.subtasks.filter((state) => state.phase === "failed" || state.phase === "blocked").length;
  const active = task.subtasks.filter(
    (state) => !["completed", "failed", "cancelled", "blocked"].includes(state.phase),
  );
  const progress = task.subtasks.length === 0 ? 0 : completed / task.subtasks.length;
  const marketBalance = task.market_snapshot?.balances[task.currency] ?? null;

  const projectName = projectLabel(task.track_id, task.project_scopes);
  lines.push(
    `${theme.dim("CURRENT TASK")}  ${theme.bold(clip(task.description, compact ? 42 : 70))}  ${theme.paint("purple", `[${projectName}]`)}`,
  );
  lines.push(
    `${theme.dim("STATUS")}        ${statusTone(theme, task.status)}${task.status_detail ? `  ${theme.dim(clip(task.status_detail, compact ? 40 : 70))}` : ""}`,
  );
  lines.push("");

  lines.push(theme.paint("cyan", "BUDGET"));
  lines.push(`${keyValue(theme, "Authorized", displayMoney(authorized, task.currency), "white")}`);
  lines.push(
    `${keyValue(theme, "Market balance", marketBalance ? `${marketBalance} ${task.currency}${task.market_snapshot?.source === "simulated" ? " (SIM)" : " (snapshot)"}` : "UNREADABLE", marketBalance ? "cyan" : "amber")}`,
  );
  if (totals) {
    lines.push(
      `${keyValue(theme, "Committed", displayMoney(totals.committed, task.currency), totals.committed > 0n ? "amber" : "grey")}`,
    );
    lines.push(
      `${keyValue(theme, "Paid", displayMoney(totals.paid, task.currency), totals.paid > 0n ? "green" : "grey")}`,
    );
    lines.push(
      `${keyValue(theme, "Refunded", displayMoney(totals.refunded, task.currency), totals.refunded > 0n ? "cyan" : "grey")}`,
    );
    lines.push(
      `${keyValue(theme, "Available", displayMoney(totals.available, task.currency), totals.available > 0n ? "green" : "amber")}`,
    );
    lines.push(
      `  ${progressBar(theme, Number(totals.committed + totals.paid), Number(authorized), compact ? 20 : 32, "green")}`,
    );
  }
  if (task.plan) {
    const planned = parseAmount(task.plan.external_planned, task.currency);
    const contingency = parseAmount(task.plan.contingency, task.currency);
    lines.push(`${keyValue(theme, "External plan", displayMoney(planned, task.currency), "purple")}`);
    lines.push(`${keyValue(theme, "Contingency", displayMoney(contingency, task.currency), "purple")}`);
  }
  lines.push("");

  lines.push(theme.paint("cyan", "EXECUTION"));
  lines.push(
    `${keyValue(theme, "Progress", `${completed}/${task.subtasks.length} completed${failed > 0 ? ` · ${failed} failed/blocked` : ""}`, failed > 0 ? "amber" : "green")}`,
  );
  lines.push(
    `  ${progressBar(theme, completed, Math.max(1, task.subtasks.length), compact ? 20 : 32, failed > 0 ? "amber" : "cyan")}`,
  );
  lines.push(
    `${keyValue(theme, "Active", `${active.length} subtask(s) · ${task.max_parallel_jobs} max parallel`, active.length > 0 ? "cyan" : "grey")}`,
  );
  if (active.length > 0) {
    for (const state of active.slice(0, compact ? 3 : 5)) {
      const subtask = task.plan?.subtasks.find((item) => item.id === state.id);
      lines.push(
        `  ${theme.paint("cyan", theme.symbol("bullet"))} ${state.id} ${clip(subtask?.title ?? "", compact ? 28 : 48)} ${theme.dim(state.phase)}`,
      );
    }
    if (active.length > (compact ? 3 : 5)) lines.push(theme.dim(`  … ${active.length - (compact ? 3 : 5)} more`));
  }
  lines.push("");

  lines.push(theme.paint("cyan", "LEDGER & SECURITY"));
  lines.push(`${keyValue(theme, "Receipts", `${data.receiptCount}`, "white")}`);
  lines.push(
    `${keyValue(theme, "Last receipt", task.last_receipt_hash ? `${task.last_receipt_hash.slice(0, 16)}…` : "none", task.last_receipt_hash ? "green" : "grey")}`,
  );
  lines.push(`${keyValue(theme, "Chain", integrity ? integrityLabel : "not checked", ledgerTone)}`);
  lines.push(
    `${keyValue(theme, "Market auth", data.market?.connected ? "connected" : data.config.market.apiToken ? "configured / unreachable" : "not configured", data.market?.connected ? "green" : "amber")}`,
  );
  lines.push(
    `${keyValue(theme, "Approvals", data.pendingApprovals > 0 ? `${data.pendingApprovals} pending` : "none pending", data.pendingApprovals > 0 ? "amber" : "green")}`,
  );
  lines.push(
    `${keyValue(theme, "Hiring gate", data.config.simulation ? "simulation (no funds)" : task.require_hiring_approval ? "human approval per hire" : "plan authority", "purple")}`,
  );
  if (data.marketError) lines.push(theme.paint("amber", clip(`Market: ${data.marketError}`, theme.width - 4)));
  lines.push("");
  const hints = ["commands: status · budget · plan · execute · approvals · transactions · verify · help"];
  lines.push(theme.dim(clip(hints.join("  "), theme.width - 4)));
  const boxed = panel(theme, "ASH COMMAND", lines, { tone: "cyan", shadow: true });
  return boxed;
}

function statusTone(theme: Theme, status: TaskRecord["status"]): string {
  switch (status) {
    case "executing":
      return theme.paint("green", status.toUpperCase());
    case "completed":
      return theme.paint("green", status.toUpperCase());
    case "failed":
      return theme.paint("red", status.toUpperCase());
    case "cancelled":
      return theme.paint("grey", status.toUpperCase());
    case "paused":
      return theme.paint("amber", status.toUpperCase());
    case "awaiting_plan_approval":
      return theme.paint("magenta", status.toUpperCase());
    default:
      return theme.paint("cyan", status.toUpperCase());
  }
}

function computeTotalsSafe(ledger: LedgerRecord): {
  authorized: bigint;
  committed: bigint;
  paid: bigint;
  refunded: bigint;
  available: bigint;
} | null {
  try {
    let authorized = 0n;
    let committed = 0n;
    let paid = 0n;
    let refunded = 0n;
    for (const entry of ledger.entries) {
      const amount = parseAmount(entry.amount, ledger.currency);
      if (entry.kind === "AUTHORIZE" || entry.kind === "ADJUST_UP") authorized += amount;
      else if (entry.kind === "ADJUST_DOWN") authorized -= amount;
      else if (entry.kind === "COMMIT") committed += amount;
      else if (entry.kind === "RELEASE") {
        committed -= amount;
        paid += amount;
      } else if (entry.kind === "REFUND") {
        committed -= amount;
        refunded += amount;
      }
    }
    return { authorized, committed, paid, refunded, available: authorized - committed - paid };
  } catch {
    return null;
  }
}

export function renderTaskTree(theme: Theme, task: TaskRecord): string[] {
  const plan = task.plan;
  if (!plan) return [theme.dim("No plan yet.")];
  const lines: string[] = [];
  plan.subtasks.forEach((subtask, index) => {
    const state = task.subtasks.find((candidate) => candidate.id === subtask.id);
    const phase = state?.phase ?? "pending";
    const glyph =
      phase === "completed"
        ? theme.paint("green", theme.symbol("ok"))
        : phase === "failed" || phase === "blocked"
          ? theme.paint("red", theme.symbol("fail"))
          : phase === "cancelled"
            ? theme.paint("grey", theme.symbol("fail"))
            : phase === "pending"
              ? theme.dim(theme.symbol("pending"))
              : theme.paint("cyan", "◉");
    const branch = index === plan.subtasks.length - 1 ? theme.symbol("lastTree") : theme.symbol("tree");
    const title = clip(subtask.title, Math.max(18, theme.width - 38));
    const price = subtask.execution === "EXTERNAL" ? `${subtask.planned_max} ${task.currency}` : "DIY";
    const phaseText =
      phase === "completed"
        ? theme.paint("green", phase)
        : phase === "failed" || phase === "blocked"
          ? theme.paint("red", phase)
          : phase === "cancelled"
            ? theme.paint("grey", phase)
            : theme.paint("cyan", phase.replaceAll("_", " "));
    lines.push(
      `${theme.dim(branch)} ${glyph} ${theme.bold(subtask.id.padEnd(6))} ${title}  ${theme.dim(price)}  ${phaseText}`,
    );
    if (subtask.dependencies.length > 0) {
      lines.push(theme.dim(`   ↳ after ${subtask.dependencies.join(", ")}`));
    }
  });
  return lines;
}

export function renderPlan(theme: Theme, task: TaskRecord, plan: Plan): string[] {
  const lines: string[] = [];
  lines.push(theme.bold(theme.gradient("EXECUTION PLAN", ["green", "cyan", "purple"])));
  lines.push("");
  lines.push(`${theme.dim("SUMMARY")}  ${plan.summary}`);
  lines.push(`${theme.dim("OUTCOME")}  ${plan.final_outcome}`);
  lines.push(
    `${theme.dim("BUDGET")}   ${plan.authorized_budget} ${plan.currency} · external ${plan.external_planned} · contingency ${plan.contingency}`,
  );
  const scopes = resolveScopes(task.track_id, task.project_scopes);
  if (task.track_id) {
    const label = isProjectId(task.track_id) ? `${PROJECT.name} project` : (scopes[0]?.name ?? "project");
    lines.push(`${theme.dim("PROJECT")}  ${label} — ${scopes.map((scope) => scope.name).join(", ") || "custom scope"}`);
  }
  lines.push("");
  const rows = plan.subtasks.map((subtask) => {
    const state = task.subtasks.find((candidate) => candidate.id === subtask.id);
    const price = subtask.execution === "EXTERNAL" ? `${subtask.planned_max} ${plan.currency}` : "DIY";
    return [subtask.id, subtask.title, subtask.execution, price, state?.phase ?? "pending"];
  });
  lines.push(
    ...table(theme, ["ID", "Subtask", "Mode", "Max", "State"], rows, {
      tones: ["cyan", "white", "purple", "green", "grey"],
    }),
  );
  lines.push("");
  if (plan.assumptions.length > 0) {
    lines.push(theme.paint("purple", "ASSUMPTIONS"));
    for (const assumption of plan.assumptions) lines.push(`  ${theme.symbol("bullet")} ${assumption}`);
  }
  if (plan.risks.length > 0) {
    lines.push(theme.paint("amber", "RISKS"));
    for (const risk of plan.risks) lines.push(`  ${theme.symbol("warn")} ${risk}`);
  }
  lines.push("");
  lines.push(theme.paint("cyan", "DEPENDENCY TREE"));
  lines.push(...renderTaskTree(theme, task));
  return lines;
}

export function renderBudget(
  theme: Theme,
  task: TaskRecord | null,
  ledger: LedgerRecord | null,
  config: AppConfig,
): string[] {
  const lines: string[] = [];
  if (!task || !ledger) return [theme.paint("amber", "No active task ledger.")];
  const totals = computeTotalsSafe(ledger);
  const authorized = parseAmount(task.authorized_budget, task.currency);
  if (totals) {
    lines.push(`${keyValue(theme, "Currency", task.currency, "cyan")}`);
    lines.push(`${keyValue(theme, "Authorized", displayMoney(authorized, task.currency), "white")}`);
    lines.push(
      `${keyValue(theme, "Committed", displayMoney(totals.committed, task.currency), totals.committed > 0n ? "amber" : "grey")}`,
    );
    lines.push(
      `${keyValue(theme, "Paid", displayMoney(totals.paid, task.currency), totals.paid > 0n ? "green" : "grey")}`,
    );
    lines.push(
      `${keyValue(theme, "Refunded", displayMoney(totals.refunded, task.currency), totals.refunded > 0n ? "cyan" : "grey")}`,
    );
    lines.push(`${keyValue(theme, "Available", displayMoney(totals.available, task.currency), "green")}`);
    lines.push(
      `  ${progressBar(theme, Number(totals.committed + totals.paid), Number(authorized), theme.width - 12, "green")}`,
    );
  }
  if (task.plan) {
    const external = parseAmount(task.plan.external_planned, task.currency);
    const contingency = parseAmount(task.plan.contingency, task.currency);
    lines.push("");
    lines.push(`${keyValue(theme, "Planned external", displayMoney(external, task.currency), "purple")}`);
    lines.push(`${keyValue(theme, "Contingency", displayMoney(contingency, task.currency), "purple")}`);
    const remaining = task.plan.subtasks
      .filter((subtask) => subtask.execution === "EXTERNAL")
      .filter((subtask) => {
        const state = task.subtasks.find((candidate) => candidate.id === subtask.id);
        return state && !["completed", "failed", "cancelled", "blocked"].includes(state.phase);
      })
      .reduce((total, subtask) => total + parseAmount(subtask.planned_max, task.currency), 0n);
    lines.push(`${keyValue(theme, "Unspent plan", displayMoney(remaining, task.currency), "cyan")}`);
  }
  if (task.market_snapshot) {
    lines.push("");
    lines.push(
      theme.paint(
        "cyan",
        `MARKET BALANCE — ${task.market_snapshot.source.toUpperCase()} @ ${formatLocal(task.market_snapshot.at)}`,
      ),
    );
    for (const currency of CURRENCIES) {
      const amount = task.market_snapshot.balances[currency];
      if (amount) lines.push(`  ${currency.padEnd(6)} ${amount}`);
    }
    if (task.market_snapshot.credit_usd) lines.push(`  credit_usd ${task.market_snapshot.credit_usd}`);
    lines.push(theme.dim("Account balance is not the task budget. Both limits are enforced separately."));
  } else {
    lines.push("");
    lines.push(theme.paint("amber", "Market balance not read yet. Run `market`."));
  }
  lines.push("");
  lines.push(
    theme.dim(
      `Policy reserve ${(config.policy.contingencyRatio * 100).toFixed(0)}% · max parallel ${config.policy.maxParallelJobs}`,
    ),
  );
  const recent = ledger.entries.slice(-8);
  if (recent.length > 0) {
    lines.push("");
    lines.push(theme.paint("cyan", "RECENT LEDGER ENTRIES"));
    for (const entry of recent) {
      lines.push(
        `${theme.dim(formatLocal(entry.at))} ${theme.paint(entry.kind === "RELEASE" ? "green" : entry.kind === "COMMIT" ? "amber" : "cyan", entry.kind.padEnd(10))} ${entry.amount.padStart(10)} ${entry.currency}  ${clip(entry.description, theme.width - 55)}`,
      );
    }
  }
  lines.push(
    theme.dim(
      `Ledger: ${ledger.task_id} · ${ledger.entries.length} entries · updated ${formatLocal(ledger.updated_at)}`,
    ),
  );
  return lines;
}

export function renderTaskList(theme: Theme, tasks: TaskRecord[]): string[] {
  if (tasks.length === 0) return [theme.dim("No tasks yet.")];
  const rows = tasks.map((task) => [
    task.id,
    clip(task.description, 40),
    projectLabel(task.track_id, task.project_scopes),
    task.status,
    `${task.authorized_budget} ${task.currency}`,
    formatDuration(Date.now() - Date.parse(task.created_at)),
  ]);
  return table(theme, ["Task", "Description", "Project", "Status", "Budget", "Age"], rows, {
    tones: ["cyan", "white", "purple", "green", "green", "grey"],
  });
}

export function planBudgetLine(plan: Plan): string {
  const external = parseAmount(plan.external_planned, plan.currency);
  const contingency = parseAmount(plan.contingency, plan.currency);
  const authorized = parseAmount(plan.authorized_budget, plan.currency);
  const reserve = percentOf(authorized, 0.1);
  return `${formatMinor(external, plan.currency)} external + ${formatMinor(contingency, plan.currency)} reserve (10% = ${formatMinor(reserve, plan.currency)}) of ${formatMinor(authorized, plan.currency)} ${plan.currency}`;
}

export function wrapDescription(text: string, width: number): string[] {
  return wrap(text, width);
}
