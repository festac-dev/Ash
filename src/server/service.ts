import { APP_VERSION } from "../version.js";
import { assertPlanDecisionApplies, ensurePlanApproval } from "../security/plan-approval.js";
import { AshChat } from "../ai/chat.js";
import { exportTaskReport } from "../report.js";
import { publicConfig, type PublicConfigView } from "../config.js";
import type { Services } from "../cli/services.js";
import { attemptMarketConnection, refreshMarketBalance } from "../cli/services.js";
import type { ApprovalRequest, EngineEvent, TaskInput, TaskRecord, TransactionReceipt } from "../domain/types.js";
import { TaskInputSchema } from "../domain/schemas.js";
import { formatIntegrityReport, type IntegrityReport } from "../transactions/ledger.js";
import { summarizeLedger } from "../ledger/ledger.js";
import { AshError, errorMessage } from "../errors.js";
import { hashJson } from "../util/json.js";
import { clip } from "../util/strings.js";
import { formatMinor, parseAmount, type Currency } from "../util/money.js";
import { nowIso } from "../util/time.js";
import { redact } from "../util/redact.js";
import type { JobSummary, MarketAgent, MarketConnectionInfo, WhoAmI } from "../market/types.js";
import type { EventBus } from "./event-bus.js";

export interface TaskSummary {
  id: string;
  description: string;
  status: TaskRecord["status"];
  status_detail: string | null;
  budget: string;
  currency: Currency;
  created_at: string;
  updated_at: string;
  project: string;
  plan_subtasks: number;
  completed_subtasks: number;
}

export interface MarketView {
  mode: "live" | "simulated";
  connected: boolean;
  endpoint: string;
  error: string | null;
  info: MarketConnectionInfo | null;
  whoami: WhoAmI | null;
  balance: Record<string, string>;
  tools: string[];
}

export interface ReceiptView {
  receipt: TransactionReceipt;
  file: string;
}

export interface LedgerView {
  authorized: string;
  committed: string;
  paid: string;
  refunded: string;
  available: string;
  currency: Currency;
}

export interface AshState {
  server: { pid: number; started_at: string; version: string };
  mode: "LIVE" | "SIMULATION";
  engine_running: boolean;
  active_task_id: string | null;
  task: TaskRecord | null;
  tasks: TaskSummary[];
  ledger: LedgerView | null;
  market: MarketView;
  approvals: ApprovalRequest[];
  events: EngineEvent[];
  receipts: ReceiptView[];
  integrity: IntegrityReport | null;
  config: PublicConfigView;
}

export interface PlanResult {
  task: TaskRecord;
  approval: ApprovalRequest | null;
  plan_summary: string;
}

export interface TransactionView {
  integrity: IntegrityReport;
  receipts: ReceiptView[];
  report: string[];
}

export interface SecurityView {
  integrity: IntegrityReport;
  engine_running: boolean;
  approvals: ApprovalRequest[];
  events: EngineEvent[];
  mode: "LIVE" | "SIMULATION";
  limits: {
    max_parallel_jobs: number;
    approval_ttl_minutes: number;
    contingency_ratio: number;
    in_call_spend: boolean;
    market_mode: string;
  };
}

export interface SettingsView {
  config: PublicConfigView;
  task: TaskRecord | null;
}

export class AshService {
  private readonly services: Services;
  private readonly bus: EventBus;
  private readonly startedAt: string;
  private readonly pid: number;
  private marketView: MarketView;
  private controlBusy = false;
  readonly chat: AshChat;

  constructor(services: Services, bus: EventBus, startedAt: string, pid: number) {
    this.services = services;
    this.chat = new AshChat(services.store, services.model, services.config.simulation);
    this.bus = bus;
    this.startedAt = startedAt;
    this.pid = pid;
    this.marketView = {
      mode: services.config.simulation ? "simulated" : "live",
      connected: false,
      endpoint: services.market.endpoint,
      error: null,
      info: null,
      whoami: null,
      balance: {},
      tools: [],
    };
  }

