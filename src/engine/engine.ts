import path from "node:path";
import { promises as fs } from "node:fs";
import { AshError, errorMessage, isAshError } from "../errors.js";
import type { AppConfig } from "../config.js";
import type {
  ApprovalKind,
  AttemptRecord,
  DeliveryRecord,
  EngineEvent,
  LedgerRecord,
  Plan,
  SubtaskPlan,
  SubtaskState,
  TaskRecord,
  TransactionReceipt,
  VerificationResult,
} from "../domain/types.js";
import { computeReadiness, stateById, subtaskById } from "../domain/plan.js";
import { TaskStore } from "../state/store.js";
import { summarizeLedger, commitEscrow, releaseEscrow, refundEscrow } from "../ledger/ledger.js";
import { TransactionLedger } from "../transactions/ledger.js";
import { ensurePlanApproval } from "../security/plan-approval.js";
import { ApprovalManager } from "../security/approvals.js";
import { safeFetchDeliverable } from "../security/guard.js";
import { DeliverableVerifier, type ManualReview } from "../ai/verifier.js";
import { DiyWorker } from "../ai/worker.js";
import type { ModelAdapter } from "../ai/model.js";
import type { DeliverableFile, JobBid, MarketAdapter, PrepareJobResult, WhoAmI } from "../market/types.js";
import { discoverCandidates, marketFundsFor } from "../market/discovery.js";
import { NegotiationEngine } from "../market/negotiation.js";
import { formatMinor, parseAmount, type Currency } from "../util/money.js";
import { atomicWriteFile, resolveArtifactPath } from "../util/fs.js";
import { newRequestId } from "../util/ids.js";
import { hashJson, sha256Hex } from "../util/json.js";
import { addSeconds, nowIso } from "../util/time.js";
import { clip, scanForPromptInjection, sanitizeUntrustedText } from "../util/strings.js";
import { logger } from "../logger.js";
import {
  ACTIVE_PHASES,
  activeAttempt,
  bidPollSeconds,
  buildHireBrief,
  isTerminal,
  jobPollSeconds,
  readDeliveryText,
  receiptStatusFor,
  safeDownloadName,
  SCHEDULABLE_PHASES,
  verificationFeedback,
  workspaceForAttempt,
} from "./helpers.js";

export interface EngineOptions {
  config: AppConfig;
  store: TaskStore;
  market: MarketAdapter;
  model: ModelAdapter;
  onEvent?: (event: EngineEvent) => void;
}

type Outcome = "paid" | "unpaid" | "rejected" | "failed" | "walked_away" | "cancelled";

interface FinalizeOptions {
  outcome: Outcome;
  reason: string;
  paymentStatus: TransactionReceipt["payment_status"];
  release?: boolean;
  refund?: boolean;
  verification?: VerificationResult | null;
  metadata?: Record<string, string>;
}

const MAX_DELIVERY_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_BID_WAIT_MS = 5 * 60 * 1_000;

export class ExecutionEngine {
  private readonly config: AppConfig;
  private readonly store: TaskStore;
  private readonly market: MarketAdapter;
  private readonly model: ModelAdapter;
  private readonly onEvent: ((event: EngineEvent) => void) | undefined;
  private readonly transactions: TransactionLedger;
  private readonly verifier: DeliverableVerifier;
  private readonly diy: DiyWorker;
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly manualReviews = new Set<string>();
  private releaseLock: (() => Promise<void>) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private lifecycle = 0;
  private startingTaskId: string | null = null;
  private tickBusy = false;
  private idleStopScheduled = false;
  private boundTaskId: string | null = null;

  constructor(options: EngineOptions) {
    this.config = options.config;
    this.store = options.store;
    this.market = options.market;
    this.model = options.model;
    this.onEvent = options.onEvent;
    this.transactions = new TransactionLedger(this.config.dataDir);
    this.verifier = new DeliverableVerifier(this.config, this.model);
    this.diy = new DiyWorker(this.config, this.model);
  }

  async start(): Promise<void> {
    if (this.stopping)
      throw new AshError(
        "CONFLICT",
        "The execution engine is still stopping. Wait for in-flight operations to finish.",
      );
    if (this.running) return;
    if (this.starting) throw new AshError("CONFLICT", "The execution engine is already starting.");
    const work = this.startInternal(this.lifecycle);
    this.starting = work;
    try {
      await work;
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      this.starting = null;
      this.startingTaskId = null;
    }
  }

