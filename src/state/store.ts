import { promises as fs } from "node:fs";
import path from "node:path";
import { AshError } from "../errors.js";
import type { AppConfig } from "../config.js";
import type { EngineEvent, LedgerRecord, TaskInput, TaskRecord } from "../domain/types.js";
import { assertTaskConsistency, initialSubtaskStates, validatePlan, validateTaskPlan } from "../domain/plan.js";
import { EngineEventSchema, TaskInputSchema, TaskRecordSchema } from "../domain/schemas.js";
import {
  PROJECT_ID,
  SCOPES,
  getScope,
  isProjectId,
  validateProjectInputs,
  validateScopeInputs,
  type ProjectScope,
} from "../tracks.js";
import { containsSecretLike } from "../util/redact.js";
import { adjustBudget, createLedger, parseLedger } from "../ledger/ledger.js";
import { parseAmount } from "../util/money.js";
import {
  atomicWriteJson,
  atomicWriteFile,
  acquireFileLock,
  ensurePrivateDir,
  listFiles,
  readJsonIfExists,
  readTailLines,
  withFileLock,
} from "../util/fs.js";
import { taskId as makeTaskId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { logger } from "../logger.js";
import { ApprovalManager } from "../security/approvals.js";

export interface StorePaths {
  dataDir: string;
  tasksDir: string;
  transactionsDir: string;
  logsDir: string;
  workspacesDir: string;
  cacheDir: string;
  activeTaskFile: string;
}

export function storePaths(dataDir: string): StorePaths {
  return {
    dataDir,
    tasksDir: path.join(dataDir, "tasks"),
    transactionsDir: path.join(dataDir, "transactions"),
    logsDir: path.join(dataDir, "logs"),
    workspacesDir: path.join(dataDir, "workspaces"),
    cacheDir: path.join(dataDir, "cache"),
    activeTaskFile: path.join(dataDir, "active-task"),
  };
}

export async function bootstrapDataDir(dataDir: string): Promise<StorePaths> {
  const paths = storePaths(dataDir);
  for (const dir of [paths.dataDir, paths.tasksDir, paths.logsDir, paths.workspacesDir, paths.cacheDir]) {
    await ensurePrivateDir(dir);
  }
  return paths;
}

/**
 * File-backed task store. All writes are atomic and versioned. Task updates
 * happen under a per-task lock and re-read the latest state, so a CLI command
 * and the background execution engine cannot silently overwrite each other.
 */
export class TaskStore {
  readonly paths: StorePaths;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.paths = storePaths(config.dataDir);
  }

  async init(): Promise<void> {
    await bootstrapDataDir(this.config.dataDir);
    const marker = path.join(this.config.dataDir, ".ash-mode.json");
    await withFileLock(`${marker}.lock`, async () => {
      const mode = await readJsonIfExists<{ simulated: boolean }>(marker);
      if (mode && mode.simulated !== this.config.simulation)
        throw new AshError(
          "CONFIG_INVALID",
          "This data directory belongs to a different live/simulation mode. Use a separate directory; npm run demo creates one automatically.",
        );
      if (!mode) {
        if (this.config.simulation && (await listFiles(this.paths.tasksDir)).length)
          throw new AshError(
            "CONFIG_INVALID",
            "Demo mode cannot open an existing unmarked task directory. Run npm run demo for a fresh isolated workspace.",
          );
        await atomicWriteJson(marker, { simulated: this.config.simulation }, { exclusive: true });
      }
    });
  }

  taskDir(taskId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(taskId)) {
      throw new AshError("VALIDATION_FAILED", "Invalid task id.");
    }
    return path.join(this.paths.tasksDir, taskId);
  }

  taskFile(taskId: string): string {
    return path.join(this.taskDir(taskId), "task.json");
  }

  ledgerFile(taskId: string): string {
    return path.join(this.taskDir(taskId), "ledger.json");
  }

  approvalsFile(taskId: string): string {
    return path.join(this.taskDir(taskId), "approvals.json");
  }

  eventsFile(taskId: string): string {
    return path.join(this.taskDir(taskId), "events.jsonl");
  }

  workspaceDir(taskId: string, subtaskId?: string): string {
    this.taskDir(taskId);
    const root = path.join(this.paths.workspacesDir, taskId);
    if (!subtaskId) return root;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(subtaskId)) {
      throw new AshError("VALIDATION_FAILED", "Invalid subtask id for a workspace path.");
    }
    return path.join(root, subtaskId);
  }

  deliverablesDir(taskId: string, subtaskId: string): string {
    this.workspaceDir(taskId, subtaskId);
    return path.join(this.taskDir(taskId), "deliverables", subtaskId);
  }

  reportsDir(taskId: string): string {
    return path.join(this.taskDir(taskId), "reports");
  }

  async create(rawInput: TaskInput): Promise<TaskRecord> {
    const input = TaskInputSchema.parse(rawInput) as TaskInput;
    const requestedTrack = input.track_id?.trim().toLowerCase() ?? null;
    let selectedScopes: ProjectScope[] = [];
    let trackInputs: Record<string, string> = {};
    if (requestedTrack) {
      const rawInputs = { ...(input.track_inputs ?? {}) };
      if (isProjectId(requestedTrack)) {
        const requestedScopes =
          input.project_scopes && input.project_scopes.length > 0
            ? input.project_scopes.map((id) => id.trim().toLowerCase())
            : SCOPES.map((scope) => scope.id);
        const unique = [...new Set(requestedScopes)];
        if (unique.length !== requestedScopes.length) {
          throw new AshError("VALIDATION_FAILED", "Project workstreams must not contain duplicates.");
        }
        for (const id of unique) {
          if (!getScope(id)) {
            throw new AshError(
              "VALIDATION_FAILED",
              `Unknown project workstream "${id}". Run \`tracks\` for the six workstreams in the Ash project.`,
            );
          }
        }
        selectedScopes = unique.map((id) => getScope(id)!);
        const missing = validateProjectInputs(selectedScopes, rawInputs);
        if (missing.length > 0) {
          throw new AshError("VALIDATION_FAILED", `Ash project inputs are invalid or missing: ${missing.join(", ")}.`);
        }
      } else {
        const scope = getScope(requestedTrack);
        if (!scope) {
          throw new AshError(
            "VALIDATION_FAILED",
            `Unknown project workstream "${requestedTrack}". Run \`tracks\` for the six workstreams in the Ash project.`,
          );
        }
        selectedScopes = [scope];
        const missing = validateScopeInputs(scope, rawInputs);
        if (missing.length > 0) {
          throw new AshError(
            "VALIDATION_FAILED",
            `Workstream ${scope.id} has invalid or missing inputs: ${missing.join(", ")}.`,
          );
        }
      }
      for (const [key, value] of Object.entries(rawInputs)) {
        if (
          /private|seed|secret|token|api[_-]?key|password/i.test(key) ||
          containsSecretLike(value) ||
          /private[_ -]?key|seed phrase|api[_-]?key|password/i.test(value)
        ) {
          throw new AshError(
            "UNSAFE_INPUT",
            `Project input "${key}" looks like a secret. Never put keys in task configuration.`,
          );
        }
      }
      trackInputs = rawInputs;
    }
    await this.init();
    const id = makeTaskId();
    const at = nowIso();
    if (input.deadline && Date.parse(input.deadline) <= Date.now()) {
      throw new AshError("VALIDATION_FAILED", "The deadline must be in the future.");
    }
    const task: TaskRecord = {
      schema_version: 1,
      id,
      revision: 0,
      created_at: at,
      updated_at: at,
      description: input.description.trim(),
      quality_requirements: input.quality_requirements,
      additional_instructions: input.additional_instructions,
      track_id: requestedTrack ? (isProjectId(requestedTrack) ? PROJECT_ID : (selectedScopes[0]?.id ?? null)) : null,
      project_scopes: selectedScopes.map((scope) => scope.id),
      track_inputs: requestedTrack ? trackInputs : {},
      deadline: input.deadline,
      preferred_agents: [...new Set(input.preferred_agents)],
      execution_strategy: input.execution_strategy,
      allow_external: input.allow_external,
      diy_first: input.diy_first,
      require_hiring_approval: input.require_hiring_approval,
      max_parallel_jobs: this.resolveParallelJobs(input.max_parallel_jobs),
      authorized_budget: input.budget,
      currency: input.currency,
      status: "draft",
      status_detail: null,
      plan: null,
      plan_approved_at: null,
      plan_approval_ref: null,
      subtasks: [],
      market_snapshot: null,
      last_receipt_hash: null,
      last_receipt_file: null,
      cancel_reason: null,
    };
    assertTaskConsistency(task);
    const taskDir = this.taskDir(id);
    await ensurePrivateDir(taskDir);
    await atomicWriteJson(this.taskFile(id), task, { exclusive: true });
    await atomicWriteJson(this.ledgerFile(id), createLedger(id, input.currency, input.budget), {
      exclusive: true,
    });
    await atomicWriteJson(
      this.approvalsFile(id),
      { schema_version: 1, task_id: id, requests: [] },
      { exclusive: true },
    );
    await this.setActive(id);
    await logger.audit("task.created", {
      task_id: id,
      currency: input.currency,
      budget: input.budget,
      strategy: input.execution_strategy,
      simulation: this.config.simulation,
    });
    return task;
  }

  async load(taskId: string): Promise<TaskRecord> {
    const raw = await readJsonIfExists<unknown>(this.taskFile(taskId));
    if (raw === null) throw new AshError("NOT_FOUND", `Task ${taskId} was not found.`);
    try {
      const task = assertTaskConsistency(raw);
      if (task.id !== taskId) throw new AshError("STATE_INVALID", "Task file belongs to another task.");
      // The append-only ledger owns the budget. Recover a stale task snapshot
      // after an interruption between the ledger and task writes.
      const ledgerRaw = await readJsonIfExists<unknown>(this.ledgerFile(taskId));
      if (ledgerRaw !== null) {
        const ledger = parseLedger(ledgerRaw);
        if (ledger.task_id !== taskId || ledger.currency !== task.currency) {
          throw new AshError("STATE_INVALID", "Ledger does not belong to this task or currency.");
        }
        task.authorized_budget = ledger.authorized_budget;
      }
      return task;
    } catch (error) {
      if (error instanceof AshError) throw error;
      throw new AshError("STATE_INVALID", `Task ${taskId} is corrupt or has an unsupported schema.`, { cause: error });
    }
  }

  async update(
    taskId: string,
    mutator: (task: TaskRecord) => void,
    options: { requirePlan?: boolean } = {},
  ): Promise<TaskRecord> {
    const lock = path.join(this.taskDir(taskId), "task.lock");
    return withFileLock(lock, async () => {
      const task = await this.load(taskId);
      mutator(task);
      task.revision += 1;
      task.updated_at = nowIso();
      const parsed = assertTaskConsistency(task);
      if (options.requirePlan && !parsed.plan) {
        throw new AshError("STATE_INVALID", "This operation needs an execution plan.");
      }
      await atomicWriteJson(this.taskFile(taskId), parsed);
      return parsed;
    });
  }

  async list(limit = 100): Promise<TaskRecord[]> {
    const entries = await listFiles(this.paths.tasksDir);
    const tasks: TaskRecord[] = [];
    for (const entry of entries) {
      if (!/^task_/.test(entry)) continue;
      try {
        tasks.push(await this.load(entry));
      } catch {
        // A corrupt task is surfaced when opened; listing should still work.
      }
    }
    return tasks.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }

  async resolveRef(ref: string): Promise<TaskRecord> {
    const trimmed = ref.trim();
    if (!trimmed || trimmed === "active" || trimmed === "latest") {
      const active = await this.getActive();
      if (active) return this.load(active);
      const tasks = await this.list(2);
      const newest = tasks[0];
      if (!newest) throw new AshError("NOT_FOUND", "No tasks exist yet. Use `new` to create one.");
      return newest;
    }
    try {
      return await this.load(trimmed);
    } catch (error) {
      if (!(error instanceof AshError) || error.code !== "NOT_FOUND") throw error;
      const tasks = await this.list(1000);
      const matches = tasks.filter((task) => task.id.startsWith(trimmed));
      if (matches.length === 1) return matches[0] as TaskRecord;
      if (matches.length > 1) {
        throw new AshError("CONFLICT", `Task reference "${trimmed}" is ambiguous. Use the full task id.`);
      }
      throw new AshError("NOT_FOUND", `No task matches "${trimmed}".`);
    }
  }

  async setActive(taskId: string): Promise<void> {
    await this.load(taskId);
    await ensurePrivateDir(path.dirname(this.paths.activeTaskFile));
    await atomicWriteFile(this.paths.activeTaskFile, `${taskId}\n`, { mode: 0o600 });
  }

  async getActive(): Promise<string | null> {
    try {
      const value = (await fs.readFile(this.paths.activeTaskFile, "utf8")).trim();
      if (!/^task_[A-Za-z0-9_-]{1,59}$/.test(value))
        throw new AshError("STATE_INVALID", "The active task reference is invalid.");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async loadLedger(taskId: string): Promise<LedgerRecord> {
    const task = await this.load(taskId);
    const raw = await readJsonIfExists<unknown>(this.ledgerFile(taskId));
    if (raw === null) {
      throw new AshError(
        "STATE_INVALID",
        "The budget ledger is missing. Refusing to recreate it and erase committed or paid funds.",
        { hint: `Restore ${this.ledgerFile(taskId)} from backup.` },
      );
    }
    const ledger = parseLedger(raw);
    if (ledger.task_id !== taskId || ledger.currency !== task.currency) {
      throw new AshError("STATE_INVALID", "Ledger does not belong to this task or currency.");
    }
    return ledger;
  }

  /**
   * Serialized read-modify-write for the ledger. The mutator receives the
   * latest ledger and must return the next record; invariants are rechecked.
   */
  async mutateLedger(taskId: string, mutator: (ledger: LedgerRecord) => LedgerRecord): Promise<LedgerRecord> {
    const lock = path.join(this.taskDir(taskId), "ledger.lock");
    return withFileLock(lock, async () => {
      const current = await this.loadLedger(taskId);
      const next = mutator(current);
      parseLedger(next);
      await atomicWriteJson(this.ledgerFile(taskId), next);
      return next;
    });
  }

  approvals(taskId: string): ApprovalManager {
    return new ApprovalManager({
      taskId,
      file: this.approvalsFile(taskId),
      defaultTtlMinutes: this.config.policy.approvalTtlMinutes,
    });
  }

  /** Serialize approval application with task edits and ledger mutations. */
  async applyBudgetApproval(taskId: string, approvalId: string): Promise<TaskRecord> {
    return withFileLock(path.join(this.taskDir(taskId), "task.lock"), async () => {
      const task = await this.load(taskId);
      const request = await this.approvals(taskId).assertApproved(approvalId, "budget_increase", {});
      const next = request.scope.to;
      if (
        !next ||
        request.scope.currency !== task.currency ||
        request.currency !== task.currency ||
        request.amount !== next
      ) {
        throw new AshError("APPROVAL_INVALID", "Budget approval scope is incomplete.");
      }
      const ledger = await this.mutateLedger(taskId, (current) => {
        const applied = current.entries.find(
          (entry) => entry.approval_ref === approvalId && ["ADJUST_UP", "ADJUST_DOWN"].includes(entry.kind),
        );
        if (applied) return current;
        if (request.scope.from !== current.authorized_budget)
          throw new AshError("APPROVAL_INVALID", "The budget changed after this request.");
        if (
          task.plan &&
          parseAmount(next, task.currency) <
            parseAmount(task.plan.external_planned, task.currency) + parseAmount(task.plan.contingency, task.currency)
        ) {
          throw new AshError("BUDGET_INVARIANT", "This budget would invalidate the current plan.");
        }
        return adjustBudget(current, next, request.id, `Authorized budget changed by human approval ${request.id}`);
      });
      task.authorized_budget = ledger.authorized_budget;
      task.status_detail = `Authorized budget is ${ledger.authorized_budget} ${task.currency}.`;
      task.revision += 1;
      task.updated_at = nowIso();
      await atomicWriteJson(this.taskFile(taskId), assertTaskConsistency(task));
      return task;
    });
  }

  async appendEvent(
    taskId: string,
    event: Omit<EngineEvent, "at" | "task_id"> & { at?: string; task_id?: string },
  ): Promise<EngineEvent> {
    const full: EngineEvent = EngineEventSchema.parse({
      at: event.at ?? nowIso(),
      task_id: taskId,
      subtask_id: event.subtask_id,
      level: event.level,
      code: event.code,
      message: event.message,
    }) as EngineEvent;
    await ensurePrivateDir(this.taskDir(taskId));
    await fs.appendFile(this.eventsFile(taskId), `${JSON.stringify(full)}\n`, { mode: 0o600 });
    return full;
  }

  async readEvents(taskId: string, limit = 40): Promise<EngineEvent[]> {
    try {
      const lines = await readTailLines(this.eventsFile(taskId), limit);
      const events: EngineEvent[] = [];
      for (const line of lines) {
        try {
          events.push(EngineEventSchema.parse(JSON.parse(line)) as EngineEvent);
        } catch {
          // Ignore a single torn line; never rewrite the audit stream.
        }
      }
      return events;
    } catch {
      return [];
    }
  }

  async installPlan(
    taskId: string,
    planInput: unknown,
    options: { planApprovalRef?: string | null } = {},
  ): Promise<TaskRecord> {
    return this.update(taskId, (task) => {
      if (
        ["executing", "paused", "completed", "failed", "cancelled"].includes(task.status) ||
        task.subtasks.some(
          (state) =>
            state.attempts.length > 0 || state.receipt_id !== null || !["pending", "ready"].includes(state.phase),
        )
      ) {
        throw new AshError(
          "CONFLICT",
          "This plan has started or the task is closed. Create a new task to replace it; existing progress must be preserved.",
        );
      }
      const plan = validatePlan(planInput, task.authorized_budget, task.currency, {
        allowedVerifyCommands: this.config.policy.allowedVerifyCommands,
        contingencyRatio: this.config.policy.contingencyRatio,
      });
      validateTaskPlan(plan, task);
      task.plan = plan;
      task.subtasks = initialSubtaskStates(plan);
      task.status = options.planApprovalRef
        ? "planned"
        : task.execution_strategy === "autonomous"
          ? "planned"
          : "awaiting_plan_approval";
      task.plan_approved_at = options.planApprovalRef ? nowIso() : null;
      task.plan_approval_ref = options.planApprovalRef ?? null;
    });
  }

  private resolveParallelJobs(requested: number | null): number {
    const max = this.config.policy.maxParallelJobs;
    if (requested !== null && requested > max) {
      throw new AshError(
        "VALIDATION_FAILED",
        `max_parallel_jobs ${requested} is above this installation's limit of ${max} (ASH_MAX_PARALLEL_JOBS).`,
      );
    }
    return Math.max(1, Math.min(max, requested ?? max));
  }

  /**
   * Acquire an execution lease for a task. Only one process may advance a
   * task at a time; an old lease is reclaimed only after its local owner exits.
   */
  async acquireEngineLock(taskId: string): Promise<() => Promise<void>> {
    const lockFile = path.join(this.taskDir(taskId), "engine.lock");
    await ensurePrivateDir(this.taskDir(taskId));
    let release: () => Promise<void>;
    try {
      release = await acquireFileLock(lockFile, { timeoutMs: 3_000, staleMs: 120_000 });
    } catch (error) {
      if (!(error instanceof AshError) || error.code !== "LOCK_TIMEOUT") throw error;
      throw new AshError("CONFLICT", `Task ${taskId} is already being executed by another Ash process.`, {
        cause: error,
      });
    }

    const heartbeat = setInterval(() => {
      const now = new Date();
      fs.utimes(lockFile, now, now).catch(() => undefined);
    }, 15_000);
    heartbeat.unref();

    return async () => {
      clearInterval(heartbeat);
      await release();
    };
  }
}