  async initialize(): Promise<void> {
    const connection = await attemptMarketConnection(this.services, 8_000);
    if (connection.connected) {
      try {
        await this.refreshMarket();
      } catch (error) {
        this.marketView.error = redact(errorMessage(error));
      }
    } else {
      this.marketView.error = connection.error;
    }
    await refreshMarketBalance(this.services).catch(() => undefined);
  }

  async state(): Promise<AshState> {
    const activeTaskId = await this.services.store.getActive();
    const task = activeTaskId ? await this.services.store.load(activeTaskId).catch(() => null) : null;
    const ledger = task ? await this.services.store.loadLedger(task.id).catch(() => null) : null;
    const approvals = task
      ? await this.services.store
          .approvals(task.id)
          .pending()
          .catch(() => [])
      : [];
    const events = task ? await this.services.store.readEvents(task.id, 80).catch(() => []) : [];
    const snapshot = await this.services.transactions.inspect(25).catch(() => null);
    const integrity = snapshot?.report ?? null;
    const receipts: ReceiptView[] = (snapshot?.receipts ?? [])
      .map((receipt) => ({ receipt, file: typeof receipt.metadata.file === "string" ? receipt.metadata.file : "" }))
      .reverse();
    const tasks = await this.taskSummaries();
    return {
      server: { pid: this.pid, started_at: this.startedAt, version: APP_VERSION },
      mode: this.services.config.simulation ? "SIMULATION" : "LIVE",
      engine_running: this.services.engine.isRunning(),
      active_task_id: task?.id ?? null,
      task,
      tasks,
      ledger: ledger ? serializeLedger(summarizeLedger(ledger), ledger.currency) : null,
      market: this.marketView,
      approvals,
      events,
      receipts,
      integrity,
      config: publicConfig(this.services.config),
    };
  }

  async timeline(taskId: string) {
    const task = await this.services.store.resolveRef(taskId);
    const ledger = await this.services.store.loadLedger(task.id);
    const events = await this.services.store.readEvents(task.id, 2_001);
    return {
      task_id: task.id,
      currency: task.currency,
      entries: ledger.entries,
      events: events.slice(-2_000),
      events_truncated: events.length > 2_000,
    };
  }

  async exportProof(taskId: string) {
    const task = await this.services.store.resolveRef(taskId);
    return exportTaskReport(this.services.store, this.services.config, task);
  }

  async tasks(): Promise<TaskSummary[]> {
    return this.taskSummaries();
  }

  async task(id: string): Promise<TaskRecord> {
    return this.services.store.resolveRef(id);
  }

  async activateTask(id: string): Promise<TaskRecord> {
    return this.withControl(() => this.activateTaskInternal(id));
  }

  private async activateTaskInternal(id: string): Promise<TaskRecord> {
    const task = await this.services.store.resolveRef(id);
    await this.stopIdleEngine();
    if (this.services.engine.isRunning()) {
      throw new AshError("CONFLICT", "Pause or finish the active execution before switching tasks.");
    }
    await this.services.store.setActive(task.id);
    this.changed(`active task ${task.id}`);
    return task;
  }

  async createTask(body: unknown): Promise<TaskRecord> {
    return this.withControl(() => this.createTaskInternal(body));
  }

  private async createTaskInternal(body: unknown): Promise<TaskRecord> {
    await this.stopIdleEngine();
    if (this.services.engine.isRunning())
      throw new AshError("CONFLICT", "Pause or finish the active execution before creating another task.");
    let input: TaskInput;
    try {
      input = TaskInputSchema.parse(body) as TaskInput;
    } catch (error) {
      throw new AshError(
        "VALIDATION_FAILED",
        "Task input is invalid. Check the description, explicit budget/currency and preference fields.",
        { cause: error },
      );
    }
    const task = await this.services.store.create(input);
    this.changed(`task created ${task.id}`);
    return task;
  }