  private async startInternal(generation: number): Promise<void> {
    const taskId = await this.activeTaskId();
    this.startingTaskId = taskId;
    const task = await this.store.load(taskId);
    if (task.status !== "executing") {
      throw new AshError("CONFLICT", `Task is ${task.status}; run \`execute\` after the plan is approved.`);
    }
    if (!task.plan) throw new AshError("STATE_INVALID", "Task has no plan.");
    if (
      task.subtasks.some((state) =>
        state.attempts.some((attempt) => attempt.payment_status === "RECONCILIATION_REQUIRED"),
      )
    ) {
      throw new AshError(
        "CONFLICT",
        "Funded job evidence needs reconciliation with the marketplace before execution can resume. No new work was started.",
      );
    }
    await this.assertPlanApproval(task);
    await this.reconcileReceipts(task.id);
    const reconciled = await this.store.load(task.id);
    if (reconciled.status !== "executing") return;
    if (generation !== this.lifecycle) return;
    const release = await this.store.acquireEngineLock(task.id);
    const latest = await this.store.load(task.id).catch(async (error) => {
      await release();
      throw error;
    });
    if (generation !== this.lifecycle || latest.status !== "executing") {
      await release();
      return;
    }
    this.releaseLock = release;
    this.boundTaskId = task.id;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.failEngine(task.id, error));
    }, 1_500);
    this.timer.unref();
    await this.tick();
  }

  private async assertPlanApproval(task: TaskRecord): Promise<void> {
    const result = await ensurePlanApproval(this.store, task.id, { allowExecuting: true });
    if (result.approval)
      throw new AshError("APPROVAL_REQUIRED", `Approve the plan before execution: ${result.approval.id}.`, {
        hint: `Open Security or run approve ${result.approval.id} to review the request.`,
      });
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const work = this.stopInternal();
    this.stopping = work;
    try {
      await work;
    } finally {
      this.stopping = null;
    }
  }

  private async stopInternal(): Promise<void> {
    this.lifecycle++;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.starting) await this.starting.catch(() => undefined);
    await Promise.allSettled([...this.inflight.values()]);
    if (this.releaseLock) {
      await this.releaseLock();
      this.releaseLock = null;
    }
    this.boundTaskId = null;
  }

  isRunning(): boolean {
    return this.running || this.starting !== null || this.stopping !== null;
  }

  isRunningTask(taskId: string): boolean {
    return this.isRunning() && (this.boundTaskId === taskId || this.startingTaskId === taskId);
  }

  /**
   * Crash recovery: if a receipt exists for a subtask, that subtask already
   * reached a terminal state. Mark it terminal instead of repeating the work
   * or the payment.
   */
  private async reconcileReceipts(taskId: string): Promise<void> {
    const receipts = (await this.transactions.list()).filter((receipt) => receipt.task_id === taskId);
    if (receipts.length === 0) return;
    const byKey = new Map(receipts.map((receipt) => [receipt.idempotency_key, receipt]));
    await this.store.update(taskId, (task) => {
      for (const state of task.subtasks) {
        if (state.receipt_id) continue;
        const receipt = byKey.get(`${task.id}:${state.id}`);
        if (!receipt) continue;
        state.receipt_id = receipt.transaction_id;
        state.phase =
          receipt.status === "PAID" || receipt.status === "SIMULATED" || receipt.status === "UNPAID"
            ? "completed"
            : receipt.status === "CANCELLED"
              ? "cancelled"
              : "failed";
        state.completed_at = receipt.timestamp;
        state.next_check_at = null;
        state.updated_at = nowIso();
        state.last_error = state.phase === "failed" ? (state.last_error ?? "Receipt recorded before restart.") : null;
      }
      const last = receipts.at(-1);
      if (last) {
        task.last_receipt_hash = last.hash;
        task.last_receipt_file = typeof last.metadata.file === "string" ? last.metadata.file : null;
      }
    });
    await this.finalizeTaskIfDone(taskId);
  }

  private async activeTaskId(): Promise<string> {
    if (this.boundTaskId) return this.boundTaskId;
    const active = await this.store.getActive();
    if (!active) throw new AshError("NOT_FOUND", "No active task. Use `new` first.");
    return active;
  }

  private async tick(): Promise<void> {
    if (!this.running || this.tickBusy) return;
    const generation = this.lifecycle;
    this.tickBusy = true;
    try {
      const taskId = await this.activeTaskId();
      const task = await this.store.load(taskId);
      if (task.status !== "executing") return;
      const plan = task.plan;
      if (!plan) return;

      const readiness = computeReadiness(task, plan);
      for (const blocked of readiness.blocked) {
        if (blocked.state.phase === "blocked" || isTerminal(blocked.state.phase)) continue;
        await this.setPhase(taskId, blocked.state.id, "blocked", null, blocked.reason);
        await this.emit(taskId, blocked.state.id, "warn", "SUBTASK_BLOCKED", `${blocked.state.id}: ${blocked.reason}`);
      }

      const deadlinePassed = task.deadline !== null && Date.parse(task.deadline) <= Date.now();
      const states = task.subtasks;
      const activeCount = states.filter(
        (state) => ACTIVE_PHASES.has(state.phase) || this.inflight.has(`${taskId}:${state.id}`),
      ).length;
      const slots = Math.max(0, task.max_parallel_jobs - activeCount);
      const now = Date.now();
      const dueAll = states
        .filter((state) => SCHEDULABLE_PHASES.has(state.phase))
        .filter((state) => !this.inflight.has(`${taskId}:${state.id}`))
        .filter((state) => state.next_check_at === null || Date.parse(state.next_check_at) <= now)
        .filter((state) => !(deadlinePassed && (state.phase === "pending" || state.phase === "ready")));
      const dueActive = dueAll.filter((state) => state.phase !== "pending" && state.phase !== "ready");
      const readyIds = new Set(readiness.ready.map((state) => state.id));
      const dueNew = dueAll.filter((state) => readyIds.has(state.id)).slice(0, slots);
      const due = [...dueActive, ...dueNew];

      if (deadlinePassed && activeCount === 0) {
        for (const state of states) {
          if (state.phase === "pending" || state.phase === "ready") {
            await this.setPhase(taskId, state.id, "blocked", null, "Task deadline passed before this subtask started.");
          }
        }
        await this.finalizeTaskIfDone(taskId);
        return;
      }

      if (!this.running || generation !== this.lifecycle) return;
      for (const state of due) {
        const key = `${taskId}:${state.id}`;
        const promise = this.advance(taskId, state.id)
          .catch((error) => this.handleAdvanceError(taskId, state.id, error))
          .finally(() => this.inflight.delete(key));
        this.inflight.set(key, promise);
      }

      if (this.inflight.size === 0) {
        await this.finalizeTaskIfDone(taskId);
      }
    } finally {
      this.tickBusy = false;
    }
  }

  private async advance(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const state = stateById(task, subtaskId);
    const subtask = subtaskById(task, subtaskId);
    switch (state.phase) {
      case "pending":
      case "ready":
        if (subtask.execution === "DIY" || !task.allow_external) {
          await this.beginAttempt(taskId, subtaskId, "DIY");
          await this.runDiy(taskId, subtaskId);
        } else if (this.config.market.hiringMode === "board" && this.market.capabilities().can_board) {
          await this.startBoard(taskId, subtaskId);
        } else {
          await this.beginAttempt(taskId, subtaskId, "EXTERNAL");
          await this.discover(taskId, subtaskId);
        }
        return;
      case "running_diy":
        await this.runDiy(taskId, subtaskId);
        return;
      case "discovering":
        await this.discover(taskId, subtaskId);
        return;
      case "awaiting_hire_approval":
        await this.checkHireApproval(taskId, subtaskId);
        return;
      case "preparing_draft":
        await this.prepareHire(taskId, subtaskId);
        return;
      case "awaiting_market_approval":
        await this.pollDraft(taskId, subtaskId);
        return;
      case "waiting_bids":
        await this.pollBids(taskId, subtaskId);
        return;
      case "awaiting_market_award":
        await this.pollAward(taskId, subtaskId);
        return;
      case "waiting_job":
        await this.pollJob(taskId, subtaskId);
        return;
      case "verifying":
        await this.verifyAttempt(taskId, subtaskId);
        return;
      case "awaiting_acceptance_approval":
        await this.checkAcceptApproval(taskId, subtaskId);
        return;
      case "awaiting_market_acceptance":
        await this.pollAcceptance(taskId, subtaskId);
        return;
      case "awaiting_human_review":
      case "blocked":
      case "completed":
      case "failed":
      case "cancelled":
        return;
    }
  }

  private async beginAttempt(
    taskId: string,
    subtaskId: string,
    kind: "DIY" | "EXTERNAL",
    options: { revisionOf?: number; feedback?: string | null; hiringMode?: "direct" | "board" } = {},
  ): Promise<AttemptRecord> {
    const task = await this.store.update(taskId, (current) => {
      if (current.status !== "executing")
        throw new AshError("CONFLICT", "Task stopped before the attempt could start.");
      const state = stateById(current, subtaskId);
      if (isTerminal(state.phase)) throw new AshError("CONFLICT", "Subtask is already terminal.");
      if (state.receipt_id)
        throw new AshError("CONFLICT", "Subtask already has a receipt; refusing a duplicate attempt.");
      const attemptNumber = Math.max(0, ...state.attempts.map((attempt) => attempt.attempt)) + 1;
      if (attemptNumber > 4) throw new AshError("CONFLICT", "Attempt limit reached for this subtask.");
      const previous = options.revisionOf
        ? (state.attempts.find((attempt) => attempt.attempt === options.revisionOf) ?? null)
        : null;
      const attempt: AttemptRecord = {
        attempt: attemptNumber,
        kind,
        status: "running",
        started_at: nowIso(),
        funded_at: previous?.funded_at ?? null,
        market_posted_at: previous?.market_posted_at ?? null,
        board_post_attempted_at: previous?.board_post_attempted_at ?? null,
        completed_at: null,
        vendor: previous?.vendor ?? null,
        job_id: previous?.job_id ?? null,
        draft_id: previous?.draft_id ?? null,
        assignment_id: previous?.assignment_id ?? null,
        approval_url: previous?.approval_url ?? null,
        client_request_id: previous?.client_request_id ?? newRequestId(),
        card_id: previous?.card_id ?? null,
        hiring_mode: kind === "EXTERNAL" ? (options.hiringMode ?? previous?.hiring_mode ?? "direct") : null,
        candidate_index: previous?.candidate_index ?? 0,
        bid_id: previous?.bid_id ?? null,
        approval_ref: previous?.approval_ref ?? null,
        acceptance_approval_ref: null,
        revision_feedback: options.feedback ?? null,
        quoted_price: previous?.quoted_price ?? null,
        negotiated_price: previous?.negotiated_price ?? null,
        agreed_price: previous?.agreed_price ?? null,
        currency: current.currency,
        negotiation_log: previous?.negotiation_log ?? [],
        delivery: null,
        verification: null,
        revision_requested: previous?.revision_requested ?? false,
        market_state: previous?.market_state ?? null,
        payment_status: previous?.payment_status ?? null,
        last_error: null,
      };
      state.attempts.push(attempt);
      state.active_attempt = attemptNumber;
      state.phase = kind === "DIY" ? "running_diy" : "discovering";
      state.started_at ??= nowIso();
      state.completed_at = null;
      state.receipt_id = null;
      state.last_error = null;
      state.blocked_reason = null;
      state.updated_at = nowIso();
      state.next_check_at = null;
    });
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt) throw new AshError("STATE_INVALID", "Failed to create an attempt.");
    return attempt;
  }

  private async setPhase(
    taskId: string,
    subtaskId: string,
    phase: SubtaskState["phase"],
    nextCheckSeconds: number | null,
    lastError: string | null = null,
  ): Promise<void> {
    await this.store.update(taskId, (task) => {
      const state = stateById(task, subtaskId);
      if (task.status === "cancelled" || isTerminal(state.phase)) return;
      state.phase = phase;
      state.updated_at = nowIso();
      state.next_check_at = nextCheckSeconds === null ? null : addSeconds(nowIso(), nextCheckSeconds);
      if (lastError !== null) state.last_error = clip(lastError, 2_000);
    });
  }

  private async emit(
    taskId: string,
    subtaskId: string | null,
    level: EngineEvent["level"],
    code: string,
    message: string,
  ): Promise<void> {
    try {
      const event = await this.store.appendEvent(taskId, {
        subtask_id: subtaskId,
        level,
        code,
        message: clip(message, 2_000),
      });
      this.onEvent?.(event);
      if (level === "error" || level === "warn") {
        logger.warn("Engine event", { task_id: taskId, subtask_id: subtaskId, code });
      }
    } catch (error) {
      logger.error("Could not persist engine event", { error: errorMessage(error), code });
    }
  }

  private async refreshWhoAmI(taskId: string): Promise<WhoAmI | null> {
    try {
      const who = await this.market.whoami();
      await this.store.update(taskId, (task) => {
        task.market_snapshot = {
          at: nowIso(),
          source: this.config.simulation ? "simulated" : "whoami",
          account_id: who.account?.id ?? null,
          handle: who.user_handle,
          balances: who.account?.balances ?? {},
          credit_usd: who.account?.credit_usd ?? null,
          note: who.note,
        };
      });
      return who;
    } catch (error) {
      logger.warn("Could not read marketplace balance", { task_id: taskId, error: errorMessage(error) });
      return null;
    }
  }

  private async discover(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const state = stateById(task, subtaskId);
    const subtask = subtaskById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt) throw new AshError("STATE_INVALID", "No active attempt for discovery.");
    if (!task.allow_external) {
      await this.fallbackOrWalkAway(taskId, subtaskId, "External hiring is disabled for this task.");
      return;
    }
    if (attempt.candidate_index >= this.config.policy.maxAgentCandidates) {
      await this.fallbackOrWalkAway(
        taskId,
        subtaskId,
        "No suitable marketplace agent remained within the subtask maximum.",
      );
      return;
    }

    const query = [...subtask.skills, subtask.title].join(" ").trim() || task.description.slice(0, 120);
    let agents = await this.market.browseAgents({ query, limit: 20 });
    if (agents.length === 0)
      agents = await this.market.browseAgents({ query: task.description.slice(0, 120), limit: 20 });
    for (const preferred of task.preferred_agents) {
      if (
        agents.some(
          (agent) =>
            agent.id === preferred ||
            agent.handle === preferred ||
            agent.name.toLowerCase() === preferred.toLowerCase(),
        )
      ) {
        continue;
      }
      try {
        agents.push(await this.market.getAgent(preferred));
      } catch {
        // A preferred name may not resolve; the browse results still apply.
      }
    }

    const plannedMax = parseAmount(subtask.planned_max, task.currency);
    const discovered = discoverCandidates(agents, {
      currency: task.currency,
      plannedMax,
      preferredAgents: task.preferred_agents,
      queryTerms: [...subtask.skills, subtask.title],
    });
    if (discovered.eligible.length === 0) {
      const reasons = discovered.rejected.slice(0, 3).map((item) => `${item.agent.name}: ${item.reason}`);
      await this.fallbackOrWalkAway(
        taskId,
        subtaskId,
        `No agent meets the ${formatMinor(plannedMax, task.currency)} ${task.currency} maximum and currency rail. ${reasons.join("; ")}`,
      );
      return;
    }

    const candidate = discovered.eligible[attempt.candidate_index];
    if (!candidate) {
      await this.fallbackOrWalkAway(taskId, subtaskId, "No further suitable agent remains within the subtask maximum.");
      return;
    }
    let agent = candidate.agent;
    let price = candidate.price;
    try {
      const detailed = await this.market.getAgent(agent.id);
      if (detailed.price) {
        price = parseAmount(detailed.price, task.currency);
      }
      agent = { ...agent, ...detailed, payable_with: detailed.payable_with ?? agent.payable_with };
    } catch (error) {
      logger.warn("Could not read selected agent profile; using browse data", {
        agent_id: agent.id,
        error: errorMessage(error),
      });
    }
    if (price > plannedMax) {
      await this.nextCandidate(
        taskId,
        subtaskId,
        `Agent ${agent.name} quote ${formatMinor(price, task.currency)} exceeds the planned maximum.`,
      );
      return;
    }
    if (!agent.payable_with?.includes(task.currency)) {
      await this.nextCandidate(taskId, subtaskId, `Agent ${agent.name} does not accept ${task.currency}.`);
      return;
    }

    const who = await this.refreshWhoAmI(taskId);
    if (!who) {
      await this.nextCandidate(taskId, subtaskId, "Marketplace balance could not be read; Ash will not hire blindly.");
      return;
    }
    const funds = marketFundsFor(who, task.currency);
    if (funds === null) {
      await this.nextCandidate(
        taskId,
        subtaskId,
        `The market's ${task.currency} balance is unreadable; refusing to hire.`,
      );
      return;
    }
    if (funds < price) {
      await this.nextCandidate(
        taskId,
        subtaskId,
        `Market balance ${formatMinor(funds, task.currency)} ${task.currency} cannot cover the ${formatMinor(price, task.currency)} quote.`,
      );
      return;
    }
    const ledger = await this.store.loadLedger(taskId);
    const totals = summarizeLedger(ledger);
    if (totals.committed + totals.paid + price > totals.authorized) {
      await this.fallbackOrWalkAway(taskId, subtaskId, "The quote would exceed the authorized task budget.");
      return;
    }

    await this.store.update(taskId, (current) => {
      const currentState = stateById(current, subtaskId);
      const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
      if (!currentAttempt) return;
      currentAttempt.vendor = { id: agent.id, name: agent.name, handle: agent.handle };
      currentAttempt.quoted_price = formatMinor(price, task.currency);
      currentAttempt.negotiated_price = formatMinor(price, task.currency);
      currentAttempt.currency = task.currency;
      currentAttempt.last_error = null;
    });

    const needsApproval = task.require_hiring_approval || this.config.market.mode === "pro";
    if (needsApproval) {
      const approvals = this.store.approvals(taskId);
      const request = await approvals.request({
        kind: this.config.market.mode === "pro" ? "market_spend" : "hire",
        summary: `Hire ${agent.name} (${agent.id}) for "${subtask.title}" at ${formatMinor(price, task.currency)} ${task.currency}.`,
        amount: formatMinor(price, task.currency),
        currency: task.currency,
        scope: {
          subtask_id: subtask.id,
          vendor_id: agent.id,
          vendor_name: agent.name,
          amount: formatMinor(price, task.currency),
          currency: task.currency,
          planned_max: subtask.planned_max,
        },
      });
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (currentAttempt) currentAttempt.approval_ref = request.id;
        currentState.phase = "awaiting_hire_approval";
        currentState.next_check_at = addSeconds(nowIso(), this.config.simulation ? 1 : 5);
        currentState.updated_at = nowIso();
      });
      await this.emit(
        taskId,
        subtaskId,
        "info",
        "HIRE_APPROVAL_REQUIRED",
        `Approval ${request.id} required to hire ${agent.name} for ${formatMinor(price, task.currency)} ${task.currency}. Run \`approve ${request.id}\`.`,
      );
      return;
    }

    await this.store.update(taskId, (current) => {
      const currentState = stateById(current, subtaskId);
      const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
      if (currentAttempt && !currentAttempt.approval_ref && current.plan_approval_ref?.startsWith("apr_")) {
        currentAttempt.approval_ref = current.plan_approval_ref;
      }
      currentState.phase = "preparing_draft";
      currentState.next_check_at = null;
      currentState.updated_at = nowIso();
    });
    await this.emit(
      taskId,
      subtaskId,
      "info",
      "AGENT_SELECTED",
      `Selected ${agent.name} at ${formatMinor(price, task.currency)} ${task.currency}.`,
    );
  }

  private async nextCandidate(taskId: string, subtaskId: string, reason: string): Promise<void> {
    await this.store.update(taskId, (task) => {
      const state = stateById(task, subtaskId);
      const attempt = activeAttempt(state.attempts, state.active_attempt);
      if (attempt) {
        attempt.candidate_index += 1;
        attempt.vendor = null;
        attempt.quoted_price = null;
        attempt.negotiated_price = null;
        attempt.agreed_price = null;
        attempt.approval_ref = null;
        attempt.draft_id = null;
        attempt.approval_url = null;
        attempt.job_id = null;
        attempt.assignment_id = null;
        attempt.bid_id = null;
        attempt.payment_status = null;
        attempt.client_request_id = newRequestId();
        attempt.last_error = clip(reason, 2_000);
      }
      state.phase = "discovering";
      state.next_check_at = null;
      state.updated_at = nowIso();
    });
    await this.emit(taskId, subtaskId, "warn", "AGENT_REJECTED", reason);
  }

  private async fallbackOrWalkAway(taskId: string, subtaskId: string, reason: string): Promise<void> {
    const task = await this.store.load(taskId);
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (task.diy_first && this.model.available && attempt?.kind === "EXTERNAL") {
      await this.beginAttempt(taskId, subtaskId, "DIY", {
        revisionOf: attempt.attempt,
        feedback: `External sourcing failed: ${reason}. Attempt this subtask locally as a fallback.`,
      });
      await this.emit(
        taskId,
        subtaskId,
        "warn",
        "DIY_FALLBACK",
        `No affordable external vendor: ${reason} Falling back to a local attempt, clearly recorded.`,
      );
      return;
    }
    await this.finalize(taskId, subtaskId, {
      outcome: "walked_away",
      reason,
      paymentStatus: "NOT_PAID",
      metadata: { reason },
    });
  }

  /** Revalidate at the operation boundary, including after a restart or expiry. */
  private async ensureHireApproval(task: TaskRecord, subtaskId: string): Promise<boolean> {
    const subtask = subtaskById(task, subtaskId);
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt) return false;
    const board = attempt.hiring_mode === "board";
    const post = board && !attempt.job_id;
    const required = post || task.require_hiring_approval || (!board && this.config.market.mode === "pro");
    // A plan reference on an ungated direct hire is audit evidence, not a hire decision.
    if (!required && (!attempt.approval_ref || attempt.approval_ref === task.plan_approval_ref)) return true;
    const kind: ApprovalKind = post
      ? "hire"
      : board
        ? "award"
        : this.config.market.mode === "pro"
          ? "market_spend"
          : "hire";
    const amount = post
      ? subtask.planned_max
      : board
        ? (attempt.agreed_price ?? attempt.negotiated_price ?? "")
        : (attempt.quoted_price ?? "");
    const scope: Record<string, string> = post
      ? { mode: "board_post", subtask_id: subtaskId, amount, currency: task.currency }
      : board
        ? { subtask_id: subtaskId, job_id: attempt.job_id ?? "", bid_id: attempt.bid_id ?? "", amount }
        : { subtask_id: subtaskId, vendor_id: attempt.vendor?.id ?? "", amount, currency: task.currency };
    const manager = this.store.approvals(task.id);
    const approval = attempt.approval_ref ? await manager.get(attempt.approval_ref) : null;
    if (!approval || approval.status === "expired") {
      const fresh = await manager.request({
        kind,
        summary: post
          ? `Publish a PUBLIC marketplace job for "${subtask.title}" with a ${amount} ${task.currency} guide price.`
          : `${board ? "Award" : "Hire"} ${attempt.vendor?.name ?? "marketplace vendor"} for "${subtask.title}" at ${amount} ${task.currency}.`,
        amount,
        currency: task.currency,
        scope: post
          ? {
              ...scope,
              public: "true",
              title: subtask.title,
              brief_preview: buildHireBrief(task, subtask, true).slice(0, 500),
            }
          : scope,
      });
      await this.store.update(task.id, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (currentAttempt) currentAttempt.approval_ref = fresh.id;
        currentState.phase = "awaiting_hire_approval";
        currentState.next_check_at = addSeconds(nowIso(), 5);
      });
      await this.emit(
        task.id,
        subtaskId,
        "warn",
        "HIRE_APPROVAL_REQUIRED",
        `Approval missing or expired. Fresh approval ${fresh.id} is required before continuing.`,
      );
      return false;
    }
    if (approval.status === "denied") {
      await this.finalize(task.id, subtaskId, {
        outcome: "walked_away",
        reason: `Hiring approval ${approval.id} was denied; no hire or award was made.`,
        paymentStatus: "NOT_PAID",
        metadata: { approval_id: approval.id },
      });
      return false;
    }
    if (approval.status !== "approved") {
      await this.setPhase(task.id, subtaskId, "awaiting_hire_approval", 5);
      return false;
    }
    if (approval.kind !== kind || !this.approvalCovers(approval, scope)) {
      await this.pauseTask(task.id, `Approval ${approval.id} does not match the hiring action. Refusing to continue.`);
      return false;
    }
    return true;
  }

  private async checkHireApproval(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing" || !(await this.ensureHireApproval(task, subtaskId))) return;
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt) return;
    if (attempt.hiring_mode === "board") {
      if (!attempt.job_id) await this.postBoardApproved(taskId, subtaskId);
      else if (attempt.bid_id) await this.awardApproved(taskId, subtaskId);
    } else {
      await this.setPhase(taskId, subtaskId, "preparing_draft", null);
    }
  }

  private async prepareHire(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const state = stateById(task, subtaskId);
    const subtask = subtaskById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt?.vendor) {
      await this.setPhase(taskId, subtaskId, "discovering", null, "No vendor selected yet.");
      return;
    }
    if (!(await this.ensureHireApproval(task, subtaskId))) return;
    const brief = buildHireBrief(task, subtask, false);
    let result: PrepareJobResult;
    try {
      // The advertised create_job contract has no binding price ceiling.
      // Even in pro mode use a draft so a changed price cannot charge in-call.
      if (!this.market.capabilities().can_prepare_job) {
        throw new AshError(
          "MARKET_CAPABILITY_MISSING",
          "Safe hiring requires prepare_job; unbounded in-call charges are disabled.",
        );
      }
      result = await this.market.prepareJob({
        worker_agent_id: attempt.vendor.id,
        title: subtask.title,
        description: brief,
        client_request_id: attempt.client_request_id ?? newRequestId(),
        token: task.currency,
      });
    } catch (error) {
      await this.handleMarketOperationError(taskId, subtaskId, error, "prepare_job");
      return;
    }

    if (result.state === "funded") {
      await this.handleFunded(taskId, subtaskId, {
        jobId: result.job_id,
        assignmentId: result.assignment_id,
        jobUrl: result.job_url,
        amount: result.amount,
        currency: result.currency,
        funded: result.funded,
      });
      return;
    }

    if (result.currency !== task.currency) {
      await this.pauseTask(taskId, "Marketplace quote currency does not match the task. The draft was not approved.");
      return;
    }
    const quoted = parseAmount(result.quoted_price, task.currency);
    const plannedMax = parseAmount(subtask.planned_max, task.currency);
    if (quoted > plannedMax) {
      await this.nextCandidate(
        taskId,
        subtaskId,
        `Market quote ${formatMinor(quoted, task.currency)} exceeds the planned maximum ${formatMinor(plannedMax, task.currency)}. The draft was not approved.`,
      );
      return;
    }
    const who = await this.refreshWhoAmI(taskId);
    const funds = who ? marketFundsFor(who, task.currency) : null;
    if (funds === null || funds < quoted) {
      await this.nextCandidate(
        taskId,
        subtaskId,
        "Market balance is unreadable or cannot cover the quoted price; draft left unapproved.",
      );
      return;
    }

    await this.store.update(taskId, (current) => {
      const currentState = stateById(current, subtaskId);
      const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
      if (!currentAttempt) return;
      currentAttempt.draft_id = result.draft_id;
      currentAttempt.approval_url = result.approval_url;
      currentAttempt.quoted_price = result.quoted_price;
      currentAttempt.negotiated_price = result.quoted_price;
      currentAttempt.currency = task.currency;
      currentState.phase = "awaiting_market_approval";
      currentState.next_check_at = addSeconds(nowIso(), 5);
      currentState.updated_at = nowIso();
    });
    await this.emit(
      taskId,
      subtaskId,
      "info",
      "MARKET_APPROVAL_REQUIRED",
      [
        `Market draft ${result.draft_id} for ${attempt.vendor.name} at ${result.quoted_price} ${task.currency}.`,
        result.approval_url
          ? `Open this market page to approve and fund escrow: ${result.approval_url}`
          : "The market returned no approval URL; do not proceed.",
        this.config.simulation
          ? "SIMULATION: this draft auto-approves shortly; no real funds exist."
          : "Ash cannot approve a charge. Only you can approve on the market page.",
      ].join(" "),
    );
  }

  private async handleFunded(
    taskId: string,
    subtaskId: string,
    funded: {
      jobId: string;
      assignmentId: string | null;
      jobUrl: string | null;
      amount: string | null;
      currency?: string | null;
      funded: boolean;
    },
  ): Promise<void> {
    const task = await this.store.load(taskId);
    const subtask = subtaskById(task, subtaskId);
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt) throw new AshError("STATE_INVALID", "No attempt for funded job.");
    if (!funded.funded) {
      await this.setPhase(
        taskId,
        subtaskId,
        "awaiting_market_approval",
        10,
        "The market has not reported the draft as funded yet.",
      );
      return;
    }
    const amountRaw = funded.amount;
    const currency = funded.currency ?? (this.config.simulation ? task.currency : null);
    let amount: bigint | null = null;
    if (amountRaw !== null && currency === task.currency) {
      try {
        amount = parseAmount(amountRaw, task.currency);
      } catch {
        /* Preserve malformed external evidence below. */
      }
    }
    const evidenceMatches = amount !== null;
    const plannedMax = parseAmount(subtask.planned_max, task.currency);
    const reference = `job:${funded.jobId}`;

    // Persist the external side effect before accounting or checking task status.
    // A paused task must retain the job id even if ledger reconciliation fails.
    await this.store.update(taskId, (current) => {
      const currentState = stateById(current, subtaskId);
      const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
      if (!currentAttempt) return;
      currentAttempt.job_id = funded.jobId;
      currentAttempt.assignment_id = funded.assignmentId;
      if (funded.jobUrl) currentAttempt.approval_url = funded.jobUrl;
      currentAttempt.funding_evidence = {
        amount: amountRaw?.slice(0, 300) ?? null,
        currency: currency?.slice(0, 100) ?? null,
        observed_at: nowIso(),
      };
      currentAttempt.agreed_price = amount !== null ? formatMinor(amount, task.currency) : null;
      currentAttempt.payment_status = evidenceMatches ? "ESCROWED" : "RECONCILIATION_REQUIRED";
      currentAttempt.funded_at ??= nowIso();
      if (evidenceMatches && !isTerminal(currentState.phase)) currentState.phase = "waiting_job";
      currentState.next_check_at = nowIso();
      currentState.updated_at = nowIso();
    });

    if (amount === null) {
      await this.pauseTask(
        taskId,
        `Funded job ${funded.jobId} needs reconciliation: missing/invalid amount or a currency different from ${task.currency}. Job evidence was retained; no estimated amount was booked.`,
      );
      return;
    }

    try {
      await this.ensureCommit(taskId, subtaskId, attempt, amount, reference, funded.jobId);
    } catch (error) {
      if (isAshError(error) && error.code === "BUDGET_EXCEEDED") {
        await this.pauseTask(
          taskId,
          `Market escrow ${funded.jobId} was funded but the task budget cannot account for it: ${error.message}`,
        );
        return;
      }
      throw error;
    }
    if ((await this.store.load(taskId)).status !== "executing") return;

    if (amount > plannedMax) {
      await this.emit(
        taskId,
        subtaskId,
        "error",
        "FUNDED_ABOVE_PLANNED_MAX",
        `The market funded ${formatMinor(amount, task.currency)} ${task.currency}, above the subtask maximum ${formatMinor(plannedMax, task.currency)}. Ash will not accept the result automatically.`,
      );
      await this.finalize(taskId, subtaskId, {
        outcome: "failed",
        reason: "Funded escrow exceeded the planned maximum; human resolution is required on the marketplace.",
        paymentStatus: "ESCROWED",
        metadata: {
          job_id: funded.jobId,
          planned_max: subtask.planned_max,
          funded: formatMinor(amount, task.currency),
        },
      });
      return;
    }

    await this.emit(
      taskId,
      subtaskId,
      "success",
      "JOB_FUNDED",
      `Escrow reported funded for job ${funded.jobId}: ${formatMinor(amount, task.currency)} ${task.currency}. Ash committed the same amount in its ledger and is waiting for delivery.`,
    );
  }

  private async ensureCommit(
    taskId: string,
    subtaskId: string,
    attempt: AttemptRecord,
    amount: bigint,
    reference: string,
    jobId: string,
  ): Promise<void> {
    let created = false;
    await this.store.mutateLedger(taskId, (current) => {
      const existing = current.entries.filter((entry) => entry.kind === "COMMIT" && entry.reference === reference);
      if (existing.length) {
        const total = existing.reduce((sum, entry) => sum + parseAmount(entry.amount, current.currency), 0n);
        if (total !== amount || existing.some((entry) => entry.metadata.subtask_id !== subtaskId)) {
          throw new AshError("BUDGET_INVARIANT", "A replayed funding result conflicts with its recorded escrow.");
        }
        return current;
      }
      created = true;
      return commitEscrow(
        current,
        formatMinor(amount, current.currency),
        reference,
        `Escrow committed for ${attempt.vendor?.name ?? "marketplace vendor"}`,
        attempt.approval_ref,
        {
          job_id: jobId,
          subtask_id: subtaskId,
          vendor_id: attempt.vendor?.id ?? "",
          simulated: this.config.simulation ? "true" : "false",
        },
      );
    });
    if (!created) return;
    await logger.audit("ledger.commit", {
      task_id: taskId,
      job_id: jobId,
      amount: formatMinor(amount, attempt.currency ?? "USDC"),
      currency: attempt.currency ?? "USDC",
      mode: this.config.simulation ? "simulated" : "live",
    });
  }

  private async pollDraft(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const state = stateById(task, subtaskId);
    const subtask = subtaskById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt?.draft_id) {
      await this.setPhase(taskId, subtaskId, "preparing_draft", null, "Draft id was lost; replaying the hire request.");
      return;
    }
    try {
      const status = await this.market.getDraftStatus({
        draftId: attempt.draft_id,
        clientRequestId: attempt.client_request_id ?? undefined,
      });
      if (status.state === "deleted") {
        await this.finalize(taskId, subtaskId, {
          outcome: "walked_away",
          reason: "The marketplace draft's job was deleted and its escrow refunded; Ash did not re-hire.",
          paymentStatus: "NOT_PAID",
          metadata: { draft_id: attempt.draft_id },
        });
        return;
      }
      if (status.state === "funded" && status.job_id) {
        const funded = await this.market.getJobStatus(status.job_id).catch(() => null);
        await this.handleFunded(taskId, subtaskId, {
          jobId: status.job_id,
          assignmentId: funded?.assignment_id ?? null,
          jobUrl: status.job_url,
          amount: status.amount ?? funded?.amount ?? null,
          currency: status.currency ?? funded?.currency ?? null,
          funded: true,
        });
        return;
      }
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (currentAttempt && status.approval_url) currentAttempt.approval_url = status.approval_url;
        currentState.phase = "awaiting_market_approval";
        currentState.next_check_at = addSeconds(nowIso(), this.config.simulation ? 2 : 6);
        currentState.updated_at = nowIso();
      });
      if (status.approval_url && status.approval_url !== attempt.approval_url) {
        await this.emit(
          taskId,
          subtaskId,
          "info",
          "WAITING_MARKET_APPROVAL",
          `Waiting for the human to approve draft ${attempt.draft_id}: ${status.approval_url}`,
        );
      }
    } catch (error) {
      if (isAshError(error) && (error.code === "MARKET_CAPABILITY_MISSING" || error.code === "MARKET_PROTOCOL_ERROR")) {
        await this.replayDraftHire(taskId, subtaskId);
        return;
      }
      await this.handleMarketOperationError(taskId, subtaskId, error, "get_draft_status");
    }
  }

  private async replayDraftHire(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const subtask = subtaskById(task, subtaskId);
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt?.vendor || !attempt.client_request_id) {
      await this.setPhase(
        taskId,
        subtaskId,
        "discovering",
        null,
        "Cannot replay hire without a vendor and request id.",
      );
      return;
    }
    try {
      const result = await this.market.prepareJob({
        worker_agent_id: attempt.vendor.id,
        title: subtask.title,
        description: buildHireBrief(task, subtask, false),
        client_request_id: attempt.client_request_id,
        token: task.currency,
      });
      if (result.state === "funded") {
        await this.handleFunded(taskId, subtaskId, {
          jobId: result.job_id,
          assignmentId: result.assignment_id,
          jobUrl: result.job_url,
          amount: result.amount,
          currency: result.currency,
          funded: result.funded,
        });
        return;
      }
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (currentAttempt && result.approval_url) currentAttempt.approval_url = result.approval_url;
        currentState.phase = "awaiting_market_approval";
        currentState.next_check_at = addSeconds(nowIso(), 6);
        currentState.updated_at = nowIso();
      });
    } catch (error) {
      await this.handleMarketOperationError(taskId, subtaskId, error, "prepare_job replay");
    }
  }

  private async pollJob(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt?.job_id) {
      await this.pauseTask(taskId, "A waiting job lost its marketplace job id; refusing to invent one.");
      return;
    }
    if (attempt.payment_status === "ESCROWED" && attempt.agreed_price) {
      await this.ensureCommit(
        taskId,
        subtaskId,
        attempt,
        parseAmount(attempt.agreed_price, task.currency),
        `job:${attempt.job_id}`,
        attempt.job_id,
      );
      if (
        parseAmount(attempt.agreed_price, task.currency) >
        parseAmount(subtaskById(task, subtaskId).planned_max, task.currency)
      ) {
        await this.pauseTask(taskId, "Funded escrow exceeds the subtask maximum; resolve it on the marketplace.");
        return;
      }
    }
    try {
      const status = await this.market.getJobStatus(attempt.job_id);
      const previousMarketState = attempt.market_state;
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (!currentAttempt) return;
        currentAttempt.market_state = status.worker_state ?? status.status;
        currentAttempt.assignment_id = status.assignment_id ?? currentAttempt.assignment_id;
        currentState.updated_at = nowIso();
      });

      if (status.result_available) {
        await this.handleDelivery(taskId, subtaskId, status.assignment_id);
        return;
      }
      const stateText = `${status.status ?? ""} ${status.worker_state ?? ""}`.toLowerCase();
      if (stateText.includes("cancelled") || status.status === "closed") {
        await this.finalize(taskId, subtaskId, {
          outcome: "cancelled",
          reason: "The marketplace job was cancelled. Ash will not assume a refund until the market confirms it.",
          paymentStatus: "REFUND_PENDING",
          metadata: { job_id: attempt.job_id, market_state: clip(stateText, 200) },
        });
        return;
      }
      if (status.status === "completed" || status.settled) {
        if (attempt.verification?.passed) {
          await this.settle(taskId, subtaskId);
        } else {
          await this.finalize(taskId, subtaskId, {
            outcome: "rejected",
            reason:
              "The market reports the job as accepted/completed before Ash verified the deliverable. Payment was released by the market.",
            paymentStatus: "RELEASED",
            release: true,
            metadata: { job_id: attempt.job_id, market_auto_accepted: "true" },
          });
          await this.emit(
            taskId,
            subtaskId,
            "error",
            "MARKET_ACCEPTED_WITHOUT_ASH_VERIFICATION",
            "The marketplace reports this job completed. Ash did not verify the result before the market's acceptance window closed.",
          );
        }
        return;
      }
      const startedAt = attempt.funded_at ?? attempt.started_at;
      if (Date.now() - Date.parse(startedAt) > MAX_DELIVERY_AGE_MS) {
        await this.finalize(taskId, subtaskId, {
          outcome: "failed",
          reason:
            "The external job produced no deliverable within the 24 hour safety window. Escrow is not assumed refunded.",
          paymentStatus: attempt.payment_status === "ESCROWED" ? "ESCROWED" : "NOT_PAID",
          metadata: { job_id: attempt.job_id },
        });
        return;
      }
      await this.setPhase(
        taskId,
        subtaskId,
        "waiting_job",
        this.config.simulation ? 1 : jobPollSeconds(startedAt),
        attempt.last_error,
      );
      const currentMarketState = status.worker_state ?? status.status ?? "in progress";
      if (previousMarketState !== currentMarketState) {
        await this.emit(
          taskId,
          subtaskId,
          "info",
          "JOB_IN_PROGRESS",
          `Job ${attempt.job_id}: ${currentMarketState}${status.expected_by ? ` (expected by ${status.expected_by})` : ""}.`,
        );
      }
    } catch (error) {
      await this.handleMarketOperationError(taskId, subtaskId, error, "get_job_status");
    }
  }

  private async handleDelivery(taskId: string, subtaskId: string, assignmentId: string | null): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const subtask = subtaskById(task, subtaskId);
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt?.job_id) return;
    let result;
    try {
      result = await this.market.getJobResult(attempt.job_id, assignmentId ?? attempt.assignment_id);
    } catch (error) {
      await this.handleMarketOperationError(taskId, subtaskId, error, "get_job_result");
      return;
    }
    if (result.status === "unavailable") {
      await this.setPhase(taskId, subtaskId, "waiting_job", 30, result.note ?? "Deliverable is not readable yet.");
      return;
    }

    let text = result.content ?? "";
    let truncated = result.truncated === true || (result.note?.toLowerCase().includes("truncated") ?? false);
    let externalUrl: string | null = result.external_url;
    if (result.status === "external" && result.external_url) {
      try {
        const fetched = await safeFetchDeliverable(result.external_url, this.config.policy.maxDeliverableBytes);
        text = fetched.text;
        truncated ||= fetched.truncated;
        externalUrl = fetched.url;
      } catch (error) {
        await this.finalize(taskId, subtaskId, {
          outcome: "failed",
          reason: `External deliverable could not be fetched safely: ${errorMessage(error)}. Open it manually: ${result.external_url}`,
          paymentStatus: attempt.payment_status === "ESCROWED" ? "ESCROWED" : "NOT_PAID",
          metadata: { job_id: attempt.job_id, external_url: result.external_url },
        });
        await this.emit(
          taskId,
          subtaskId,
          "error",
          "EXTERNAL_DELIVERY_UNREACHABLE",
          `The external deliverable link could not be fetched safely. Ash did not accept it. Link: ${result.external_url}`,
        );
        return;
      }
    }
    if (!text.trim() && result.files.length === 0) {
      await this.setPhase(
        taskId,
        subtaskId,
        "waiting_job",
        30,
        "The market reported a result but returned no readable content.",
      );
      return;
    }

    const workspace = await workspaceForAttempt(this.config, taskId, subtaskId, attempt.attempt);
    const downloaded = await this.downloadFiles(taskId, subtaskId, workspace, result.files);
    if (!text.trim()) {
      text = `The marketplace returned ${downloaded.length} file(s) with no readable text. Human inspection of the files is required.`;
      truncated = true;
    }
    const scan = scanForPromptInjection(text);
    const deliverablesDir = path.join(this.config.dataDir, "tasks", taskId, "deliverables", subtaskId);
    await fs.mkdir(deliverablesDir, { recursive: true, mode: 0o700 });
    const target = path.join(deliverablesDir, `attempt-${attempt.attempt}.md`);
    const safeText = sanitizeUntrustedText(text, this.config.policy.maxDeliverableBytes);
    await atomicWriteFile(target, safeText, { mode: 0o600 });
    const relative = path.relative(this.config.dataDir, target).split(path.sep).join("/");
    if (relative.startsWith("..")) throw new AshError("STATE_INVALID", "Deliverable path escaped the data directory.");
    const delivery: DeliveryRecord = {
      text_path: relative,
      files: downloaded,
      external_url: externalUrl,
      received_at: nowIso(),
      source: `market:${attempt.job_id}`,
      sha256: sha256Hex(safeText),
      suspicious: scan.suspicious,
      injection_signals: scan.signals,
      truncated:
        truncated || text.length > this.config.policy.maxDeliverableBytes || result.files.length > downloaded.length,
    };

    await this.store.update(taskId, (current) => {
      const currentState = stateById(current, subtaskId);
      const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
      if (!currentAttempt) return;
      currentAttempt.delivery = delivery;
      currentAttempt.assignment_id = result.assignment_id ?? currentAttempt.assignment_id;
      currentState.phase = "verifying";
      currentState.next_check_at = null;
      currentState.updated_at = nowIso();
    });
    await this.emit(
      taskId,
      subtaskId,
      "info",
      "DELIVERABLE_RECEIVED",
      `Deliverable received for "${subtask.title}" (${safeText.length} chars, ${downloaded.length} files). Verifying against acceptance criteria.`,
    );
    await this.verifyAttempt(taskId, subtaskId);
  }

  private async downloadFiles(
    taskId: string,
    subtaskId: string,
    workspace: string,
    files: DeliverableFile[],
  ): Promise<DeliveryRecord["files"]> {
    if (!this.market.capabilities().can_read_files) return [];
    const output: DeliveryRecord["files"] = [];
    for (const file of files.slice(0, 10)) {
      try {
        const downloaded = await this.market.getFile(file.file_id);
        const safeName = safeDownloadName(file.filename || downloaded.filename || "deliverable.bin");
        const target = await resolveArtifactPath(workspace, safeName);
        await fs.writeFile(target, downloaded.bytes, { mode: 0o600 });
        output.push({
          path: safeName,
          filename: safeName,
          bytes: downloaded.bytes.byteLength,
          sha256: sha256Hex(downloaded.bytes),
        });
      } catch (error) {
        await this.emit(
          taskId,
          subtaskId,
          "warn",
          "FILE_DOWNLOAD_FAILED",
          `Could not download ${file.filename}: ${errorMessage(error)}`,
        );
      }
    }
    return output;
  }

  private async verifyAttempt(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const subtask = subtaskById(task, subtaskId);
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt?.delivery) {
      await this.setPhase(taskId, subtaskId, "waiting_job", 30, "No stored deliverable to verify yet.");
      return;
    }
    if (attempt.verification) {
      await this.handleVerification(taskId, subtaskId, attempt.verification);
      return;
    }
    try {
      const deliveryText = await readDeliveryText(this.config, attempt.delivery);
      const workspace = await workspaceForAttempt(this.config, taskId, subtaskId, attempt.attempt);
      const verification = await this.verifier.verify({
        task,
        subtask,
        delivery: attempt.delivery,
        deliveryText,
        workspace,
      });
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (currentAttempt) {
          currentAttempt.verification = verification;
          currentAttempt.status = verification.passed ? "passed" : "failed";
        }
        currentState.updated_at = nowIso();
      });
      await this.handleVerification(taskId, subtaskId, verification);
    } catch (error) {
      const fallback: VerificationResult = {
        passed: false,
        status: "needs_human",
        checked_at: nowIso(),
        details: `Automated verification failed to run: ${errorMessage(error)}`,
        results: [],
        injection_flags: [],
        reviewed_by: "ASH",
      };
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (currentAttempt) currentAttempt.verification = fallback;
        currentState.phase = "awaiting_human_review";
        currentState.next_check_at = null;
        currentState.updated_at = nowIso();
      });
      await this.emit(taskId, subtaskId, "error", "VERIFIER_ERROR", fallback.details);
    }
  }

  private async handleVerification(taskId: string, subtaskId: string, verification: VerificationResult): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt) return;

    if (verification.passed) {
      if (attempt.kind === "EXTERNAL" && attempt.job_id) {
        if (task.require_hiring_approval) {
          await this.requestAcceptanceApproval(taskId, subtaskId, verification);
        } else {
          await this.callAccept(taskId, subtaskId);
        }
      } else {
        await this.finalize(taskId, subtaskId, {
          outcome: "unpaid",
          reason: "DIY deliverable passed all acceptance criteria. No external payment was due.",
          paymentStatus: "NOT_PAID",
          verification,
          metadata: { deliverable: attempt.delivery?.text_path ?? "" },
        });
      }
      return;
    }

    if (verification.status === "needs_human") {
      await this.setPhase(taskId, subtaskId, "awaiting_human_review", null, verification.details);
      await this.emit(
        taskId,
        subtaskId,
        "warn",
        "HUMAN_REVIEW_REQUIRED",
        `Deliverable for "${subtaskById(task, subtaskId).title}" needs human review: ${verification.details} Deliverable: ${attempt.delivery?.text_path ?? "not stored"}.`,
      );
      return;
    }

    if (
      attempt.kind === "EXTERNAL" &&
      attempt.job_id &&
      attempt.attempt < 2 &&
      this.market.capabilities().can_request_changes &&
      !attempt.revision_requested
    ) {
      const feedback = verificationFeedback(verification);
      try {
        await this.market.requestChanges(attempt.job_id, feedback, attempt.assignment_id ?? undefined);
        await this.store.update(taskId, (current) => {
          const currentState = stateById(current, subtaskId);
          const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
          if (currentAttempt) {
            currentAttempt.revision_requested = true;
            currentAttempt.status = "failed";
            currentAttempt.completed_at = nowIso();
          }
          currentState.phase = "waiting_job";
          currentState.next_check_at = addSeconds(nowIso(), 5);
          currentState.updated_at = nowIso();
        });
        const revision = await this.beginAttempt(taskId, subtaskId, "EXTERNAL", {
          revisionOf: attempt.attempt,
          feedback,
        });
        await this.setPhase(taskId, subtaskId, "waiting_job", 5);
        await this.emit(
          taskId,
          subtaskId,
          "warn",
          "REVISION_REQUESTED",
          `Verification failed. One revision was requested (attempt ${revision.attempt}); the market version is no longer accepted automatically.`,
        );
        return;
      } catch (error) {
        const ash = isAshError(error)
          ? error
          : new AshError("MARKET_UNAVAILABLE", errorMessage(error), { cause: error });
        if (ash.code === "MARKET_REFUSED") {
          await this.store.update(taskId, (current) => {
            const currentState = stateById(current, subtaskId);
            const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
            if (currentAttempt) currentAttempt.revision_requested = true;
          });
          await this.finalize(taskId, subtaskId, {
            outcome: "rejected",
            reason: `Revision could not be requested: ${ash.message}`,
            paymentStatus: attempt.payment_status === "ESCROWED" ? "ESCROWED" : "NOT_PAID",
            verification,
          });
        } else {
          await this.handleMarketOperationError(taskId, subtaskId, error, "request_changes");
        }
        return;
      }
    }

    if (attempt.kind === "DIY" && attempt.attempt < 2) {
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (currentAttempt) {
          currentAttempt.status = "failed";
          currentAttempt.completed_at = nowIso();
        }
        currentState.updated_at = nowIso();
      });
      const revision = await this.beginAttempt(taskId, subtaskId, "DIY", {
        revisionOf: attempt.attempt,
        feedback: verificationFeedback(verification),
      });
      await this.setPhase(taskId, subtaskId, "running_diy", null);
      await this.emit(
        taskId,
        subtaskId,
        "warn",
        "DIY_REVISION",
        `DIY deliverable failed verification; one revision is allowed (attempt ${revision.attempt}).`,
      );
      return;
    }

    await this.finalize(taskId, subtaskId, {
      outcome: attempt.kind === "EXTERNAL" ? "rejected" : "failed",
      reason: `Deliverable failed verification after ${attempt.attempt} attempts: ${verification.details}`,
      paymentStatus: attempt.payment_status === "ESCROWED" ? "ESCROWED" : "NOT_PAID",
      verification,
      metadata: { deliverable: attempt.delivery?.text_path ?? "" },
    });
  }

  private async requestAcceptanceApproval(
    taskId: string,
    subtaskId: string,
    verification: VerificationResult,
  ): Promise<void> {
    const task = await this.store.load(taskId);
    const subtask = subtaskById(task, subtaskId);
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt) return;
    if (attempt.acceptance_approval_ref) {
      const existing = await this.store.approvals(taskId).get(attempt.acceptance_approval_ref);
      if (!existing || existing.status === "expired") {
        await this.store.update(taskId, (current) => {
          const currentState = stateById(current, subtaskId);
          const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
          if (currentAttempt) currentAttempt.acceptance_approval_ref = null;
        });
        await this.requestAcceptanceApproval(taskId, subtaskId, verification);
        return;
      }
      if (existing.status === "approved") {
        const covered =
          existing.kind === "accept_result" &&
          this.approvalCovers(existing, {
            subtask_id: subtaskId,
            job_id: attempt.job_id ?? "",
            amount: attempt.agreed_price ?? attempt.quoted_price ?? subtask.planned_max,
            currency: task.currency,
            verification_hash: hashJson(verification),
          });
        if (!covered) {
          await this.pauseTask(
            taskId,
            `Acceptance approval ${existing.id} no longer matches the deliverable. Refusing to accept.`,
          );
          return;
        }
        await this.callAccept(taskId, subtaskId);
        return;
      }
      if (existing.status === "denied") {
        await this.finalize(taskId, subtaskId, {
          outcome: "rejected",
          reason: `Acceptance approval ${existing.id} was ${existing.status}; escrow was not released by Ash.`,
          paymentStatus: "ESCROWED",
          verification,
          metadata: { approval_id: existing.id },
        });
        return;
      }
      await this.setPhase(taskId, subtaskId, "awaiting_acceptance_approval", this.config.simulation ? 1 : 5);
      return;
    }
    const amount = attempt.agreed_price ?? attempt.quoted_price ?? subtask.planned_max;
    const request = await this.store.approvals(taskId).request({
      kind: "accept_result",
      summary: `Accept the verified deliverable for "${subtask.title}" and release ${amount} ${task.currency} on the marketplace.`,
      amount,
      currency: task.currency,
      scope: {
        subtask_id: subtask.id,
        job_id: attempt.job_id ?? "",
        amount,
        currency: task.currency,
        verification_hash: hashJson(verification),
      },
    });
    await this.store.update(taskId, (current) => {
      const currentState = stateById(current, subtaskId);
      const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
      if (currentAttempt) currentAttempt.acceptance_approval_ref = request.id;
      currentState.phase = "awaiting_acceptance_approval";
      currentState.next_check_at = addSeconds(nowIso(), 5);
      currentState.updated_at = nowIso();
    });
    await this.emit(
      taskId,
      subtaskId,
      "info",
      "ACCEPTANCE_APPROVAL_REQUIRED",
      `Verification passed. Run \`approve ${request.id}\` to accept and release ${amount} ${task.currency}. The market page still performs the actual release.`,
    );
  }

  private async checkAcceptApproval(taskId: string, subtaskId: string): Promise<void> {
    await this.callAccept(taskId, subtaskId);
  }

  private async callAccept(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt?.job_id) return;
    if (!attempt.verification?.passed) {
      await this.pauseTask(taskId, "Acceptance requires a passing verification.");
      return;
    }
    if (task.require_hiring_approval || attempt.acceptance_approval_ref) {
      try {
        await this.store.approvals(taskId).assertApproved(attempt.acceptance_approval_ref, "accept_result", {
          subtask_id: subtaskId,
          job_id: attempt.job_id,
          amount: attempt.agreed_price ?? attempt.quoted_price ?? "",
          currency: task.currency,
          verification_hash: hashJson(attempt.verification),
        });
      } catch (error) {
        if (!isAshError(error) || !["APPROVAL_REQUIRED", "APPROVAL_INVALID"].includes(error.code)) throw error;
        if (error.code === "APPROVAL_INVALID") {
          await this.pauseTask(taskId, error.message);
        } else {
          await this.requestAcceptanceApproval(taskId, subtaskId, attempt.verification);
        }
        return;
      }
    }

    if (!this.market.capabilities().can_accept) {
      await this.setPhase(taskId, subtaskId, "awaiting_market_acceptance", this.config.simulation ? 2 : 30);
      await this.emit(
        taskId,
        subtaskId,
        "warn",
        "ACCEPT_ON_MARKET_PAGE",
        `This deployment has no accept_result tool. Accept on the marketplace job page: ${attempt.approval_url ?? "open your marketplace jobs list"}.`,
      );
      return;
    }
    try {
      const action = await this.market.acceptResult(attempt.job_id, attempt.assignment_id);
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (!currentAttempt) return;
        currentAttempt.approval_url = action.job_url;
        currentState.phase = "awaiting_market_acceptance";
        currentState.next_check_at = addSeconds(nowIso(), 5);
        currentState.updated_at = nowIso();
      });
      await this.emit(
        taskId,
        subtaskId,
        "success",
        "MARKET_ACCEPTANCE_PENDING",
        [
          `Verification passed. The market returned the acceptance page for job ${attempt.job_id}.`,
          action.job_url,
          this.config.simulation
            ? "SIMULATION: the simulated job will complete automatically; no real payment exists."
            : "The human must accept on that page. Ash will release its ledger only after the market reports the job completed.",
        ].join(" "),
      );
      await this.pollAcceptance(taskId, subtaskId);
    } catch (error) {
      if (isAshError(error) && error.code === "MARKET_REFUSED") {
        await this.setPhase(taskId, subtaskId, "waiting_job", 5, error.message);
        return;
      }
      await this.handleMarketOperationError(taskId, subtaskId, error, "accept_result");
    }
  }

  private async pollAcceptance(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt?.job_id) return;
    try {
      const status = await this.market.getJobStatus(attempt.job_id);
      const previousMarketState = attempt.market_state;
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (currentAttempt) currentAttempt.market_state = status.worker_state ?? status.status;
        currentState.updated_at = nowIso();
      });
      if (status.status === "completed" || status.settled) {
        await this.settle(taskId, subtaskId);
        return;
      }
      const stateText = `${status.status ?? ""} ${status.worker_state ?? ""}`.toLowerCase();
      if (status.status === "closed" || stateText.includes("cancelled")) {
        await this.finalize(taskId, subtaskId, {
          outcome: "cancelled",
          reason: "The market closed the job after verification. Refund is not assumed; the market must confirm it.",
          paymentStatus: "REFUND_PENDING",
          metadata: { job_id: attempt.job_id },
        });
        return;
      }
      await this.setPhase(
        taskId,
        subtaskId,
        "awaiting_market_acceptance",
        this.config.simulation ? 1 : Math.max(5, jobPollSeconds(attempt.started_at)),
      );
      await this.emit(
        taskId,
        subtaskId,
        "info",
        "WAITING_MARKET_ACCEPTANCE",
        `Waiting for the marketplace to confirm acceptance of job ${attempt.job_id}.${status.auto_accept_at ? ` Auto-accept deadline: ${status.auto_accept_at}.` : ""}`,
      );
    } catch (error) {
      await this.handleMarketOperationError(taskId, subtaskId, error, "poll acceptance");
    }
  }

  private async settle(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt) return;
    if (!attempt.verification?.passed) {
      await this.finalize(taskId, subtaskId, {
        outcome: "rejected",
        reason:
          "The marketplace reports this job completed, but Ash has no passing verification for the deliverable. The market's acceptance released the escrow.",
        paymentStatus: "RELEASED",
        release: true,
        verification: attempt.verification,
        metadata: { job_id: attempt.job_id ?? "", market_auto_accepted: "true" },
      });
      return;
    }
    await this.finalize(taskId, subtaskId, {
      outcome: "paid",
      reason: "Marketplace confirmed the job completed after Ash verification.",
      paymentStatus: this.config.simulation ? "SIMULATED_RELEASED" : "RELEASED",
      release: true,
      verification: attempt.verification,
      metadata: { job_id: attempt.job_id ?? "", market_state: attempt.market_state ?? "" },
    });
  }

  private async ensureRelease(
    taskId: string,
    subtaskId: string,
    attempt: AttemptRecord,
    amountRaw: string,
    reference: string,
  ): Promise<boolean> {
    let ok = false;
    await this.store.mutateLedger(taskId, (current) => {
      const requested = parseAmount(amountRaw, current.currency);
      const entries = current.entries.filter((entry) => entry.reference === reference);
      const sum = (kind: string) =>
        entries
          .filter((entry) => entry.kind === kind)
          .reduce((total, entry) => total + parseAmount(entry.amount, current.currency), 0n);
      const released = sum("RELEASE");
      if (released > 0n) {
        if (released !== requested)
          throw new AshError("BUDGET_INVARIANT", "A replayed payment conflicts with the recorded release.");
        ok = true;
        return current;
      }
      const remaining = sum("COMMIT") - sum("REFUND");
      if (requested <= 0n || requested > remaining) return current;
      ok = true;
      return releaseEscrow(
        current,
        amountRaw,
        reference,
        `Payment released for ${attempt.vendor?.name ?? "marketplace vendor"}`,
        attempt.acceptance_approval_ref ?? attempt.approval_ref,
        { job_id: attempt.job_id ?? "", simulated: this.config.simulation ? "true" : "false" },
      );
    });
    if (!ok)
      await this.emit(
        taskId,
        subtaskId,
        "error",
        "LEDGER_COMMIT_MISSING",
        `Cannot account for release of ${amountRaw}: matching escrow for ${reference} is missing or insufficient.`,
      );
    return ok;
  }

  private async ensureRefund(taskId: string, attempt: AttemptRecord, reference: string): Promise<void> {
    await this.store.mutateLedger(taskId, (current) => {
      const remaining = current.entries
        .filter((entry) => entry.reference === reference)
        .reduce((total, entry) => {
          const amount = parseAmount(entry.amount, current.currency);
          return entry.kind === "COMMIT"
            ? total + amount
            : ["RELEASE", "REFUND"].includes(entry.kind)
              ? total - amount
              : total;
        }, 0n);
      if (remaining <= 0n) return current;
      return refundEscrow(
        current,
        formatMinor(remaining, current.currency),
        reference,
        `Refund confirmed by marketplace for ${attempt.vendor?.name ?? "marketplace vendor"}`,
        attempt.approval_ref,
        { job_id: attempt.job_id ?? "", simulated: this.config.simulation ? "true" : "false" },
      );
    });
  }

  private async finalize(taskId: string, subtaskId: string, options: FinalizeOptions): Promise<void> {
    let task = await this.store.load(taskId);
    const state = stateById(task, subtaskId);
    if (state.receipt_id) return;
    const subtask = subtaskById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt) throw new AshError("STATE_INVALID", "Cannot finalize a subtask with no attempt.");
    const reference = attempt.job_id ? `job:${attempt.job_id}` : `subtask:${subtaskId}`;
    const agreed = attempt.agreed_price ?? attempt.negotiated_price ?? attempt.quoted_price ?? null;
    const effectiveAgreed = agreed ?? (options.release ? subtask.planned_max : null);

    if (options.release) {
      const releaseAmount = effectiveAgreed ?? subtask.planned_max;
      const ok = await this.ensureRelease(taskId, subtaskId, attempt, releaseAmount, reference);
      if (!ok) {
        await this.pauseTask(
          taskId,
          "The marketplace released a payment but Ash's ledger has no matching escrow commitment.",
        );
        return;
      }
    }
    if (options.refund) {
      await this.ensureRefund(taskId, attempt, reference);
    }

    task = await this.store.load(taskId);
    const verification = options.verification ?? attempt.verification;
    const simulatedPaid = this.config.simulation && options.outcome === "paid";
    if (simulatedPaid) {
      // Simulation still exercises the ledger, but the amount is explicitly
      // marked as simulated in the entry metadata by ensureRelease.
    }
    const receipt = await this.transactions.record({
      idempotency_key: `${task.id}:${subtaskId}`,
      task_id: task.id,
      subtask_id: subtaskId,
      task_description: task.description,
      item: subtask.title,
      subtask_description: subtask.description,
      status: receiptStatusFor(options.outcome, this.config.simulation),
      vendor: attempt.vendor,
      planned_max: subtask.planned_max,
      quoted_price: attempt.quoted_price,
      negotiated_price: attempt.negotiated_price,
      agreed_price: effectiveAgreed,
      currency: task.currency,
      marketplace_job_id: attempt.job_id,
      payment_status: options.paymentStatus,
      check_result: verification
        ? {
            passed: verification.passed,
            status: verification.status,
            details: verification.details,
            criteria: verification.results,
            injection_flags: verification.injection_flags,
          }
        : {
            passed: false,
            status: "not_applicable",
            details: options.reason,
            criteria: [],
            injection_flags: [],
          },
      negotiation_log: attempt.negotiation_log,
      approval_ref: attempt.acceptance_approval_ref ?? attempt.approval_ref,
      mode: this.config.simulation ? "simulated" : "live",
      attempt: attempt.attempt,
      metadata: {
        reason: clip(options.reason, 2_000),
        job_id: attempt.job_id ?? "",
        draft_id: attempt.draft_id ?? "",
        vendor_name: attempt.vendor?.name ?? "",
        deliverable: attempt.delivery?.text_path ?? "",
        market_state: attempt.market_state ?? "",
        hiring_mode: attempt.hiring_mode ?? "",
        hire_approval_ref: attempt.approval_ref ?? "",
        acceptance_approval_ref: attempt.acceptance_approval_ref ?? "",
        ...(options.metadata ?? {}),
      },
    });
    const receiptFile = typeof receipt.metadata.file === "string" ? receipt.metadata.file : null;
    const terminalPhase: SubtaskState["phase"] =
      options.outcome === "paid" || options.outcome === "unpaid"
        ? "completed"
        : options.outcome === "cancelled"
          ? "cancelled"
          : "failed";
    await this.store.update(taskId, (current) => {
      const currentState = stateById(current, subtaskId);
      const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
      if (currentAttempt) {
        currentAttempt.status =
          options.outcome === "paid" || options.outcome === "unpaid"
            ? "passed"
            : options.outcome === "cancelled"
              ? "cancelled"
              : "failed";
        currentAttempt.completed_at = nowIso();
        currentAttempt.payment_status = options.paymentStatus;
        currentAttempt.verification = verification ?? currentAttempt.verification;
      }
      currentState.phase = terminalPhase;
      currentState.receipt_id = receipt.transaction_id;
      currentState.completed_at = nowIso();
      currentState.updated_at = nowIso();
      currentState.next_check_at = null;
      currentState.last_error =
        options.outcome === "paid" || options.outcome === "unpaid" ? null : clip(options.reason, 2_000);
      current.last_receipt_hash = receipt.hash;
      current.last_receipt_file = receiptFile;
      if (current.status === "cancelled") {
        current.cancel_reason ??= options.reason;
      }
    });
    await this.emit(
      taskId,
      subtaskId,
      options.outcome === "paid" || options.outcome === "unpaid"
        ? "success"
        : options.outcome === "rejected" || options.outcome === "failed"
          ? "error"
          : "warn",
      "SUBTASK_RECEIPT",
      `${subtask.title}: ${options.outcome.toUpperCase()} — receipt ${receipt.transaction_id} (${receiptFile ?? "file unknown"}). ${options.reason}`,
    );
    await this.finalizeTaskIfDone(taskId);
  }

  private async finalizeTaskIfDone(taskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (!task.plan) return;
    if (task.status === "cancelled") return;
    if (task.status === "completed" || task.status === "failed") {
      this.scheduleIdleStop();
      return;
    }
    if (task.subtasks.some((state) => !isTerminal(state.phase))) return;
    if (task.subtasks.some((state) => state.phase === "completed" && !state.receipt_id)) return;
    const failed = task.subtasks.filter((state) => state.phase === "failed" || state.phase === "blocked");
    const cancelled = task.subtasks.filter((state) => state.phase === "cancelled");
    const status: TaskRecord["status"] = failed.length > 0 ? "failed" : cancelled.length > 0 ? "failed" : "completed";
    const detail =
      status === "completed"
        ? `All ${task.subtasks.length} subtasks completed.`
        : `${failed.length} failed/blocked and ${cancelled.length} cancelled subtask(s); review the receipts and any escrow.`;
    await this.store.update(taskId, (current) => {
      if (current.status === "cancelled") return;
      current.status = status;
      current.status_detail = detail;
      current.updated_at = nowIso();
    });
    await this.emit(taskId, null, status === "completed" ? "success" : "warn", `TASK_${status.toUpperCase()}`, detail);
    await logger.audit("task.finalized", { task_id: taskId, status, detail });
    this.scheduleIdleStop();
  }

  /**
   * A completed task should not keep the engine lease forever. Wait until the
   * current tick has unwound, then release the engine only if no other task
   * has started executing.
   */
  private scheduleIdleStop(): void {
    if (this.idleStopScheduled) return;
    this.idleStopScheduled = true;
    const timer = setTimeout(() => {
      this.idleStopScheduled = false;
      void (async () => {
        if (!this.running || this.inflight.size > 0) return;
        const taskId = this.boundTaskId;
        if (!taskId) return;
        const active = await this.store.getActive().catch(() => null);
        const task = active === taskId ? await this.store.load(taskId).catch(() => null) : null;
        if (task?.status !== "executing") await this.stop();
      })().catch((error) => logger.warn("Idle engine stop failed", { error: errorMessage(error) }));
    }, 250);
    timer.unref();
  }

  private approvalCovers(approval: { scope: Record<string, string> }, expected: Record<string, string>): boolean {
    return Object.entries(expected).every(([key, value]) => approval.scope[key] === value);
  }

  private async pauseTask(taskId: string, reason: string): Promise<void> {
    await this.store.update(taskId, (task) => {
      if (task.status === "cancelled" || task.status === "completed" || task.status === "failed") return;
      task.status = "paused";
      task.status_detail = clip(reason, 2_000);
      task.updated_at = nowIso();
    });
    await this.emit(taskId, null, "error", "TASK_PAUSED", reason);
    await logger.audit("task.paused", { task_id: taskId, reason: clip(reason, 2_000) });
  }

  private async handleMarketOperationError(
    taskId: string,
    subtaskId: string,
    error: unknown,
    operation: string,
  ): Promise<void> {
    const ash = isAshError(error) ? error : new AshError("MARKET_UNAVAILABLE", errorMessage(error), { cause: error });
    if (ash.code === "MARKET_AUTH_REQUIRED" || ash.code === "UNSAFE_OPERATION" || ash.code === "CONFIG_INVALID") {
      await this.pauseTask(taskId, `${operation}: ${ash.message}`);
      return;
    }
    if (ash.code === "MODEL_UNAVAILABLE") {
      await this.pauseTask(taskId, `${operation}: ${ash.message}`);
      return;
    }
    if (ash.code === "MARKET_CAPABILITY_MISSING") {
      if (operation.includes("prepare") || operation.includes("board")) {
        await this.finalize(taskId, subtaskId, {
          outcome: "walked_away",
          reason: `${operation} is unavailable on this marketplace: ${ash.message}`,
          paymentStatus: "NOT_PAID",
        });
      } else {
        await this.pauseTask(taskId, `${operation}: ${ash.message}`);
      }
      return;
    }
    if (ash.code === "MARKET_REFUSED") {
      const details = JSON.stringify(ash.details);
      if (details.includes("job_deleted")) {
        await this.finalize(taskId, subtaskId, {
          outcome: "walked_away",
          reason: "The marketplace job/draft was deleted and its escrow refunded.",
          paymentStatus: "NOT_PAID",
        });
        return;
      }
      if (/email/i.test(ash.message)) {
        await this.pauseTask(taskId, `Marketplace refused ${operation}: ${ash.message}`);
        return;
      }
      if (/no such|not found|not visible|not_found/i.test(ash.message)) {
        await this.pauseTask(taskId, `Marketplace refused ${operation}: ${ash.message}`);
        return;
      }
      if (operation.includes("prepare") || operation.includes("board")) {
        await this.nextCandidate(taskId, subtaskId, `Marketplace refused ${operation}: ${ash.message}`);
      } else {
        await this.setPhase(taskId, subtaskId, "waiting_job", 30, ash.message);
        await this.emit(taskId, subtaskId, "warn", "MARKET_OPERATION_REFUSED", `${operation}: ${ash.message}`);
      }
      return;
    }
    if (ash.code === "MARKET_UNAVAILABLE" || ash.code === "RATE_LIMITED") {
      await this.store.update(taskId, (task) => {
        const state = stateById(task, subtaskId);
        state.last_error = clip(ash.message, 2_000);
        state.next_check_at = addSeconds(nowIso(), 30);
        state.updated_at = nowIso();
      });
      await this.emit(taskId, subtaskId, "warn", "MARKET_RETRY", `${operation}: ${ash.message} Retrying in 30s.`);
      return;
    }
    throw ash;
  }

  private async handleAdvanceError(taskId: string, subtaskId: string, error: unknown): Promise<void> {
    const ash = isAshError(error) ? error : new AshError("STATE_INVALID", errorMessage(error), { cause: error });
    logger.error("Engine subtask error", {
      task_id: taskId,
      subtask_id: subtaskId,
      code: ash.code,
      error: clip(ash.message, 800),
    });
    if (
      ash.code === "MARKET_AUTH_REQUIRED" ||
      ash.code === "CONFIG_INVALID" ||
      ash.code === "UNSAFE_OPERATION" ||
      ash.code === "MODEL_UNAVAILABLE" ||
      ash.code === "BUDGET_INVARIANT" ||
      ash.code === "BUDGET_EXCEEDED" ||
      ash.code === "INTEGRITY_FAILED"
    ) {
      await this.pauseTask(taskId, `Subtask ${subtaskId} stopped: ${ash.message}`);
      return;
    }
    try {
      await this.store.update(taskId, (task) => {
        const state = stateById(task, subtaskId);
        state.last_error = clip(ash.message, 2_000);
        state.next_check_at = addSeconds(nowIso(), 30);
        state.updated_at = nowIso();
      });
      await this.emit(taskId, subtaskId, "error", "SUBTASK_ERROR", `${ash.code}: ${ash.message} Retrying in 30s.`);
    } catch (inner) {
      logger.error("Could not persist subtask error", { error: errorMessage(inner) });
    }
  }

  async reviewSubtask(
    taskId: string,
    subtaskId: string,
    decision: "pass" | "fail",
    note: string,
  ): Promise<VerificationResult> {
    const key = `${taskId}:${subtaskId}`;
    if (this.inflight.has(key) || this.manualReviews.has(key)) {
      throw new AshError("CONFLICT", "This subtask is still being processed. Wait before reviewing it.");
    }
    this.manualReviews.add(key);
    try {
      return await this.reviewSubtaskInternal(taskId, subtaskId, decision, note);
    } finally {
      this.manualReviews.delete(key);
    }
  }

  private async reviewSubtaskInternal(
    taskId: string,
    subtaskId: string,
    decision: "pass" | "fail",
    note: string,
  ): Promise<VerificationResult> {
    const task = await this.store.load(taskId);
    if (task.status === "cancelled") throw new AshError("CONFLICT", "This task is cancelled.");
    const subtask = subtaskById(task, subtaskId);
    const state = stateById(task, subtaskId);
    if (state.phase !== "awaiting_human_review" && state.phase !== "verifying") {
      throw new AshError("CONFLICT", `Subtask ${subtaskId} is ${state.phase}, not awaiting human review.`);
    }
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt?.delivery) throw new AshError("CONFLICT", "Subtask has no stored deliverable to review.");
    const deliveryText = await readDeliveryText(this.config, attempt.delivery);
    const workspace = await workspaceForAttempt(this.config, taskId, subtaskId, attempt.attempt);
    const manual: ManualReview = { decision, note, at: nowIso(), reviewer: "human" };
    const verification = await this.verifier.verify({
      task,
      subtask,
      delivery: attempt.delivery,
      deliveryText,
      workspace,
      manualReview: manual,
    });
    await this.store.update(taskId, (current) => {
      const currentState = stateById(current, subtaskId);
      const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
      if (
        current.status === "cancelled" ||
        isTerminal(currentState.phase) ||
        currentState.receipt_id ||
        currentAttempt?.attempt !== attempt.attempt ||
        currentAttempt.delivery?.sha256 !== attempt.delivery!.sha256
      ) {
        throw new AshError("CONFLICT", "The subtask changed while its deliverable was being reviewed.");
      }
      if (currentAttempt) {
        currentAttempt.verification = verification;
        currentAttempt.status = verification.passed ? "passed" : "failed";
      }
      currentState.phase = "verifying";
      currentState.next_check_at = null;
      currentState.updated_at = nowIso();
    });
    await logger.audit("verification.manual", {
      task_id: taskId,
      subtask_id: subtaskId,
      decision,
      note: clip(note, 500),
    });
    await this.handleVerification(taskId, subtaskId, verification);
    return verification;
  }

  async cancelTask(taskId: string, reason: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status === "cancelled") return;
    if (task.status === "completed") throw new AshError("CONFLICT", "This task is already completed.");
    await this.store.update(taskId, (current) => {
      if (current.status === "completed") throw new AshError("CONFLICT", "This task is already completed.");
      if (current.status === "cancelled") return;
      current.status = "cancelled";
      current.cancel_reason = clip(reason, 2_000);
      current.status_detail = clip(reason, 2_000);
      current.updated_at = nowIso();
    });
    // Funding calls already sent must persist before a cancellation receipt is sealed.
    await Promise.allSettled(
      [...this.inflight.entries()].filter(([key]) => key.startsWith(`${taskId}:`)).map(([, pending]) => pending),
    );
    const settledTask = await this.store.load(taskId);
    for (const state of settledTask.subtasks) {
      if (isTerminal(state.phase)) continue;
      if (state.attempts.length === 0) {
        await this.store.update(taskId, (current) => {
          const currentState = stateById(current, state.id);
          currentState.phase = "cancelled";
          currentState.completed_at = nowIso();
          currentState.next_check_at = null;
          currentState.updated_at = nowIso();
        });
        continue;
      }
      const attempt = activeAttempt(state.attempts, state.active_attempt);
      const hasEscrow = attempt?.payment_status === "ESCROWED" || Boolean(attempt?.job_id && attempt.agreed_price);
      await this.finalize(taskId, state.id, {
        outcome: "cancelled",
        reason: `${clip(reason, 1_500)} No marketplace cancel_job call was made; resolve any escrow on the market page.`,
        paymentStatus: hasEscrow ? "REFUND_PENDING" : "NOT_PAID",
        metadata: { cancellation: "human", market_cancelled: "false" },
      });
    }
    await this.emit(taskId, null, "warn", "TASK_CANCELLED", clip(reason, 2_000));
    await logger.audit("task.cancelled", { task_id: taskId, reason: clip(reason, 2_000) });
  }

  private async runDiy(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const subtask = subtaskById(task, subtaskId);
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt) throw new AshError("STATE_INVALID", "DIY subtask has no attempt.");
    if (attempt.delivery) {
      await this.verifyAttempt(taskId, subtaskId);
      return;
    }
    if (!this.model.available) {
      await this.pauseTask(taskId, "The AI model is unavailable, so Ash cannot produce the DIY deliverable.");
      return;
    }
    try {
      const workspaceRoot = path.join(this.config.dataDir, "workspaces", taskId, subtaskId);
      const result = await this.diy.execute(task, subtask, attempt.attempt, workspaceRoot, attempt.revision_feedback);
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (!currentAttempt) return;
        currentAttempt.delivery = result.delivery;
        currentState.phase = "verifying";
        currentState.next_check_at = null;
        currentState.updated_at = nowIso();
      });
      await this.emit(
        taskId,
        subtaskId,
        "info",
        "DIY_DELIVERABLE",
        `Local artifact produced for "${subtask.title}" (${result.delivery.files.length} file(s)). Stored at ${result.delivery.text_path ?? "unknown"}.`,
      );
      await this.verifyAttempt(taskId, subtaskId);
    } catch (error) {
      const ash = isAshError(error)
        ? error
        : new AshError("MODEL_RESPONSE_INVALID", errorMessage(error), { cause: error });
      if (ash.code === "MODEL_UNAVAILABLE" || ash.code === "UNSAFE_INPUT" || ash.code === "MODEL_RESPONSE_INVALID") {
        await this.pauseTask(taskId, `DIY attempt stopped: ${ash.message}`);
        return;
      }
      throw ash;
    }
  }

  private async startBoard(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    const subtask = subtaskById(task, subtaskId);
    const attempt = await this.beginAttempt(taskId, subtaskId, "EXTERNAL", { hiringMode: "board" });
    const request = await this.store.approvals(taskId).request({
      kind: "hire",
      summary: `Publish a PUBLIC marketplace job for "${subtask.title}" with a ${subtask.planned_max} ${task.currency} guide price. The brief becomes visible to marketplace users.`,
      amount: subtask.planned_max,
      currency: task.currency,
      scope: {
        mode: "board_post",
        subtask_id: subtask.id,
        amount: subtask.planned_max,
        currency: task.currency,
        title: subtask.title,
        public: "true",
        brief_preview: buildHireBrief(task, subtask, true).slice(0, 500),
      },
    });
    await this.store.update(taskId, (current) => {
      const currentState = stateById(current, subtaskId);
      const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
      if (currentAttempt) currentAttempt.approval_ref = request.id;
      currentState.phase = "awaiting_hire_approval";
      currentState.next_check_at = addSeconds(nowIso(), 5);
      currentState.updated_at = nowIso();
    });
    await this.emit(
      taskId,
      subtaskId,
      "warn",
      "PUBLIC_POST_APPROVAL_REQUIRED",
      `Board mode: approval ${request.id} is required before publishing a PUBLIC job. Run \`approve ${request.id}\` after reviewing the brief. Attempt ${attempt.attempt}.`,
    );
  }

  private async postBoardApproved(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing" || !(await this.ensureHireApproval(task, subtaskId))) return;
    const subtask = subtaskById(task, subtaskId);
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt) return;
    const brief = buildHireBrief(task, subtask, true);
    if (attempt.board_post_attempted_at) {
      await this.pauseTask(
        taskId,
        "A previous board post has no recorded result. Inspect your marketplace jobs before creating another task; Ash will not publish a duplicate automatically.",
      );
      return;
    }
    // post_job has no idempotency key. Persist intent before crossing the API
    // boundary so a timeout or process crash cannot publish the same job twice.
    await this.store.update(taskId, (current) => {
      const currentAttempt = activeAttempt(
        stateById(current, subtaskId).attempts,
        stateById(current, subtaskId).active_attempt,
      );
      if (current.status !== "executing" || !currentAttempt || currentAttempt.board_post_attempted_at)
        throw new AshError("CONFLICT", "Board posting state changed.");
      currentAttempt.board_post_attempted_at = nowIso();
    });
    try {
      const posted = await this.market.postJob({
        title: subtask.title,
        description: brief,
        budget_amount: subtask.planned_max,
        token: task.currency,
        tags: subtask.skills.slice(0, 5),
        max_slots: 1,
        min_builder_verification: "none",
      });
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (!currentAttempt) return;
        currentAttempt.job_id = posted.job_id;
        currentAttempt.market_posted_at = nowIso();
        currentAttempt.approval_url = posted.job_url;
        if (!isTerminal(currentState.phase)) currentState.phase = "waiting_bids";
        currentState.next_check_at = addSeconds(nowIso(), this.config.simulation ? 2 : 10);
        currentState.updated_at = nowIso();
      });
      await this.emit(
        taskId,
        subtaskId,
        "info",
        "BOARD_JOB_POSTED",
        `Public job ${posted.job_id} posted at a ${subtask.planned_max} ${task.currency} guide. Waiting up to 5 minutes for bids. ${posted.job_url ?? ""}`.trim(),
      );
    } catch (error) {
      await this.pauseTask(
        taskId,
        `Board posting did not finish recording: ${errorMessage(error)}. Check marketplace jobs before retrying; automatic re-posting is disabled.`,
      );
    }
  }

  private async pollBids(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const subtask = subtaskById(task, subtaskId);
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt?.job_id) {
      await this.setPhase(taskId, subtaskId, "awaiting_hire_approval", 5, "Board job id is missing.");
      return;
    }
    try {
      const bids = await this.market.listBids(attempt.job_id);
      const plannedMax = parseAmount(subtask.planned_max, task.currency);
      const openBids = bids.filter(
        (bid) =>
          bid.currency === task.currency && !["rejected", "withdrawn", "awarded"].includes(bid.status.toLowerCase()),
      );
      if (openBids.length === 0) {
        if (Date.now() - Date.parse(attempt.market_posted_at ?? attempt.started_at) > MAX_BID_WAIT_MS) {
          await this.finalize(taskId, subtaskId, {
            outcome: "walked_away",
            reason:
              "No bids arrived within five minutes. The open marketplace posting is not cancelled automatically; close it on the market page.",
            paymentStatus: "NOT_PAID",
            metadata: { job_id: attempt.job_id, open_posting: "true" },
          });
          return;
        }
        await this.setPhase(
          taskId,
          subtaskId,
          "waiting_bids",
          bidPollSeconds(attempt.market_posted_at ?? attempt.started_at, this.config.simulation ? 2000 : 0),
        );
        await this.emit(taskId, subtaskId, "info", "WAITING_BIDS", `No bids yet on board job ${attempt.job_id}.`);
        return;
      }

      const affordable = openBids
        .filter((bid) => parseAmount(bid.amount, task.currency) <= plannedMax)
        .sort((a, b) => {
          const reputation = (b.bidder.reputation_overall ?? 0) - (a.bidder.reputation_overall ?? 0);
          if (reputation !== 0) return reputation;
          const priceA = parseAmount(a.amount, task.currency);
          const priceB = parseAmount(b.amount, task.currency);
          return priceA < priceB ? -1 : priceA > priceB ? 1 : 0;
        });
      let chosen: JobBid | null = affordable[0] ?? null;
      let negotiationLog = attempt.negotiation_log;
      if (!chosen) {
        const best = [...openBids].sort(
          (a, b) => (b.bidder.reputation_overall ?? 0) - (a.bidder.reputation_overall ?? 0),
        )[0];
        if (!best) {
          await this.setPhase(taskId, subtaskId, "waiting_bids", 30);
          return;
        }
        const negotiator = new NegotiationEngine({
          adapter: this.market,
          subtaskId,
          currency: task.currency,
          plannedMax,
          timeoutMs: this.config.simulation ? 10_000 : 30_000,
          pollMs: this.config.simulation ? 1_000 : 5_000,
        });
        const negotiation = await negotiator.negotiateBid(attempt.job_id, best, attempt.negotiation_log);
        negotiationLog = [...attempt.negotiation_log, ...negotiation.log];
        if (!negotiation.accepted) {
          await this.finalize(taskId, subtaskId, {
            outcome: "walked_away",
            reason: `All bids exceed the ${subtask.planned_max} ${task.currency} maximum and negotiation did not succeed: ${negotiation.note}`,
            paymentStatus: "NOT_PAID",
            metadata: { job_id: attempt.job_id, bids: String(openBids.length) },
          });
          return;
        }
        chosen = negotiation.bid;
      }

      const amount = formatMinor(parseAmount(chosen.amount, task.currency), task.currency);
      const vendorName = chosen.bidder.name ?? chosen.bidder.handle ?? "simulated bidder";
      const vendorId = chosen.bidder.id ?? chosen.bidder.handle ?? chosen.bid_id;
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (!currentAttempt) return;
        currentAttempt.bid_id = chosen.bid_id;
        currentAttempt.vendor = { id: vendorId, name: vendorName, handle: chosen.bidder.handle };
        currentAttempt.negotiated_price = amount;
        currentAttempt.agreed_price = amount;
        currentAttempt.negotiation_log = negotiationLog;
        currentState.updated_at = nowIso();
      });

      const needsAwardApproval = task.require_hiring_approval;
      if (!needsAwardApproval) {
        // The board-post approval was for publishing, not for awarding this
        // specific bid. Clear it so the award proceeds under plan authority
        // instead of matching the stale post scope.
        await this.store.update(taskId, (current) => {
          const currentState = stateById(current, subtaskId);
          const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
          if (currentAttempt) currentAttempt.approval_ref = null;
          currentState.phase = "awaiting_hire_approval";
          currentState.next_check_at = null;
          currentState.updated_at = nowIso();
        });
        return;
      }
      if (needsAwardApproval) {
        const request = await this.store.approvals(taskId).request({
          kind: "award",
          summary: `Award board bid ${chosen.bid_id} from ${vendorName} for "${subtask.title}" at ${amount} ${task.currency}.`,
          amount,
          currency: task.currency,
          scope: {
            subtask_id: subtask.id,
            job_id: attempt.job_id,
            bid_id: chosen.bid_id,
            vendor_name: vendorName,
            amount,
          },
        });
        await this.store.update(taskId, (current) => {
          const currentState = stateById(current, subtaskId);
          const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
          if (currentAttempt) currentAttempt.approval_ref = request.id;
          currentState.phase = "awaiting_hire_approval";
          currentState.next_check_at = addSeconds(nowIso(), 5);
          currentState.updated_at = nowIso();
        });
        await this.emit(
          taskId,
          subtaskId,
          "info",
          "AWARD_APPROVAL_REQUIRED",
          `Approval ${request.id} required to award bid ${chosen.bid_id} at ${amount} ${task.currency}. Run \`approve ${request.id}\`.`,
        );
        return;
      }

      await this.setPhase(taskId, subtaskId, "awaiting_hire_approval", null);
    } catch (error) {
      await this.handleMarketOperationError(taskId, subtaskId, error, "list_bids");
    }
  }

  private async awardApproved(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing" || !(await this.ensureHireApproval(task, subtaskId))) return;
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt?.job_id || !attempt.bid_id) return;
    try {
      const action = await this.market.awardBid(attempt.job_id, attempt.bid_id);
      await this.store.update(taskId, (current) => {
        const currentState = stateById(current, subtaskId);
        const currentAttempt = activeAttempt(currentState.attempts, currentState.active_attempt);
        if (!currentAttempt) return;
        currentAttempt.approval_url = action.job_url;
        currentState.phase = "awaiting_market_award";
        currentState.next_check_at = addSeconds(nowIso(), 5);
        currentState.updated_at = nowIso();
      });
      await this.emit(
        taskId,
        subtaskId,
        "info",
        "AWARD_PAGE_READY",
        `The market returned the award page for bid ${attempt.bid_id}. ${action.job_url} The human must award on the page; Ash waits for the assignment to appear.`,
      );
    } catch (error) {
      await this.handleMarketOperationError(taskId, subtaskId, error, "award_bid");
    }
  }

  private async pollAward(taskId: string, subtaskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (task.status !== "executing") return;
    const state = stateById(task, subtaskId);
    const attempt = activeAttempt(state.attempts, state.active_attempt);
    if (!attempt?.job_id) return;
    try {
      const status = await this.market.getJobStatus(attempt.job_id);
      if (status.assignment_id || ["in_progress", "completed", "closed"].includes(status.status ?? "")) {
        if (status.status === "closed") {
          await this.finalize(taskId, subtaskId, {
            outcome: "walked_away",
            reason: "The board job closed before it was awarded; no escrow was committed by Ash.",
            paymentStatus: "NOT_PAID",
            metadata: { job_id: attempt.job_id },
          });
          return;
        }
        await this.handleFunded(taskId, subtaskId, {
          jobId: attempt.job_id,
          assignmentId: status.assignment_id,
          jobUrl: attempt.approval_url,
          amount: status.amount ?? null,
          currency: status.currency ?? null,
          funded: true,
        });
        return;
      }
      await this.setPhase(taskId, subtaskId, "awaiting_market_award", 10);
      await this.emit(
        taskId,
        subtaskId,
        "info",
        "WAITING_AWARD",
        `Waiting for the human to award bid ${attempt.bid_id ?? ""} on the market page.`,
      );
    } catch (error) {
      await this.handleMarketOperationError(taskId, subtaskId, error, "poll award");
    }
  }

  private async failEngine(taskId: string, error: unknown): Promise<void> {
    const message = errorMessage(error);
    logger.error("Engine tick failed", { task_id: taskId, error: clip(message, 800) });
    try {
      await this.pauseTask(taskId, `Execution engine stopped: ${message}`);
    } catch {
      // The task may be gone or corrupt; the event log still records the error.
    }
  }
}