  async planTask(id: string): Promise<PlanResult> {
    const task = await this.services.store.resolveRef(id);
    if (["executing", "completed", "failed", "cancelled"].includes(task.status)) {
      if (task.plan) {
        return { task, approval: await this.pendingPlanApproval(task), plan_summary: task.plan.summary };
      }
      throw new AshError("CONFLICT", `Task is ${task.status}; cannot create a plan.`);
    }
    if (task.plan) {
      const result = await ensurePlanApproval(this.services.store, task.id);
      this.changed(`plan authorization checked ${task.id}`);
      return { ...result, plan_summary: result.task.plan!.summary };
    }
    if (!this.services.model.available) {
      throw new AshError("MODEL_UNAVAILABLE", "No AI model is configured, so Ash cannot plan.", {
        hint: "Set ASH_MODEL_* or import a reviewed plan through the legacy CLI.",
      });
    }
    const result = await this.services.planner.plan(task);
    let updated = await this.services.store.installPlan(task.id, result.plan);
    let approval: ApprovalRequest | null = null;
    if (updated.execution_strategy === "autonomous") {
      updated = await this.services.store.update(task.id, (current) => {
        if (current.status !== "planned" || hashJson(current.plan) !== result.planHash)
          throw new AshError("CONFLICT", "The task changed while its plan was being installed.");
        current.plan_approved_at = nowIso();
        current.plan_approval_ref = "strategy:autonomous";
        current.status = "planned";
        current.status_detail = "Plan accepted because the human selected the autonomous strategy.";
      });
      await this.services.store.appendEvent(task.id, {
        subtask_id: null,
        level: "info",
        code: "PLAN_ACCEPTED_AUTONOMOUS",
        message: "Plan accepted under the task's autonomous strategy. Marketplace page approvals still apply.",
      });
    } else {
      approval = await this.services.store.approvals(task.id).request({
        kind: "plan",
        summary: `Approve the execution plan for "${clip(task.description, 120)}" — ${result.plan.subtasks.length} subtasks, ${result.plan.external_planned} ${task.currency} external work, ${result.plan.contingency} reserve.`,
        amount: result.plan.external_planned,
        currency: task.currency,
        scope: {
          plan_hash: result.planHash,
          subtasks: String(result.plan.subtasks.length),
          external_planned: result.plan.external_planned,
          contingency: result.plan.contingency,
          currency: task.currency,
          source: "model",
        },
      });
    }
    this.changed(`plan created ${task.id}`);
    return { task: updated, approval, plan_summary: result.plan.summary };
  }

  async approve(
    taskId: string,
    approvalId: string,
    phrase: string,
  ): Promise<{ task: TaskRecord; approval: ApprovalRequest }> {
    const task = await this.services.store.resolveRef(taskId);
    const approvals = this.services.store.approvals(task.id);
    const request = await approvals.get(approvalId);
    if (!request) throw new AshError("NOT_FOUND", `Approval ${approvalId} does not exist.`);
    if (request.status !== "pending")
      throw new AshError("APPROVAL_INVALID", `Approval ${approvalId} is ${request.status}.`);
    if (request.kind === "plan") {
      assertPlanDecisionApplies(task, request);
    }
    if (request.kind === "budget_increase") {
      if (request.scope.currency !== task.currency || request.scope.from !== task.authorized_budget) {
        throw new AshError("APPROVAL_INVALID", "The task budget changed after this request.");
      }
    }
    const decided = await approvals.decide(approvalId, "approved", phrase);
    let updated = task;
    if (request.kind === "plan") {
      updated = await this.services.store.update(task.id, (current) => {
        assertPlanDecisionApplies(current, request);
        current.plan_approved_at = nowIso();
        current.plan_approval_ref = request.id;
        current.status = "planned";
        current.status_detail = "Plan approved by human.";
      });
    } else if (request.kind === "budget_increase") {
      updated = await this.applyBudgetApproval(task, request);
    }
    this.changed(`approval ${approvalId} approved`);
    return { task: updated, approval: decided };
  }

  async deny(
    taskId: string,
    approvalId: string,
    phrase: string,
  ): Promise<{ task: TaskRecord; approval: ApprovalRequest }> {
    const task = await this.services.store.resolveRef(taskId);
    const request = await this.services.store.approvals(task.id).decide(approvalId, "denied", phrase);
    this.changed(`approval ${approvalId} denied`);
    return { task, approval: request };
  }

  async requestBudget(taskId: string, amount: string, currency?: string): Promise<ApprovalRequest> {
    const task = await this.services.store.resolveRef(taskId);
    const requestedCurrency = (currency?.toUpperCase() as Currency | undefined) ?? task.currency;
    if (requestedCurrency !== task.currency) {
      throw new AshError(
        "VALIDATION_FAILED",
        `This task's ledger is in ${task.currency}; budgets cannot switch currency.`,
      );
    }
    const requested = parseAmount(amount, task.currency);
    const ledger = await this.services.store.loadLedger(task.id);
    const totals = summarizeLedger(ledger);
    if (requested < totals.committed + totals.paid) {
      throw new AshError(
        "BUDGET_INVARIANT",
        `New budget is below committed and paid funds (${formatMinor(totals.committed + totals.paid, task.currency)} ${task.currency}).`,
      );
    }
    if (task.plan && requested < parseAmount(task.authorized_budget, task.currency)) {
      const required =
        parseAmount(task.plan.external_planned, task.currency) + parseAmount(task.plan.contingency, task.currency);
      if (requested < required) {
        throw new AshError(
          "BUDGET_INVARIANT",
          `A decrease below the current plan's ${formatMinor(required, task.currency)} ${task.currency} would invalidate it.`,
        );
      }
    }
    const request = await this.services.store.approvals(task.id).request({
      kind: "budget_increase",
      summary: `Change the authorized budget from ${task.authorized_budget} to ${formatMinor(requested, task.currency)} ${task.currency}.`,
      amount: formatMinor(requested, task.currency),
      currency: task.currency,
      scope: { from: task.authorized_budget, to: formatMinor(requested, task.currency), currency: task.currency },
    });
    this.changed(`budget approval requested ${task.id}`);
    return request;
  }

  async execute(taskId: string): Promise<TaskRecord> {
    return this.withControl(() => this.executeInternal(taskId));
  }

  private async executeInternal(taskId: string): Promise<TaskRecord> {
    const task = await this.services.store.resolveRef(taskId);
    if (!task.plan) throw new AshError("CONFLICT", "No plan yet. Create a plan first.");
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      throw new AshError("CONFLICT", `Task is already ${task.status}.`);
    }
    if (task.status === "awaiting_plan_approval") {
      throw new AshError("APPROVAL_REQUIRED", "The plan has not been approved.");
    }
    if (task.plan_approval_ref === null && task.execution_strategy !== "autonomous") {
      throw new AshError("APPROVAL_REQUIRED", "The plan has not been approved.");
    }
    await this.stopIdleEngine();
    if (this.services.engine.isRunning()) {
      throw new AshError("CONFLICT", "The execution engine is already running. Pause or switch tasks first.");
    }
    await this.services.store.setActive(task.id);
    let updated = await this.services.store.update(task.id, (current) => {
      if (["completed", "failed", "cancelled"].includes(current.status))
        throw new AshError("CONFLICT", `Task is already ${current.status}.`);
      if (hashJson(current.plan) !== hashJson(task.plan))
        throw new AshError("CONFLICT", "The plan changed while starting execution.");
      current.status = "executing";
      current.status_detail = null;
      current.updated_at = nowIso();
    });
    try {
      await this.services.engine.start();
    } catch (error) {
      updated = await this.services.store
        .update(task.id, (current) => {
          if (current.status === "executing") {
            current.status = "paused";
            current.status_detail = `Execution could not start: ${errorMessage(error)}`;
          }
        })
        .catch(() => updated);
      throw error;
    }
    this.changed(`execution started ${task.id}`);
    const after = await this.services.store.load(task.id);
    return after;
  }

  async pause(taskId: string): Promise<TaskRecord> {
    const task = await this.services.store.resolveRef(taskId);
    if (task.status !== "executing") throw new AshError("CONFLICT", `Task is ${task.status}, not executing.`);
    const updated = await this.services.store.update(task.id, (current) => {
      if (current.status !== "executing") throw new AshError("CONFLICT", `Task is ${current.status}, not executing.`);
      current.status = "paused";
      current.status_detail = "Paused by human. In-flight operations finish and persist.";
    });
    if (this.services.engine.isRunningTask(task.id)) await this.services.engine.stop();
    this.changed(`execution paused ${task.id}`);
    return updated;
  }

  async resume(taskId: string): Promise<TaskRecord> {
    const task = await this.services.store.resolveRef(taskId);
    if (task.status !== "paused") throw new AshError("CONFLICT", `Task is ${task.status}, not paused.`);
    if (!task.plan) throw new AshError("CONFLICT", "Task has no plan.");
    if (task.plan_approval_ref === null && task.execution_strategy !== "autonomous") {
      throw new AshError("APPROVAL_REQUIRED", "Approve the plan before resuming.");
    }
    const updated = await this.execute(task.id);
    this.changed(`execution resumed ${task.id}`);
    return updated;
  }

  async cancel(taskId: string, phrase: string): Promise<TaskRecord> {
    const task = await this.services.store.resolveRef(taskId);
    if (phrase !== `CANCEL ${task.id}`) {
      throw new AshError("APPROVAL_INVALID", "Cancellation confirmation phrase did not match. Nothing changed.");
    }
    await this.services.engine.cancelTask(task.id, "Cancelled by human from the terminal client.");
    if (this.services.engine.isRunningTask(task.id)) await this.services.engine.stop();
    this.changed(`task cancelled ${task.id}`);
    return this.services.store.load(task.id);
  }

  async review(
    taskId: string,
    subtaskId: string,
    decision: string,
    phrase: string,
    note?: string,
  ): Promise<TaskRecord> {
    const task = await this.services.store.resolveRef(taskId);
    if (decision !== "pass" && decision !== "fail") {
      throw new AshError("VALIDATION_FAILED", "Review decision must be pass or fail.");
    }
    const expected = `REVIEW ${subtaskId} ${decision.toUpperCase()}`;
    if (phrase !== expected) {
      throw new AshError("APPROVAL_INVALID", `Review confirmation phrase did not match (expected ${expected}).`);
    }
    await this.services.engine.reviewSubtask(
      task.id,
      subtaskId,
      decision,
      note?.trim() || `Human ${decision} from the terminal client.`,
    );
    this.changed(`subtask reviewed ${subtaskId}`);
    return this.services.store.load(task.id);
  }

  async market(): Promise<MarketView> {
    const connection = await attemptMarketConnection(this.services);
    if (!connection.connected) {
      this.marketView = { ...this.marketView, connected: false, error: connection.error };
      return this.marketView;
    }
    return this.refreshMarket();
  }

  async agents(query: string): Promise<MarketAgent[]> {
    const connection = await attemptMarketConnection(this.services);
    if (!connection.connected) throw new AshError("MARKET_UNAVAILABLE", connection.error ?? "Marketplace unavailable.");
    return this.services.market.browseAgents({ query: query.trim(), limit: 30 });
  }

  async jobs(): Promise<JobSummary[]> {
    const connection = await attemptMarketConnection(this.services);
    if (!connection.connected) throw new AshError("MARKET_UNAVAILABLE", connection.error ?? "Marketplace unavailable.");
    return this.services.market.listMyJobs(30);
  }

  async transactions(limit = 100): Promise<TransactionView> {
    const snapshot = await this.services.transactions.inspect(Math.max(1, Math.min(500, limit)));
    const integrity = snapshot.report;
    let receipts: ReceiptView[] = [];
    if (integrity.ok) {
      const all = snapshot.receipts;
      receipts = all
        .map((receipt) => ({ receipt, file: typeof receipt.metadata.file === "string" ? receipt.metadata.file : "" }))
        .reverse();
    }
    return { integrity, receipts, report: formatIntegrityReport(integrity) };
  }

  async security(): Promise<SecurityView> {
    const active = await this.services.store.getActive();
    const task = active ? await this.services.store.load(active).catch(() => null) : null;
    const integrity = await this.services.transactions.verify();
    let approvals: ApprovalRequest[] = [];
    let events: EngineEvent[] = [];
    if (task) {
      approvals = await this.services.store
        .approvals(task.id)
        .pending()
        .catch(() => []);
      events = await this.services.store.readEvents(task.id, 80).catch(() => []);
    }
    return {
      integrity,
      engine_running: this.services.engine.isRunning(),
      approvals,
      events,
      mode: this.services.config.simulation ? "SIMULATION" : "LIVE",
      limits: {
        max_parallel_jobs: this.services.config.policy.maxParallelJobs,
        approval_ttl_minutes: this.services.config.policy.approvalTtlMinutes,
        contingency_ratio: this.services.config.policy.contingencyRatio,
        in_call_spend: false,
        market_mode: this.services.config.market.mode,
      },
    };
  }

  async settings(): Promise<SettingsView> {
    const active = await this.services.store.getActive();
    const task = active ? await this.services.store.load(active).catch(() => null) : null;
    return { config: publicConfig(this.services.config), task };
  }

  async updateSetting(taskId: string, key: string, value: string): Promise<TaskRecord> {
    const task = await this.services.store.resolveRef(taskId);
    if (task.status === "executing")
      throw new AshError("CONFLICT", "Pause the task before changing execution preferences.");
    const normalized = key.trim().toLowerCase();
    if (normalized === "budget")
      throw new AshError("APPROVAL_REQUIRED", "Use the budget endpoint; budget changes require explicit approval.");
    const updated = await this.services.store.update(task.id, (current) => {
      if (current.status === "executing")
        throw new AshError("CONFLICT", "Pause the task before changing execution preferences.");
      switch (normalized) {
        case "strategy":
        case "execution_strategy":
          if (!["autonomous", "plan_then_approve", "diy_first"].includes(value)) {
            throw new AshError("VALIDATION_FAILED", "strategy must be autonomous, plan_then_approve or diy_first.");
          }
          if (current.plan)
            throw new AshError("CONFLICT", "A plan already exists. Create a new task to change strategy.");
          current.execution_strategy = value as TaskRecord["execution_strategy"];
          break;
        case "require_hiring_approval":
        case "hire_approval":
          current.require_hiring_approval = parseBool(value);
          break;
        case "max_parallel_jobs": {
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > this.services.config.policy.maxParallelJobs) {
            throw new AshError(
              "VALIDATION_FAILED",
              `max_parallel_jobs must be 1-${this.services.config.policy.maxParallelJobs}.`,
            );
          }
          current.max_parallel_jobs = parsed;
          break;
        }
        case "allow_external":
          current.allow_external = parseBool(value);
          break;
        case "diy_first":
          current.diy_first = parseBool(value);
          break;
        case "deadline":
          if (!value || value.toLowerCase() === "none") current.deadline = null;
          else {
            const parsed = Date.parse(value);
            if (!Number.isFinite(parsed) || parsed <= Date.now())
              throw new AshError("VALIDATION_FAILED", "Deadline must be a future ISO timestamp.");
            current.deadline = new Date(parsed).toISOString();
          }
          break;
        case "quality":
        case "quality_requirements":
          current.quality_requirements = value || null;
          break;
        case "additional_instructions":
        case "instructions":
          current.additional_instructions = value || null;
          break;
        case "preferred_agents":
          current.preferred_agents = value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 10);
          break;
        default:
          throw new AshError("VALIDATION_FAILED", `Unknown setting "${key}".`);
      }
      current.updated_at = nowIso();
    });
    this.changed(`setting ${normalized} updated`);
    return updated;
  }

  async receipt(file: string): Promise<ReceiptView | null> {
    // The caller supplies a filename, never a path. Lookup is in-memory.
    if (!/^Ash_\d{8}_\d{4}(?:_\d+)?\.json$/.test(file)) return null;
    const view = await this.transactions(500);
    return view.receipts.find((entry) => entry.file === file) ?? null;
  }

  private async taskSummaries(): Promise<TaskSummary[]> {
    const tasks = await this.services.store.list(50);
    return tasks.map((task) => ({
      id: task.id,
      description: task.description,
      status: task.status,
      status_detail: task.status_detail,
      budget: task.authorized_budget,
      currency: task.currency,
      created_at: task.created_at,
      updated_at: task.updated_at,
      project: task.track_id ?? "custom",
      plan_subtasks: task.plan?.subtasks.length ?? 0,
      completed_subtasks: task.subtasks.filter((state) => state.phase === "completed").length,
    }));
  }

  private async pendingPlanApproval(task: TaskRecord): Promise<ApprovalRequest | null> {
    const pending = await this.services.store.approvals(task.id).pending();
    return (
      pending.find(
        (request) =>
          request.kind === "plan" &&
          request.scope.plan_hash === hashJson(task.plan) &&
          request.scope.currency === task.currency &&
          request.currency === task.currency,
      ) ?? null
    );
  }

  private async withControl<T>(operation: () => Promise<T>): Promise<T> {
    if (this.controlBusy)
      throw new AshError("CONFLICT", "Another task control operation is in progress. Try again when it finishes.");
    this.controlBusy = true;
    try {
      return await operation();
    } finally {
      this.controlBusy = false;
    }
  }

  private async stopIdleEngine(): Promise<void> {
    if (!this.services.engine.isRunning()) return;
    const active = await this.services.store.getActive();
    const current = active ? await this.services.store.load(active).catch(() => null) : null;
    if (current?.status === "executing") return;
    await this.services.engine.stop();
  }

  private async applyBudgetApproval(task: TaskRecord, request: ApprovalRequest): Promise<TaskRecord> {
    const next = request.scope.to;
    const currency = request.scope.currency as Currency;
    if (!next || currency !== task.currency)
      throw new AshError("APPROVAL_INVALID", "Budget approval scope is incomplete.");
    const updated = await this.services.store.applyBudgetApproval(task.id, request.id);
    const ledger = await this.services.store.loadLedger(task.id);
    await this.services.store.appendEvent(task.id, {
      subtask_id: null,
      level: "success",
      code: "BUDGET_CHANGED",
      message: `Authorized budget changed to ${next} ${currency}. Available: ${formatMinor(summarizeLedger(ledger).available, currency)}.`,
    });
    return updated;
  }

  private async refreshMarket(): Promise<MarketView> {
    const info = await this.services.market.connect();
    const who = await this.services.market.whoami().catch(() => null);
    const caps = this.services.market.capabilities();
    this.marketView = {
      mode: this.services.config.simulation ? "simulated" : "live",
      connected: true,
      endpoint: this.services.market.endpoint,
      error: null,
      info,
      whoami: who,
      balance: who?.account?.balances ?? {},
      tools: caps.tools,
    };
    return this.marketView;
  }

  private changed(reason: string): void {
    this.bus.publish({ type: "refresh", reason });
  }
}

function serializeLedger(totals: ReturnType<typeof summarizeLedger>, currency: Currency): LedgerView {
  return {
    authorized: formatMinor(totals.authorized, currency),
    committed: formatMinor(totals.committed, currency),
    paid: formatMinor(totals.paid, currency),
    refunded: formatMinor(totals.refunded, currency),
    available: formatMinor(totals.available, currency),
    currency,
  };
}

function parseBool(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(normalized)) return true;
  if (["false", "no", "0", "off"].includes(normalized)) return false;
  throw new AshError("VALIDATION_FAILED", `Expected true/false, got "${value}".`);
}
