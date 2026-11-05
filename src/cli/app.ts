import { assertPlanDecisionApplies, ensurePlanApproval } from "../security/plan-approval.js";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Interface } from "node:readline/promises";
import type { AppConfig } from "../config.js";
import type {
  ApprovalRequest,
  AttemptRecord,
  EngineEvent,
  LedgerRecord,
  TaskInput,
  TaskRecord,
} from "../domain/types.js";
import { TaskRecordSchema } from "../domain/schemas.js";
import { assemblePlan, validatePlan } from "../domain/plan.js";
import { ApprovalManager } from "../security/approvals.js";
import { summarizeLedger } from "../ledger/ledger.js";
import { publicConfig } from "../config.js";
import { PROJECT, SCOPES, getScope, isProjectId, projectLabel } from "../tracks.js";
import {
  persistJourney,
  persistTrackRun,
  runJourney,
  runTrack,
  allChecksPass,
  type TrackJourney,
  type TrackRun,
} from "../journey/index.js";
import { TRACK_MODULES } from "../trackflows/index.js";
import { readDeliveryText } from "../engine/helpers.js";
import { formatMinor, parseAmount, type Currency } from "../util/money.js";
import { sleep } from "../util/async.js";
import { formatLocal } from "../util/time.js";
import { clip, oneLine, stripAnsi } from "../util/strings.js";
import { isAshError, AshError, errorMessage } from "../errors.js";
import { redact } from "../util/redact.js";
import { hashJson } from "../util/json.js";
import { buildTaskReport, exportTaskReport } from "../report.js";
import { formatIntegrityReport } from "../transactions/ledger.js";
import { Theme } from "./theme.js";
import { APP_VERSION } from "../version.js";
import { helpText } from "./commands.js";
import { panel, table, keyValue, wrap } from "./components.js";
import {
  renderBudget,
  renderDashboard,
  renderPlan,
  renderTaskList,
  renderTaskTree,
  type DashboardData,
} from "./dashboard.js";
import { animateStartup, renderStartup, type StartupCheck } from "./splash.js";
import { runNewTaskWizard, parseBudget } from "./wizard.js";
import {
  attemptMarketConnection,
  createServices,
  refreshMarketBalance,
  startupChecks,
  type Services,
} from "./services.js";
import { notify } from "../notify.js";

const READ_ONLY_COMMANDS = new Set([
  "status",
  "budget",
  "transactions",
  "verify",
  "history",
  "approvals",
  "tasks",
  "market",
  "jobs",
  "agents",
  "export",
  "help",
  "notify-test",
  "notify_test",
]);

export async function runApp(config: AppConfig, argv: string[]): Promise<number> {
  const theme = new Theme(config);
  let shell: Shell | null = null;
  const services = await createServices(config, (event) => shell?.onEngineEvent(event));
  shell = new Shell(services, theme);
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(helpText());
      return 0;
    }
    if (argv.includes("--version") || argv.includes("-v")) {
      process.stdout.write(`Ash ${APP_VERSION}\n`);
      return 0;
    }
    const interactive = argv.length === 0 && process.stdin.isTTY;
    const quiet = argv.includes("--quiet") || process.env.ASH_NO_SPLASH === "1";
    if (interactive && !quiet) {
      const checks = await startupChecks(services);
      await animateStartup(theme, checks, config.animation);
    }
    const args = argv.filter((arg) => arg !== "--quiet");
    return await shell.run(args);
  } finally {
    await shell.close();
  }
}

function parseBool(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(normalized)) return true;
  if (["false", "no", "0", "off"].includes(normalized)) return false;
  throw new AshError("VALIDATION_FAILED", `Expected true/false, got "${value}".`);
}

export class Shell {
  private readonly services: Services;
  private readonly theme: Theme;
  private rl: Interface | null = null;
  private awaitingInput = false;
  private closing = false;
  private closed = false;
  private lastEvents = new Map<string, number>();
  private promptStatus = "ONLINE";
  private pipedLines: string[] = [];
  private exitStatus = 0;

  constructor(services: Services, theme: Theme) {
    this.services = services;
    this.theme = theme;
  }

  async run(argv: string[]): Promise<number> {
    if (!process.stdin.isTTY) return this.runPiped(argv);
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      historySize: 200,
      removeHistoryDuplicates: true,
    });
    this.rl = rl;
    rl.on("SIGINT", () => {
      void this.handleInterrupt();
    });
    if (argv.length === 0) await this.showStatus();
    if (argv.length > 0) {
      const command = argv.join(" ");
      const first = argv[0]?.toLowerCase() ?? "";
      await this.handle(command);
      if (!process.stdin.isTTY || READ_ONLY_COMMANDS.has(first) || first === "exit" || first === "quit") {
        rl.close();
        return this.exitStatus;
      }
    } else if (!process.stdin.isTTY) {
      // Piped input: process commands until EOF.
    }

    if (!this.promptOnce()) {
      await this.close();
      return 0;
    }
    for await (const line of rl) {
      this.awaitingInput = false;
      const trimmed = line.trim();
      if (!trimmed) {
        if (!this.promptOnce()) break;
        continue;
      }
      await this.handle(trimmed);
      if (this.closing) break;
      if (!this.promptOnce()) break;
    }
    await this.close();
    return 0;
  }

  private async runPiped(argv: string[]): Promise<number> {
    const first = argv[0]?.toLowerCase() ?? "";
    // Inspection commands must also finish when their parent's stdin stays open.
    const inspectOnly = READ_ONLY_COMMANDS.has(first);
    this.pipedLines = inspectOnly ? [] : await readStdinLines();
    if (argv.length === 0) await this.showStatus();
    if (argv.length > 0) {
      const first = argv[0]?.toLowerCase() ?? "";
      await this.handle(argv.join(" "));
      if (READ_ONLY_COMMANDS.has(first) || first === "exit" || first === "quit") {
        await this.close();
        return this.exitStatus;
      }
    }
    while (this.pipedLines.length > 0 && !this.closing) {
      const line = this.pipedLines.shift() ?? "";
      const trimmed = line.trim();
      if (!trimmed) continue;
      await this.handle(trimmed);
    }
    await this.close();
    return this.exitStatus;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.awaitingInput = false;
    try {
      this.rl?.close();
    } catch {
      // already closed
    }
    this.rl = null;
    await this.services.engine.stop().catch(() => undefined);
    await this.services.market.disconnect().catch(() => undefined);
  }

  onEngineEvent(event: EngineEvent): void {
    const key = `${event.subtask_id ?? "-"}:${event.code}`;
    const now = Date.now();
    const last = this.lastEvents.get(key) ?? 0;
    if (!["success", "error", "warn"].includes(event.level) && now - last < 20_000) return;
    this.lastEvents.set(key, now);
    const time = new Date(event.at).toISOString().slice(11, 19);
    const tone =
      event.level === "success" ? "green" : event.level === "warn" ? "amber" : event.level === "error" ? "red" : "cyan";
    const marker =
      event.level === "success"
        ? this.theme.symbol("ok")
        : event.level === "warn"
          ? this.theme.symbol("warn")
          : event.level === "error"
            ? this.theme.symbol("fail")
            : this.theme.symbol("bullet");
    const line = `${this.theme.dim(time)} ${this.theme.paint(tone, marker)} ${this.theme.paint(tone, event.code)} ${clip(redact(event.message), Math.max(30, this.theme.width - 34))}`;
    this.printAsync(line);
    if (["TASK_COMPLETED", "TASK_FAILED", "TASK_CANCELLED"].includes(event.code)) {
      const level = event.code === "TASK_COMPLETED" ? "success" : event.code === "TASK_FAILED" ? "error" : "warning";
      void notify(redact(event.message), level);
    }
  }

  private async handle(raw: string): Promise<void> {
    const tokens = raw.trim().split(/\s+/);
    const command = (tokens[0] ?? "").toLowerCase();
    const args = tokens.slice(1);
    try {
      switch (command) {
        case "help":
        case "?":
          await this.cmdHelp(args);
          break;
        case "new":
          await this.cmdNew(args);
          break;
        case "plan":
          await this.cmdPlan(args);
          break;
        case "execute":
        case "run":
          await this.cmdExecute();
          break;
        case "pause":
          await this.cmdPause();
          break;
        case "resume":
          await this.cmdResume();
          break;
        case "cancel":
          await this.cmdCancel();
          break;
        case "status":
        case "dashboard":
          await this.showStatus();
          break;
        case "wait": {
          const seconds = Math.max(1, Math.min(300, Number(args[0] ?? 5) || 5));
          this.print(this.theme.dim(`Waiting ${seconds}s for the engine…`));
          await sleep(seconds * 1_000);
          await this.showStatus();
          break;
        }
        case "budget":
        case "ledger":
          await this.cmdBudget(args);
          break;
        case "agents":
          await this.cmdAgents(args);
          break;
        case "jobs":
          await this.cmdJobs();
          break;
        case "transactions":
        case "tx":
          await this.cmdTransactions(args);
          break;
        case "verify":
          await this.cmdVerify();
          break;
        case "history":
          await this.cmdHistory(args);
          break;
        case "approvals":
          await this.cmdApprovals();
          break;
        case "approve":
          await this.cmdApprove(args);
          break;
        case "deny":
          await this.cmdDeny(args);
          break;
        case "review":
          await this.cmdReview(args);
          break;
        case "accept":
          await this.cmdAccept(args);
          break;
        case "settings":
        case "config":
          await this.cmdSettings(args);
          break;
        case "notify-test":
        case "notify_test":
          await this.cmdNotifyTest();
          break;
        case "export":
          await this.cmdExport(args);
          break;
        case "tasks":
          await this.cmdTasks();
          break;
        case "tracks":
        case "track":
          await this.cmdTracks(args);
          break;
        case "switch":
          await this.cmdSwitch(args);
          break;
        case "market":
          await this.cmdMarket();
          break;
        case "show":
          await this.cmdShow(args);
          break;
        case "exit":
        case "quit":
        case "q":
          this.closing = true;
          this.rl?.close();
          break;
        default:
          if (raw.trim().length >= 25 || tokens.length >= 4) {
            this.print(this.theme.paint("cyan", "Interpreting that as a new task description."));
            await this.cmdNew(tokens);
          } else {
            this.exitStatus = 1;
            this.print(this.theme.paint("red", `Unknown command: ${command}`));
            this.print(this.theme.dim("Type `help` for commands, or describe a task in plain language."));
          }
      }
    } catch (error) {
      this.exitStatus = 1;
      this.printError(error);
    }
  }

  private promptOnce(): boolean {
    if (!this.rl || this.closing) return false;
    try {
      this.setPrompt();
      this.rl.prompt();
      this.awaitingInput = true;
      return true;
    } catch {
      return false;
    }
  }

  private setPrompt(): void {
    if (!this.rl) return;
    const status = this.services.engine.isRunning() ? "ONLINE" : "IDLE";
    this.promptStatus = status;
    const prompt = this.theme.unicode
      ? `${this.theme.gradient("╭─[ASH]─[TASK EXECUTION]")}${this.theme.dim(`─[${status}]`)}\n${this.theme.gradient("╰─❯")} `
      : `ASH[${status}]> `;
    this.rl.setPrompt(prompt);
  }

  private async showStatus(): Promise<void> {
    await refreshMarketBalance(this.services);
    const { task, ledger, integrity, pendingApprovals } = await this.loadState();
    const marketInfo =
      this.services.market.capabilities().tools.length > 0
        ? await this.services.market.connect().catch(() => null)
        : null;
    const data: DashboardData = {
      config: this.services.config,
      task,
      ledger,
      receiptCount: integrity?.receipt_count ?? 0,
      integrity,
      market: marketInfo,
      marketError: this.services.marketError,
      pendingApprovals,
      engineRunning: this.services.engine.isRunning(),
    };
    this.print("");
    for (const line of renderDashboard(this.theme, data)) this.print(line);
    if (pendingApprovals > 0) {
      this.print(this.theme.paint("amber", `  ${pendingApprovals} approval request(s) pending — run \`approvals\`.`));
    }
    this.print("");
  }

  private async loadState(): Promise<{
    task: TaskRecord | null;
    ledger: LedgerRecord | null;
    integrity: Awaited<ReturnType<Services["transactions"]["verify"]>> | null;
    pendingApprovals: number;
  }> {
    let task: TaskRecord | null = null;
    let ledger: LedgerRecord | null = null;
    let integrity = null;
    let pendingApprovals = 0;
    try {
      const active = await this.services.store.getActive();
      task = active ? await this.services.store.load(active) : null;
      if (task) {
        ledger = await this.services.store.loadLedger(task.id);
        pendingApprovals = (await this.services.store.approvals(task.id).pending()).length;
      }
    } catch (error) {
      this.printError(error);
    }
    integrity = await this.services.transactions.verify().catch(() => null);
    return { task, ledger, integrity, pendingApprovals };
  }

  private async activeTask(): Promise<TaskRecord> {
    const active = await this.services.store.getActive();
    if (!active) throw new AshError("NOT_FOUND", "No active task. Use `new` to create one.");
    return this.services.store.load(active);
  }

  private async ask(question: string): Promise<string> {
    if (this.rl) return this.rl.question(question);
    process.stdout.write(question);
    const line = this.pipedLines.shift() ?? "";
    process.stdout.write(`${line}\n`);
    return line;
  }

  private print(text = ""): void {
    process.stdout.write(`${text}\n`);
  }

  private printAsync(text: string): void {
    if (this.awaitingInput && this.rl) {
      process.stdout.write(`\n${text}\n`);
      this.setPrompt();
      this.rl.prompt(true);
    } else {
      process.stdout.write(`${text}\n`);
    }
  }

  private printError(error: unknown): void {
    const ash = isAshError(error) ? error : new AshError("STATE_INVALID", errorMessage(error), { cause: error });
    const lines = [
      this.theme.paint("red", `${this.theme.symbol("fail")} ${ash.code}`),
      ...wrap(redact(ash.message), this.theme.width - 6).map((line) => this.theme.paint("red", line)),
    ];
    if (ash.hint) lines.push(this.theme.paint("amber", `Hint: ${redact(ash.hint)}`));
    this.print("");
    for (const line of panel(this.theme, "ERROR", lines, { tone: "red", shadow: true })) this.print(line);
    this.print("");
  }

  private async handleInterrupt(): Promise<void> {
    try {
      const task = await this.services.store.getActive().then((id) => (id ? this.services.store.load(id) : null));
      if (task?.status === "executing") {
        await this.services.store.update(task.id, (current) => {
          if (current.status !== "executing") return;
          current.status = "paused";
          current.status_detail = "Paused by Ctrl+C. Run `resume` to continue.";
        });
        this.print("");
        if (this.services.engine.isRunningTask(task.id)) await this.services.engine.stop();
        this.print(this.theme.paint("amber", "Execution paused."));
        this.print(this.theme.dim("Ctrl+C again to exit, or run `resume`."));
        return;
      }
    } catch {
      // fall through to exit
    }
    this.print("");
    this.print(this.theme.dim("Exiting. Transaction receipts are already durable."));
    this.closing = true;
    this.rl?.close();
  }

  private async cmdHelp(args: string[]): Promise<void> {
    const command = args[0]?.toLowerCase();
    const details: Record<string, string[]> = {
      new: ["new [task text]", "Guided setup for a task, budget, currency, approvals and preferences."],
      plan: [
        "plan | plan import <file>",
        "Ask the configured model for a budget-safe plan, or import a reviewed plan.",
      ],
      execute: ["execute", "Start the background execution engine for the approved plan."],
      pause: ["pause", "Stop starting new work; in-flight calls finish."],
      resume: ["resume", "Resume a paused task."],
      cancel: ["cancel", "Cancel the task. Does not call market cancel_job; escrow stays until resolved."],
      budget: [
        "budget | budget set <amount> <USD|USDC>",
        "Show the ledger and market balance; budget changes need approval.",
      ],
      approvals: ["approvals | approve <id> | deny <id>", "Human approval queue. Silence never approves."],
      review: ["review <subtask> pass|fail [note]", "Human review after the verifier asks for it."],
      verify: ["verify", "Verify every receipt hash, chain link, filename and the chain head."],
      settings: ["settings [set <key> <value>]", "Show config; change permitted task preferences."],
      export: ["export [path]", "Write a Markdown and JSON task report."],
      "notify-test": ["notify-test", "Send one Telegram test message if notifications are configured."],
    };
    if (command && details[command]) {
      this.print("");
      this.print(this.theme.paint("cyan", details[command]![0] ?? ""));
      this.print(`  ${details[command]![1] ?? ""}`);
      this.print("");
      return;
    }
    const rows = [
      ["new", "Create a task", "type a task in plain language too"],
      ["plan", "Plan or import", "approve plan before execution"],
      ["execute", "Run plan", "background engine"],
      ["pause / resume", "Control", "state persists"],
      ["cancel", "Stop task", "escrow not auto-refunded"],
      ["status / budget", "Inspect", "real state only"],
      ["agents / jobs", "Marketplace", "live or simulated"],
      ["transactions / verify", "Receipts", "SHA-256 chain"],
      ["approvals / approve", "Human gates", "typed phrase"],
      ["review", "Human verification", "pass or fail"],
      ["settings", "Preferences", "budget needs approval"],
      ["export", "Report", "Markdown + JSON"],
      ["notify-test", "Telegram check", "optional notifications"],
      ["tasks / switch", "Sessions", "one ledger per task"],
      ["tracks [id]", "Project workstreams", "one Ash project, six gates"],
      ["market", "Connection", "tools and auth"],
      ["wait", "Observe", "let the engine advance"],
      ["exit", "Leave", "engine stops"],
    ];
    this.print("");
    for (const line of panel(this.theme, "COMMAND CENTRE", ["Natural language also works: describe a task.", ""], {
      tone: "purple",
    }))
      this.print(line);
    for (const line of table(this.theme, ["Command", "Purpose", "Note"], rows, { tones: ["cyan", "white", "grey"] }))
      this.print(line);
    this.print("");
  }
  private async cmdNew(args: string[]): Promise<void> {
    if (this.services.engine.isRunning())
      throw new AshError("CONFLICT", "Pause or finish the active execution before creating another task.");
    const task = await runNewTaskWizard({
      rl: this.rl ?? { question: (question: string) => this.ask(question) },
      theme: this.theme,
      store: this.services.store,
      config: this.services.config,
      prefillDescription: args.join(" ").trim() || undefined,
    });
    if (task) {
      const answer = await this.ask(this.theme.paint("cyan", "Generate the execution plan now? [Y/n] "));
      if (!answer.trim() || ["y", "yes"].includes(answer.trim().toLowerCase())) {
        await this.cmdPlan([]);
      }
    }
  }

  private async cmdPlan(args: string[]): Promise<void> {
    const task = await this.activeTask();
    if (["executing", "completed", "failed", "cancelled"].includes(task.status)) {
      if (task.plan) {
        this.print("");
        for (const line of renderPlan(this.theme, task, task.plan)) this.print(line);
        this.print(this.theme.paint("amber", "The plan is already in use. Create a new task to change it."));
        return;
      }
      throw new AshError("CONFLICT", `Task is ${task.status}; cannot create a plan.`);
    }

    if (task.plan && args.length === 0) {
      const result = await ensurePlanApproval(this.services.store, task.id);
      for (const line of renderPlan(this.theme, result.task, result.task.plan!)) this.print(line);
      this.print(
        result.approval
          ? this.theme.paint(
              "amber",
              `Plan approval required: ${result.approval.id}. Run approve ${result.approval.id}. Existing progress is preserved.`,
            )
          : this.theme.paint("green", "The existing plan is approved. Run execute when ready."),
      );
      return;
    }

    let plan;
    let planHash: string;
    let source = "model";
    if (args[0]?.toLowerCase() === "import") {
      const file = args[1];
      if (!file) throw new AshError("VALIDATION_FAILED", "Usage: plan import <file.json>");
      const resolved = path.resolve(file);
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat?.isFile()) throw new AshError("NOT_FOUND", `Plan file not found: ${resolved}`);
      if (stat.size > 5 * 1024 * 1024) throw new AshError("VALIDATION_FAILED", "Plan file is larger than 5 MiB.");
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(resolved, "utf8"));
      } catch (error) {
        throw new AshError("VALIDATION_FAILED", "Plan file is not valid JSON.", { cause: error });
      }
      const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const assembled =
        typeof record.external_planned === "string" && typeof record.currency === "string"
          ? raw
          : assemblePlan(raw, task.currency, task.authorized_budget, [
              "Imported by the human from a reviewed plan file.",
            ]);
      plan = validatePlan(assembled, task.authorized_budget, task.currency, {
        allowedVerifyCommands: this.services.config.policy.allowedVerifyCommands,
        contingencyRatio: this.services.config.policy.contingencyRatio,
      });
      planHash = hashJson(plan);
      source = `import:${path.basename(resolved)}`;
    } else {
      if (!this.services.model.available) {
        throw new AshError("MODEL_UNAVAILABLE", "No AI model is configured, so Ash cannot plan.", {
          hint: "Set the ASH_MODEL_* variables, or run `plan import <file.json>` with a reviewed plan.",
        });
      }
      this.print(this.theme.paint("cyan", "Planning… Ash is reasoning about the task, budget and dependencies."));
      const result = await this.services.planner.plan(task);
      plan = result.plan;
      planHash = result.planHash;
    }

    let updated = await this.services.store.installPlan(task.id, plan);
    const autonomous = updated.execution_strategy === "autonomous";
    if (autonomous) {
      updated = await this.services.store.update(task.id, (current) => {
        if (current.status !== "planned" || hashJson(current.plan) !== planHash)
          throw new AshError("CONFLICT", "The task changed while its plan was being installed.");
        current.plan_approved_at = new Date().toISOString();
        current.plan_approval_ref = "strategy:autonomous";
        current.status = "planned";
        current.status_detail =
          "Plan accepted because the human selected the fully autonomous strategy at task creation.";
      });
      await this.services.store.appendEvent(task.id, {
        subtask_id: null,
        level: "info",
        code: "PLAN_ACCEPTED_AUTONOMOUS",
        message:
          "Plan accepted under the task's autonomous strategy. Marketplace page approvals are still required by the market.",
      });
    } else {
      const request = await this.services.store.approvals(task.id).request({
        kind: "plan",
        summary: `Approve the execution plan for "${clip(task.description, 120)}" — ${plan.subtasks.length} subtasks, ${plan.external_planned} ${task.currency} external work, ${plan.contingency} reserve.`,
        amount: plan.external_planned,
        currency: task.currency,
        scope: {
          plan_hash: planHash,
          subtasks: String(plan.subtasks.length),
          external_planned: plan.external_planned,
          contingency: plan.contingency,
          currency: task.currency,
          source,
        },
      });
      this.print(
        this.theme.paint("amber", `Plan approval required: ${request.id}. Run \`approve ${request.id}\` to accept it.`),
      );
    }

    this.print("");
    this.print(this.theme.paint("green", "PLAN READY"));
    this.print(
      this.theme.dim(
        `Source: ${source} · strategy: ${updated.execution_strategy}${autonomous ? " (auto-accepted)" : " (human approval required)"}`,
      ),
    );
    this.print("");
    for (const line of renderPlan(this.theme, updated, plan)) this.print(line);
    this.print("");
    if (!autonomous) {
      this.print(
        this.theme.paint("amber", "No money will move and no hire will be prepared until the plan is approved."),
      );
    } else {
      this.print(
        this.theme.dim(
          "Run `execute` when ready. Each standard marketplace hire still needs your approval on the market page.",
        ),
      );
    }
  }

  private async cmdExecute(): Promise<void> {
    const task = await this.activeTask();
    if (!task.plan) throw new AshError("CONFLICT", "No plan yet. Run `plan` first.");
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      throw new AshError("CONFLICT", `Task is already ${task.status}.`);
    }
    if (task.status === "awaiting_plan_approval") {
      const pending = await this.services.store.approvals(task.id).pending();
      const planRequest = pending.find((approval) => approval.kind === "plan");
      throw new AshError("APPROVAL_REQUIRED", "The plan has not been approved.", {
        hint: planRequest ? `Run \`approve ${planRequest.id}\` first.` : "Run `plan` or import a plan.",
      });
    }
    if (task.plan_approval_ref === null && task.execution_strategy !== "autonomous") {
      throw new AshError("APPROVAL_REQUIRED", "The plan has not been approved.");
    }
    if (this.services.engine.isRunning()) {
      if (!this.services.engine.isRunningTask(task.id))
        throw new AshError("CONFLICT", "The execution engine is running another task.");
      if (task.status === "executing") {
        this.print(this.theme.paint("green", "Execution engine is already running."));
        return;
      }
      await this.services.engine.stop();
    }
    await this.services.store.update(task.id, (current) => {
      if (["completed", "failed", "cancelled"].includes(current.status))
        throw new AshError("CONFLICT", `Task is already ${current.status}.`);
      if (hashJson(current.plan) !== hashJson(task.plan))
        throw new AshError("CONFLICT", "The plan changed while starting execution.");
      current.status = "executing";
      current.status_detail = null;
      current.updated_at = new Date().toISOString();
    });
    try {
      await this.services.engine.start();
    } catch (error) {
      await this.services.store
        .update(task.id, (current) => {
          if (current.status === "executing") {
            current.status = "paused";
            current.status_detail = `Execution could not start: ${errorMessage(error)}`;
          }
        })
        .catch(() => undefined);
      throw error;
    }
    const afterStart = await this.services.store.load(task.id);
    if (afterStart.status !== "executing") {
      this.print(this.theme.paint("green", `Task is already ${afterStart.status}. No engine work remains.`));
      return;
    }
    this.print("");
    this.print(this.theme.paint("green", "EXECUTION ENGINE ONLINE"));
    this.print(
      this.theme.dim("Ash will use the persisted plan, dependency graph and budget ledger. Commands remain available."),
    );
    if (this.services.config.simulation) {
      this.print(this.theme.paint("magenta", "SIMULATION MODE — no real agents, funds or payments."));
    } else {
      this.print(
        this.theme.paint(
          "amber",
          "Market hires still require your approval on the marketplace page. Ash cannot approve charges.",
        ),
      );
    }
    this.print("");
  }

  private async cmdPause(): Promise<void> {
    const task = await this.activeTask();
    if (task.status !== "executing") throw new AshError("CONFLICT", `Task is ${task.status}, not executing.`);
    await this.services.store.update(task.id, (current) => {
      if (current.status !== "executing") throw new AshError("CONFLICT", `Task is ${current.status}, not executing.`);
      current.status = "paused";
      current.status_detail = "Paused by human. In-flight operations finish and persist.";
    });
    if (this.services.engine.isRunningTask(task.id)) await this.services.engine.stop();
    this.print(this.theme.paint("amber", "Execution paused."));
  }

  private async cmdResume(): Promise<void> {
    const task = await this.activeTask();
    if (task.status !== "paused") throw new AshError("CONFLICT", `Task is ${task.status}, not paused.`);
    if (!task.plan) throw new AshError("CONFLICT", "Task has no plan.");
    if (task.plan_approval_ref === null && task.execution_strategy !== "autonomous") {
      throw new AshError("APPROVAL_REQUIRED", "Approve the plan before resuming.");
    }
    if (this.services.engine.isRunning()) {
      if (!this.services.engine.isRunningTask(task.id))
        throw new AshError("CONFLICT", "The execution engine is running another task.");
      await this.services.engine.stop();
    }
    await this.services.store.update(task.id, (current) => {
      if (current.status !== "paused") throw new AshError("CONFLICT", `Task is ${current.status}, not paused.`);
      if (hashJson(current.plan) !== hashJson(task.plan))
        throw new AshError("CONFLICT", "The plan changed while resuming execution.");
      current.status = "executing";
      current.status_detail = null;
    });
    try {
      await this.services.engine.start();
    } catch (error) {
      await this.services.store
        .update(task.id, (current) => {
          if (current.status === "executing") {
            current.status = "paused";
            current.status_detail = `Resume failed: ${errorMessage(error)}`;
          }
        })
        .catch(() => undefined);
      throw error;
    }
    this.print(this.theme.paint("green", "Execution resumed."));
  }

  private async cmdCancel(): Promise<void> {
    const task = await this.activeTask();
    if (task.status === "cancelled") {
      this.print(this.theme.dim("Task is already cancelled."));
      return;
    }
    this.print("");
    this.print(this.theme.paint("red", "Cancelling stops new work and records a receipt for every started subtask."));
    this.print(
      this.theme.paint(
        "amber",
        "Ash will NOT call market cancel_job automatically. Escrow stays committed until the market confirms a refund.",
      ),
    );
    const phrase = `CANCEL ${task.id}`;
    this.print(this.theme.dim(`Type exactly: ${phrase}`));
    const answer = (await this.ask(this.theme.paint("red", "Confirm: "))).trim();
    if (answer !== phrase) {
      this.print(this.theme.dim("Cancellation aborted. Nothing changed."));
      return;
    }
    await this.services.engine.cancelTask(task.id, "Cancelled by human from the command centre.");
    if (this.services.engine.isRunningTask(task.id)) await this.services.engine.stop();
    this.print(
      this.theme.paint("amber", "Task cancelled. Review `transactions` for receipts and any REFUND_PENDING escrow."),
    );
  }

  private async cmdBudget(args: string[]): Promise<void> {
    const task = await this.activeTask();
    if (args[0]?.toLowerCase() === "set") {
      const text = args.slice(1).join(" ").trim();
      const match = /^([0-9]+(?:\.[0-9]{1,6})?)\s*(USD|USDC)?$/i.exec(text);
      if (!match?.[1]) throw new AshError("VALIDATION_FAILED", "Usage: budget set <amount> <USD|USDC>");
      const currency = (match[2]?.toUpperCase() as Currency | undefined) ?? task.currency;
      if (currency !== task.currency) {
        throw new AshError(
          "VALIDATION_FAILED",
          `This task's ledger is in ${task.currency}; budgets cannot switch currency mid-task.`,
        );
      }
      const requested = parseAmount(match[1], currency);
      const ledger = await this.services.store.loadLedger(task.id);
      const totals = summarizeLedger(ledger);
      const committed = totals.committed;
      const paid = totals.paid;
      if (requested < committed + paid) {
        throw new AshError(
          "BUDGET_INVARIANT",
          `New budget ${match[1]} ${currency} is below committed+paid (${formatMinor(committed + paid, currency)} ${currency}).`,
        );
      }
      if (task.plan && requested < parseAmount(task.authorized_budget, currency)) {
        const required =
          parseAmount(task.plan.external_planned, currency) + parseAmount(task.plan.contingency, currency);
        if (requested < required) {
          throw new AshError(
            "BUDGET_INVARIANT",
            `A decrease below the current plan's ${formatMinor(required, currency)} ${currency} external+reserve would invalidate it. Cancel or replan first.`,
          );
        }
      }
      const request = await this.services.store.approvals(task.id).request({
        kind: "budget_increase",
        summary: `Change the authorized budget from ${task.authorized_budget} to ${match[1]} ${currency}.`,
        amount: match[1],
        currency,
        scope: {
          from: task.authorized_budget,
          to: match[1],
          currency,
        },
      });
      this.print(
        this.theme.paint("amber", `Budget change approval required: ${request.id}. Run \`approve ${request.id}\`.`),
      );
      this.print(this.theme.dim("A budget change is never applied until you type the approval phrase."));
      return;
    }
    const ledger = await this.services.store.loadLedger(task.id);
    this.print("");
    for (const line of renderBudget(this.theme, task, ledger, this.services.config)) this.print(line);
    this.print("");
  }

  private async cmdTransactions(args: string[]): Promise<void> {
    const limit = Math.max(1, Math.min(200, Number(args[0] ?? 20) || 20));
    let receipts;
    try {
      receipts = await this.services.transactions.history(limit);
    } catch (error) {
      const report = await this.services.transactions.verify();
      this.print("");
      for (const line of panel(this.theme, "TRANSACTION CHAIN BROKEN", formatIntegrityReport(report), {
        tone: "red",
        shadow: true,
      }))
        this.print(line);
      this.print(this.theme.paint("red", `Refusing to list receipts from a broken chain: ${errorMessage(error)}`));
      return;
    }
    if (receipts.length === 0) {
      this.print(this.theme.dim("No transaction receipts yet. The transactions/ folder is created on the first one."));
      return;
    }
    const rows = receipts.map((receipt) => [
      String(receipt.metadata.file ?? receipt.transaction_id),
      receipt.status,
      clip(receipt.item, 30),
      clip(receipt.vendor?.name ?? "—", 22),
      receipt.agreed_price ? `${receipt.agreed_price} ${receipt.currency}` : "—",
      receipt.payment_status,
      `${receipt.hash.slice(0, 12)}…`,
    ]);
    this.print("");
    for (const line of table(this.theme, ["File", "Status", "Item", "Vendor", "Agreed", "Payment", "Hash"], rows, {
      tones: ["grey", "green", "white", "purple", "cyan", "amber", "grey"],
    }))
      this.print(line);
    const report = await this.services.transactions.verify();
    this.print("");
    this.print(
      report.ok
        ? this.theme.paint(
            "green",
            `Chain verified · ${report.receipt_count} receipts · head ${report.last_hash?.slice(0, 16) ?? "—"}…`,
          )
        : this.theme.paint("red", "CHAIN BROKEN — run `verify` for details."),
    );
    this.print("");
  }

  private async cmdVerify(): Promise<void> {
    const report = await this.services.transactions.verify();
    const lines = formatIntegrityReport(report);
    this.print("");
    for (const line of panel(
      this.theme,
      report.ok ? "LEDGER INTEGRITY — VERIFIED" : "LEDGER INTEGRITY — FAILED",
      lines,
      {
        tone: report.ok ? "green" : "red",
        shadow: true,
      },
    ))
      this.print(line);
    if (!report.ok) {
      this.exitStatus = 1;
      this.print(this.theme.paint("red", "Ash will not append to a broken chain and will not silently repair it."));
      this.print(this.theme.dim("Restore the original receipt file(s) from backup, then run verify again."));
    } else if (report.warnings.length > 0) {
      this.print(this.theme.paint("amber", "Warnings are informational; the hash chain itself is intact."));
    }
    this.print("");
  }

  private async cmdHistory(args: string[]): Promise<void> {
    const task = await this.activeTask();
    const ledger = await this.services.store.loadLedger(task.id);
    const limit = Math.max(1, Math.min(500, Number(args[0] ?? 20) || 20));
    const entries = ledger.entries.slice(-limit);
    const rows = entries.map((entry) => [
      formatLocal(entry.at),
      entry.kind,
      `${entry.amount} ${entry.currency}`,
      clip(entry.reference, 28),
      clip(entry.description, 44),
    ]);
    this.print("");
    for (const line of table(this.theme, ["Time", "Kind", "Amount", "Reference", "Description"], rows, {
      tones: ["grey", "cyan", "green", "purple", "white"],
    }))
      this.print(line);
    this.print("");
  }

  private async cmdApprovals(): Promise<void> {
    const task = await this.activeTask();
    const requests = await this.services.store.approvals(task.id).list();
    if (requests.length === 0) {
      this.print(this.theme.dim("No approval requests for this task."));
      return;
    }
    const shown = requests.slice(-10);
    this.print("");
    for (const request of shown) {
      const lines = [
        keyValue(
          this.theme,
          "Status",
          `${request.status.toUpperCase()}${request.status === "pending" ? "" : ` at ${formatLocal(request.decided_at)}`}`,
          request.status === "approved" ? "green" : request.status === "pending" ? "amber" : "red",
        ),
        keyValue(this.theme, "Kind", request.kind, "purple"),
        keyValue(this.theme, "Amount", request.amount ? `${request.amount} ${request.currency}` : "—", "cyan"),
        keyValue(this.theme, "Expires", formatLocal(request.expires_at), "grey"),
        ...wrap(request.summary, Math.max(20, this.theme.width - 20)).map((line) => `  ${line}`),
        ...this.approvalScopeLines(request),
        request.status === "pending"
          ? this.theme.paint("amber", `  -> approve ${request.id}   |   deny ${request.id}`)
          : "",
      ].filter(Boolean);
      for (const line of panel(this.theme, `APPROVAL ${request.id}`, lines, {
        tone: request.status === "pending" ? "amber" : "grey",
      }))
        this.print(line);
      this.print("");
    }
  }

  private approvalScopeLines(request: ApprovalRequest): string[] {
    const entries = Object.entries(request.scope);
    if (entries.length === 0) return [];
    return [
      this.theme.dim("  Scope:"),
      ...entries.map(([key, value]) =>
        this.theme.dim(`    ${key}: ${clip(redact(value), Math.max(20, this.theme.width - 24))}`),
      ),
    ];
  }

  private async cmdApprove(args: string[]): Promise<void> {
    const id = args[0];
    if (!id) throw new AshError("VALIDATION_FAILED", "Usage: approve <approval-id>");
    const task = await this.activeTask();
    const approvals = this.services.store.approvals(task.id);
    const request = await approvals.get(id);
    if (!request) throw new AshError("NOT_FOUND", `Approval ${id} does not exist.`);
    if (request.status !== "pending")
      throw new AshError("APPROVAL_INVALID", `Approval ${id} is already ${request.status}.`);

    if (request.kind === "plan") {
      assertPlanDecisionApplies(task, request);
    }
    if (request.kind === "budget_increase") {
      const scopeCurrency = request.scope.currency;
      if (scopeCurrency !== task.currency || request.scope.from !== task.authorized_budget) {
        throw new AshError(
          "APPROVAL_INVALID",
          "The task budget changed after this request. Request a fresh budget change.",
        );
      }
    }

    const phrase = approvals.confirmationPhrase(request);
    this.print("");
    this.print(this.theme.paint("cyan", request.summary));
    if (request.amount) this.print(this.theme.paint("cyan", `Amount: ${request.amount} ${request.currency}`));
    for (const line of this.approvalScopeLines(request)) this.print(line);
    this.print(this.theme.dim(`Type exactly: ${phrase}`));
    const answer = (await this.ask(this.theme.paint("green", "Confirm: "))).trim();
    if (answer !== phrase) {
      this.print(this.theme.paint("red", "Phrase did not match. Nothing was approved."));
      return;
    }
    await approvals.decide(id, "approved", answer);

    if (request.kind === "plan") {
      await this.services.store.update(task.id, (current) => {
        assertPlanDecisionApplies(current, request);
        current.plan_approved_at = new Date().toISOString();
        current.plan_approval_ref = request.id;
        current.status = "planned";
        current.status_detail = "Plan approved by human.";
      });
      this.print(this.theme.paint("green", "Plan approved. Run `execute` to start."));
      return;
    }
    if (request.kind === "budget_increase") {
      await this.applyBudgetApproval(task, request);
      return;
    }
    if (request.kind === "accept_result") {
      this.print(
        this.theme.paint("green", "Acceptance approved. The engine will ask the market for the acceptance page."),
      );
      this.print(
        this.theme.paint(
          "amber",
          "The market page still performs the actual release. Ash waits for it to report completion.",
        ),
      );
      return;
    }
    this.print(
      this.theme.paint(
        "green",
        `Approval ${request.id} recorded. The execution engine will continue on its next check.`,
      ),
    );
  }

  private async applyBudgetApproval(task: TaskRecord, request: ApprovalRequest): Promise<void> {
    const next = request.scope.to;
    const currency = request.scope.currency as Currency;
    if (!next || currency !== task.currency)
      throw new AshError("APPROVAL_INVALID", "Budget approval scope is incomplete.");
    await this.services.store.applyBudgetApproval(task.id, request.id);
    const updatedLedger = await this.services.store.loadLedger(task.id);
    const totals = summarizeLedger(updatedLedger);
    await this.services.store.appendEvent(task.id, {
      subtask_id: null,
      level: "success",
      code: "BUDGET_CHANGED",
      message: `Authorized budget changed to ${next} ${currency}. Available after change: ${formatMinor(totals.available, currency)}.`,
    });
    this.print(
      this.theme.paint(
        "green",
        `Budget changed to ${next} ${currency}. Available: ${formatMinor(totals.available, currency)}.`,
      ),
    );
  }

  private async cmdDeny(args: string[]): Promise<void> {
    const id = args[0];
    if (!id) throw new AshError("VALIDATION_FAILED", "Usage: deny <approval-id>");
    const task = await this.activeTask();
    const approvals = this.services.store.approvals(task.id);
    const request = await approvals.get(id);
    if (!request) throw new AshError("NOT_FOUND", `Approval ${id} does not exist.`);
    if (request.status !== "pending")
      throw new AshError("APPROVAL_INVALID", `Approval ${id} is already ${request.status}.`);
    const phrase = approvals.denialPhrase(request);
    this.print(this.theme.dim(`Type exactly: ${phrase}`));
    const answer = (await this.ask(this.theme.paint("red", "Confirm denial: "))).trim();
    if (answer !== phrase) {
      this.print(this.theme.dim("Phrase did not match. Nothing changed."));
      return;
    }
    await approvals.decide(id, "denied", answer);
    this.print(this.theme.paint("amber", `Approval ${id} denied. No action was taken.`));
  }

  private async cmdReview(args: string[]): Promise<void> {
    const task = await this.activeTask();
    const subtaskRef = args[0];
    const decisionRaw = (args[1] ?? "").toLowerCase();
    if (!subtaskRef || !["pass", "fail"].includes(decisionRaw)) {
      throw new AshError("VALIDATION_FAILED", "Usage: review <subtask-id> pass|fail [note]");
    }
    const state =
      task.subtasks.find((candidate) => candidate.id === subtaskRef) ??
      (task.subtasks.length === 1 ? task.subtasks[0] : undefined);
    if (!state) throw new AshError("NOT_FOUND", `No subtask ${subtaskRef}.`);
    if (state.phase !== "awaiting_human_review" && state.phase !== "verifying") {
      throw new AshError("CONFLICT", `Subtask ${state.id} is ${state.phase}; it is not awaiting human review.`);
    }
    const attempt = state.attempts[state.active_attempt - 1] ?? state.attempts[state.attempts.length - 1];
    if (!attempt?.delivery) throw new AshError("CONFLICT", "No stored deliverable to review.");
    await this.printDeliverablePreview(state.id, attempt, 40);
    const decision = decisionRaw as "pass" | "fail";
    const phrase = `REVIEW ${state.id} ${decision.toUpperCase()}`;
    this.print("");
    this.print(this.theme.paint("amber", `This is an explicit human verification decision for ${state.id}.`));
    this.print(this.theme.dim(`Type exactly: ${phrase}`));
    const answer = (await this.ask(this.theme.paint("green", "Confirm: "))).trim();
    if (answer !== phrase) {
      this.print(this.theme.dim("Phrase did not match. The deliverable was not accepted or rejected."));
      return;
    }
    const note =
      args.slice(2).join(" ").trim() ||
      (decision === "pass"
        ? "Human reviewed the deliverable and accepted it."
        : "Human reviewed the deliverable and rejected it.");
    const verification = await this.services.engine.reviewSubtask(task.id, state.id, decision, note);
    this.print("");
    this.print(
      verification.passed
        ? this.theme.paint("green", `Human review passed for ${state.id}.`)
        : this.theme.paint("red", `Human review did not pass for ${state.id}: ${verification.details}`),
    );
    const refreshed = await this.activeTask();
    const refreshedState = refreshed.subtasks.find((candidate) => candidate.id === state.id);
    if (refreshedState?.phase === "awaiting_acceptance_approval") {
      const approvals = await this.services.store.approvals(task.id).pending();
      const request = approvals.find((candidate) => candidate.kind === "accept_result");
      if (request)
        this.print(
          this.theme.paint("amber", `Acceptance approval ${request.id} is pending. Run \`approve ${request.id}\`.`),
        );
    }
    if (verification.passed && refreshedState?.phase === "failed") {
      this.print(
        this.theme.paint("amber", "The subtask receipt marks the work rejected or failed; inspect `transactions`."),
      );
    }
  }

  private async printDeliverablePreview(subtaskId: string, attempt: AttemptRecord, lines: number): Promise<void> {
    this.print("");
    this.print(
      this.theme.paint(
        "cyan",
        `DELIVERABLE ${subtaskId} · attempt ${attempt.attempt} · ${attempt.delivery?.source ?? "unknown"}`,
      ),
    );
    if (attempt.delivery?.text_path) {
      this.print(this.theme.dim(`Stored: ${attempt.delivery.text_path}`));
    }
    if (attempt.delivery?.external_url)
      this.print(this.theme.paint("cyan", `External: ${attempt.delivery.external_url}`));
    if (attempt.delivery?.injection_signals.length) {
      this.print(this.theme.paint("red", `Injection signals: ${attempt.delivery.injection_signals.join(", ")}`));
    }
    if (attempt.verification) {
      this.print(
        this.theme.paint(
          attempt.verification.passed ? "green" : attempt.verification.status === "needs_human" ? "amber" : "red",
          `Verifier: ${attempt.verification.status.toUpperCase()} — ${clip(attempt.verification.details, Math.max(30, this.theme.width - 16))}`,
        ),
      );
    }
    try {
      const text = await readDeliveryText(this.services.config, attempt.delivery ?? { text_path: null, sha256: null });
      const all = text.split("\n");
      this.print("");
      for (const line of all.slice(0, lines)) this.print(this.theme.dim("│ ") + line);
      if (all.length > lines)
        this.print(
          this.theme.dim(`│ … ${all.length - lines} more line(s) — use \`show ${subtaskId}\` or open the stored file`),
        );
    } catch (error) {
      this.print(this.theme.paint("amber", `Could not read the deliverable: ${errorMessage(error)}`));
    }
    this.print("");
  }

  private async cmdShow(args: string[]): Promise<void> {
    const task = await this.activeTask();
    const ref = args[0];
    if (!ref) throw new AshError("VALIDATION_FAILED", "Usage: show <subtask-id|task> [lines]");
    if (ref === "task") {
      this.print(redact(task.description));
      return;
    }
    const state = task.subtasks.find((candidate) => candidate.id === ref);
    if (!state) throw new AshError("NOT_FOUND", `No subtask ${ref}.`);
    const attempt = state.attempts[state.active_attempt - 1] ?? state.attempts[state.attempts.length - 1];
    if (!attempt?.delivery) throw new AshError("CONFLICT", "No deliverable stored for that subtask.");
    const lines = Math.max(10, Math.min(400, Number(args[1] ?? 120) || 120));
    await this.printDeliverablePreview(state.id, attempt, lines);
  }

  private async cmdAccept(args: string[]): Promise<void> {
    const task = await this.activeTask();
    const ref = args[0];
    const states = ref
      ? task.subtasks.filter((candidate) => candidate.id === ref)
      : task.subtasks.filter(
          (candidate) =>
            candidate.phase === "awaiting_acceptance_approval" || candidate.phase === "awaiting_market_acceptance",
        );
    if (states.length === 0) {
      this.print(this.theme.dim("No subtask is awaiting acceptance. Use `status` / `jobs`."));
      return;
    }
    for (const state of states) {
      const attempt = state.attempts[state.active_attempt - 1] ?? state.attempts[state.attempts.length - 1];
      this.print("");
      this.print(this.theme.paint("cyan", `${state.id} · ${state.phase}`));
      if (attempt?.verification) {
        this.print(
          this.theme.paint(
            attempt.verification.passed ? "green" : "red",
            `Verification: ${attempt.verification.status} — ${clip(attempt.verification.details, this.theme.width - 20)}`,
          ),
        );
      }
      if (attempt?.job_id)
        this.print(this.theme.dim(`Job: ${attempt.job_id} · payment: ${attempt.payment_status ?? "unknown"}`));
      if (attempt?.approval_url) this.print(this.theme.paint("cyan", `Market page: ${attempt.approval_url}`));
      if (state.phase === "awaiting_acceptance_approval" && attempt?.acceptance_approval_ref) {
        this.print(
          this.theme.paint("amber", `Acceptance approval pending: run \`approve ${attempt.acceptance_approval_ref}\`.`),
        );
      }
      if (state.phase === "awaiting_market_acceptance") {
        this.print(
          this.theme.paint(
            "amber",
            "Waiting for the market to report the job completed. Ash does not assume payment was released.",
          ),
        );
      }
    }
    this.print("");
  }

  private async cmdSettings(args: string[]): Promise<void> {
    const config = publicConfig(this.services.config);
    if (args.length === 0) {
      const rows = [
        ["mode", config.mode],
        ["model provider", config.model_provider],
        ["model", config.model_name ?? "not configured"],
        ["model host", config.model_base_url_host ?? "—"],
        ["market", config.market_url],
        ["market auth", config.market_token_configured ? "configured (value hidden)" : "not configured"],
        ["market mode", config.market_mode],
        ["in-call spend", config.in_call_spend ? "enabled" : "disabled"],
        ["hiring mode", config.hiring_mode],
        ["max parallel", String(config.max_parallel_jobs)],
        ["contingency", `${(config.contingency_ratio * 100).toFixed(0)}%`],
        ["approval TTL", `${config.approval_ttl_minutes}m`],
        ["verify commands", String(config.verify_commands_allowlisted)],
        ["telegram", config.telegram_configured ? "configured (values hidden)" : "not configured"],
        ["data dir", config.data_dir],
      ];
      this.print("");
      for (const line of table(this.theme, ["Setting", "Value"], rows, { tones: ["cyan", "white"] })) this.print(line);
      try {
        const task = await this.activeTask();
        this.print("");
        this.print(this.theme.paint("cyan", `TASK PREFERENCES · ${task.id}`));
        this.print(`${keyValue(this.theme, "strategy", task.execution_strategy, "purple")}`);
        this.print(
          `${keyValue(this.theme, "external hiring", task.allow_external ? "allowed" : "disabled", "purple")}`,
        );
        this.print(`${keyValue(this.theme, "DIY first", task.diy_first ? "yes" : "no", "purple")}`);
        this.print(
          `${keyValue(this.theme, "hire approval", task.require_hiring_approval ? "every hire" : "plan authority", "purple")}`,
        );
        this.print(`${keyValue(this.theme, "max parallel", String(task.max_parallel_jobs), "purple")}`);
        this.print(`${keyValue(this.theme, "deadline", task.deadline ?? "none", "purple")}`);
        this.print(`${keyValue(this.theme, "quality", clip(task.quality_requirements ?? "none", 60), "purple")}`);
        this.print(`${keyValue(this.theme, "project", projectLabel(task.track_id, task.project_scopes), "purple")}`);
        for (const [key, value] of Object.entries(task.track_inputs)) {
          this.print(`${keyValue(this.theme, `  ${key}`, clip(redact(value), 70), "grey")}`);
        }
      } catch {
        this.print(this.theme.dim("No active task."));
      }
      this.print("");
      this.print(
        this.theme.dim("Change with: settings set <key> <value>. Budget changes require `budget set` + approval."),
      );
      return;
    }
    if (args[0]?.toLowerCase() !== "set") {
      throw new AshError("VALIDATION_FAILED", "Usage: settings [set <key> <value>]");
    }
    const key = (args[1] ?? "").toLowerCase();
    const value = args.slice(2).join(" ").trim();
    const task = await this.activeTask();
    if (task.status === "executing")
      throw new AshError("CONFLICT", "Pause the task before changing execution preferences.");
    if (key === "budget")
      throw new AshError(
        "APPROVAL_REQUIRED",
        "Use `budget set <amount> <CUR>`; budget changes require explicit approval.",
      );
    await this.services.store.update(task.id, (current) => {
      if (current.status === "executing")
        throw new AshError("CONFLICT", "Pause the task before changing execution preferences.");
      switch (key) {
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
        case "execution_strategy":
        case "strategy":
          if (!["autonomous", "plan_then_approve", "diy_first"].includes(value)) {
            throw new AshError("VALIDATION_FAILED", "strategy must be autonomous, plan_then_approve or diy_first.");
          }
          if (current.plan) {
            throw new AshError("CONFLICT", "A plan already exists. Cancel or import a new plan to change strategy.");
          }
          current.execution_strategy = value as TaskRecord["execution_strategy"];
          break;
        case "allow_external":
          current.allow_external = parseBool(value);
          break;
        case "diy_first":
          current.diy_first = parseBool(value);
          break;
        case "deadline":
          if (!value || value.toLowerCase() === "none") current.deadline = null;
          else {
            const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.000Z` : new Date(value).toISOString();
            if (!Number.isFinite(Date.parse(iso)) || Date.parse(iso) <= Date.now())
              throw new AshError("VALIDATION_FAILED", "Deadline must be a future ISO timestamp.");
            current.deadline = iso;
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
      current.updated_at = new Date().toISOString();
    });
    this.print(this.theme.paint("green", `Updated ${key}.`));
  }

  private async cmdNotifyTest(): Promise<void> {
    const sent = await notify(`Test notification from Ash at ${new Date().toISOString()}.`, "info");
    if (sent) {
      this.print(this.theme.paint("green", "Telegram test message sent."));
      return;
    }
    this.print(
      this.theme.paint("amber", "No Telegram message was sent: notifications are not configured or delivery failed."),
    );
    this.print(
      this.theme.dim(
        "Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. See CONFIGURATION.md for the BotFather and chat-ID steps.",
      ),
    );
  }

  private async cmdExport(args: string[]): Promise<void> {
    const task = await this.activeTask();
    const destination = args.join(" ").trim() || undefined;
    const paths = await exportTaskReport(this.services.store, this.services.config, task, destination);
    this.print("");
    this.print(this.theme.paint("green", "Task report written."));
    this.print(`${this.theme.dim("Markdown")} ${paths.markdownPath}`);
    this.print(`${this.theme.dim("JSON")}     ${paths.jsonPath}`);
    this.print(`${this.theme.dim("Proof")}    ${paths.htmlPath}`);
    this.print(this.theme.dim("The report contains no credentials. It does contain task details and receipt hashes."));
    this.print("");
  }

  private async cmdTracks(args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase();
    if (action === "run") {
      await this.cmdTracksRun(args.slice(1));
      return;
    }
    if (action === "verify") {
      await this.cmdTracksVerify();
      return;
    }
    const id = args[0]?.toLowerCase();
    if (id && !isProjectId(id)) {
      const scope = getScope(id);
      if (!scope) {
        throw new AshError(
          "NOT_FOUND",
          `Unknown workstream "${id}". Run \`tracks\` for the six workstreams in the Ash project.`,
        );
      }
      const lines = [
        this.theme.paint("purple", scope.theme),
        "",
        scope.description,
        "",
        this.theme.paint("cyan", "BUILD ORDER"),
        ...scope.buildOrder.map((step, index) => `  ${index + 1}. ${step}`),
        "",
        this.theme.paint("amber", `APPROVAL GATE: ${scope.approvalGate ?? "standard policy"}`),
        "",
        this.theme.paint("cyan", "PROJECT INPUTS"),
        ...scope.requiredInputs.map(
          (spec) =>
            `  ${scope.id}.${spec.key} — ${spec.label}${spec.required ? " (required)" : " (optional)"}\n    ${spec.help}`,
        ),
        "",
        this.theme.paint("cyan", "CONSTRAINTS"),
        ...scope.constraints.map((constraint) => `  - ${constraint}`),
      ];
      this.print("");
      for (const line of panel(this.theme, `WORKSTREAM ${scope.name} (${scope.id})`, lines, {
        tone: "purple",
        shadow: true,
      })) {
        this.print(line);
      }
      this.print("");
      return;
    }

    this.print("");
    const summary = [
      this.theme.paint("purple", PROJECT.theme),
      "",
      PROJECT.description,
      "",
      this.theme.dim(`${SCOPES.length} workstreams · one transaction ledger · one budget per task`),
    ];
    for (const line of panel(this.theme, `PROJECT ${PROJECT.name} (${PROJECT.id})`, summary, {
      tone: "cyan",
      shadow: true,
    })) {
      this.print(line);
    }
    const rows = SCOPES.map((scope) => {
      const module = TRACK_MODULES[scope.id as keyof typeof TRACK_MODULES];
      return [scope.id, scope.name, scope.readiness, module?.step ?? "—", module?.provider ?? "—"];
    });
    this.print("");
    for (const line of table(this.theme, ["ID", "Workstream", "Local", "Step", "Live provider"], rows, {
      tones: ["cyan", "purple", "amber", "grey", "grey"],
    })) {
      this.print(line);
    }
    this.print(
      this.theme.dim(
        "All six steps run locally with labelled simulation. `tracks run all` runs the journey; `tracks verify` prints PASS/FAIL.",
      ),
    );
    this.print(
      this.theme.dim("`new` asks which workstreams a task covers; `tracks <id>` shows build order, inputs and gate."),
    );
    this.print("");
  }

  private async cmdTracksRun(args: string[]): Promise<void> {
    if (!this.services.config.simulation)
      throw new AshError("UNSAFE_OPERATION", "Track fixtures require demo mode. Run npm run demo.");
    const json = args.includes("--json");
    const target = (args.find((arg) => !arg.startsWith("-")) ?? "all").toLowerCase();
    if (target === "all") {
      const journey = runJourney();
      const file = await persistJourney(this.services.config.dataDir, journey);
      if (json) {
        this.print(JSON.stringify({ ...journey, evidence_path: file }, null, 2));
      } else {
        this.print("");
        this.print(this.theme.paint("purple", "SIX-TRACK JOURNEY · LOCAL SIMULATION"));
        this.print(this.theme.dim("No live NEAR contract, Intents quote, TEE call, treasury or wallet is used."));
        this.print("");
        const rows = journey.steps.map((step) => [
          step.track_id,
          step.status,
          `${step.checks.filter((check) => check.passed).length}/${step.checks.length}`,
          step.evidence_sha256?.slice(0, 12) ?? "—",
        ]);
        for (const line of table(this.theme, ["Track", "Status", "Checks", "Evidence"], rows, {
          tones: ["cyan", "white", "grey", "grey"],
        }))
          this.print(line);
        this.print("");
        this.print(
          journey.all_passed
            ? this.theme.paint(
                "green",
                `${journey.passed}/${journey.steps.length} PASS · end-to-end local journey complete`,
              )
            : this.theme.paint("red", `${journey.failed}/${journey.steps.length} FAIL · inspect the evidence file`),
        );
        this.print(this.theme.dim(`Evidence: ${file}`));
        this.print(this.theme.dim(`Journey SHA-256: ${journey.journey_sha256}`));
        this.print("");
      }
      if (!journey.all_passed) this.exitStatus = 1;
      return;
    }
    const run = runTrack(target);
    const file = await persistTrackRun(this.services.config.dataDir, run);
    if (json) {
      this.print(JSON.stringify({ ...run, evidence_path: file }, null, 2));
    } else {
      this.print("");
      this.print(this.theme.paint("purple", `TRACK ${run.track_id} · LOCAL SIMULATION`));
      this.print("");
      for (const line of panel(this.theme, run.title, [run.summary, "", this.theme.dim(run.integration.note)], {
        tone: "purple",
        shadow: true,
      }))
        this.print(line);
      this.print("");
      const rows = run.checks.map((check) => [check.passed ? "PASS" : "FAIL", check.id, check.detail]);
      for (const line of table(this.theme, ["Result", "Check", "Detail"], rows, {
        tones: ["white", "cyan", "grey"],
      }))
        this.print(line);
      this.print("");
      this.print(allChecksPass(run.checks) ? this.theme.paint("green", "PASS") : this.theme.paint("red", "FAIL"));
      this.print(this.theme.dim(`Evidence: ${file}`));
      this.print(this.theme.dim(`Evidence SHA-256: ${run.evidence_sha256}`));
      this.print("");
    }
    if (!allChecksPass(run.checks)) this.exitStatus = 1;
  }

  private async cmdTracksVerify(): Promise<void> {
    if (!this.services.config.simulation)
      throw new AshError("UNSAFE_OPERATION", "Track fixtures require demo mode. Run npm run demo.");
    const journey = runJourney();
    const file = await persistJourney(this.services.config.dataDir, journey);
    this.print("");
    this.print(this.theme.paint("purple", "TRACK VERIFY · LOCAL SIMULATION"));
    this.print(this.theme.dim("Six deterministic modules. No credentials, funds, contracts or network calls."));
    this.print("");
    for (const step of journey.steps) {
      const label = step.status === "PASS" ? this.theme.paint("green", "PASS") : this.theme.paint("red", "FAIL");
      const failed = step.checks.filter((check) => !check.passed);
      const detail =
        step.error ?? (failed.length ? failed.map((check) => check.id).join(", ") : `${step.checks.length} checks`);
      this.print(`  ${label}  ${step.track_id.padEnd(10)} ${detail}`);
    }
    this.print("");
    this.print(
      journey.all_passed
        ? this.theme.paint("green", `PASS · ${journey.passed}/${journey.steps.length} tracks`)
        : this.theme.paint("red", `FAIL · ${journey.failed}/${journey.steps.length} tracks`),
    );
    this.print(this.theme.dim(`Evidence: ${file}`));
    this.print("");
    if (!journey.all_passed) this.exitStatus = 1;
  }

  private async cmdTasks(): Promise<void> {
    const tasks = await this.services.store.list(50);
    const active = await this.services.store.getActive();
    this.print("");
    for (const line of renderTaskList(this.theme, tasks)) this.print(line);
    if (active) this.print(this.theme.dim(`Active: ${active}`));
    this.print("");
  }

  private async cmdSwitch(args: string[]): Promise<void> {
    if (args.length === 0) throw new AshError("VALIDATION_FAILED", "Usage: switch <task-id|latest>");
    if (this.services.engine.isRunning())
      throw new AshError("CONFLICT", "Pause and stop the current engine before switching tasks.");
    const task = await this.services.store.resolveRef(args[0] ?? "");
    await this.services.store.setActive(task.id);
    this.print(this.theme.paint("green", `Active task: ${task.id}`));
    await this.showStatus();
  }

  private async cmdMarket(): Promise<void> {
    if (!this.services.config.simulation && !this.services.config.market.apiToken) {
      this.print("");
      this.print(this.theme.paint("amber", "No marketplace credential is configured."));
      this.print(
        this.theme.dim(
          "Set MARKET_API_TOKEN (or MARKET_API_TOKEN_FILE) to the bearer token from the market's OAuth consent flow.",
        ),
      );
      this.print(this.theme.dim("Marketplace: " + this.services.config.market.mcpUrl));
      this.print("");
      return;
    }
    const connection = await attemptMarketConnection(this.services);
    if (!connection.connected) {
      this.print("");
      this.print(this.theme.paint("red", connection.error ?? "Marketplace unavailable."));
      this.print(this.theme.dim("Ash can still plan offline. Hiring will not be attempted without a connection."));
      this.print("");
      return;
    }
    const info = await this.services.market.connect();
    const capabilities = this.services.market.capabilities();
    const who = await this.services.market.whoami().catch(() => null);
    const lines = [
      keyValue(this.theme, "Endpoint", info.endpoint, "cyan"),
      keyValue(
        this.theme,
        "Mode",
        this.services.config.simulation ? "SIMULATION (no real funds)" : `LIVE · ${this.services.config.market.mode}`,
        this.services.config.simulation ? "magenta" : "green",
      ),
      keyValue(this.theme, "Server", info.server_version ?? "unknown", "white"),
      keyValue(this.theme, "Buyer tools", String(capabilities.tools.length), "white"),
      keyValue(
        this.theme,
        "Hiring",
        capabilities.can_prepare_job || capabilities.can_create_job || capabilities.can_board
          ? "available"
          : "unavailable",
        capabilities.buyer ? "green" : "amber",
      ),
      keyValue(this.theme, "Acceptance", capabilities.can_accept ? "market page" : "job page only", "cyan"),
      keyValue(this.theme, "Human account", who?.user_handle ?? "unknown", "purple"),
      keyValue(
        this.theme,
        "Email verified",
        who?.email_verified === null || who?.email_verified === undefined
          ? "unknown"
          : who.email_verified
            ? "yes"
            : "NO",
        who?.email_verified ? "green" : "amber",
      ),
    ];
    if (who?.account) {
      for (const currency of ["USD", "USDC"] as const) {
        const balance = who.account.balances[currency];
        if (balance)
          lines.push(keyValue(this.theme, `${currency} balance`, `${balance} (account, not budget)`, "cyan"));
      }
      if (who.account.credit_usd) lines.push(keyValue(this.theme, "credit_usd", who.account.credit_usd, "cyan"));
    }
    if (info.note) lines.push("", this.theme.dim(info.note));
    this.print("");
    for (const line of panel(this.theme, "MARKETPLACE CONNECTION", lines, { tone: "cyan", shadow: true }))
      this.print(line);
    this.print("");
    this.print(this.theme.paint("purple", `TOOLS  ${capabilities.tools.join(" · ")}`));
    this.print("");
  }

  private async cmdAgents(args: string[]): Promise<void> {
    const connection = await attemptMarketConnection(this.services);
    if (!connection.connected) throw new AshError("MARKET_UNAVAILABLE", connection.error ?? "Marketplace unavailable.");
    const query = args.join(" ").trim();
    if (!query) throw new AshError("VALIDATION_FAILED", "Usage: agents <skill or agent query>");
    const agents = await this.services.market.browseAgents({ query, limit: 20 });
    if (agents.length === 0) {
      this.print(this.theme.dim("No agents matched that query."));
      return;
    }
    const rows = agents.map((agent) => [
      clip(agent.name, 24),
      agent.handle ?? "—",
      agent.price ? `${agent.price} ${agent.currency}` : "no live price",
      agent.payable_with?.join("/") ?? "—",
      agent.success_rate === null ? "unrated" : `${agent.success_rate}%`,
      String(agent.delivered_jobs),
      agent.runtime ?? "—",
    ]);
    this.print("");
    for (const line of table(this.theme, ["Agent", "Handle", "Price", "Rails", "Success", "Jobs", "Runtime"], rows, {
      tones: ["cyan", "purple", "green", "white", "green", "grey", "grey"],
    }))
      this.print(line);
    if (this.services.config.simulation)
      this.print(
        this.theme.paint(
          "magenta",
          "SIMULATION CATALOG — these agents are local fakes and cannot be hired for real work.",
        ),
      );
    this.print(
      this.theme.dim(
        "Ash checks price, payable rail, budget, market balance, reputation and suspicious claims before hiring.",
      ),
    );
    this.print("");
  }

  private async cmdJobs(): Promise<void> {
    const task = await this.activeTask();
    const rows: string[][] = [];
    for (const state of task.subtasks) {
      const attempt = state.attempts[state.active_attempt - 1] ?? state.attempts[state.attempts.length - 1];
      if (!attempt || (attempt.kind === "DIY" && !attempt.job_id)) continue;
      rows.push([
        state.id,
        state.phase,
        clip(attempt.vendor?.name ?? "—", 22),
        attempt.job_id ?? "—",
        attempt.agreed_price ? `${attempt.agreed_price} ${attempt.currency}` : "—",
        attempt.payment_status ?? "—",
        clip(attempt.market_state ?? "—", 28),
      ]);
    }
    this.print("");
    if (rows.length === 0) this.print(this.theme.dim("No external jobs for this task yet."));
    else
      for (const line of table(
        this.theme,
        ["Subtask", "Phase", "Vendor", "Job", "Agreed", "Payment", "Market state"],
        rows,
        { tones: ["cyan", "green", "purple", "grey", "white", "amber", "grey"] },
      ))
        this.print(line);

    if (this.services.config.market.apiToken || this.services.config.simulation) {
      try {
        const connection = await attemptMarketConnection(this.services, 6_000);
        if (connection.connected) {
          const jobs = await this.services.market.listMyJobs(20);
          if (jobs.length > 0) {
            this.print("");
            this.print(this.theme.paint("cyan", "MARKETPLACE JOBS (account-wide)"));
            const marketRows = jobs.map((job) => [
              job.job_id,
              clip(job.title ?? "—", 36),
              job.status ?? "—",
              job.amount ? `${job.amount} ${job.currency ?? ""}` : "—",
              job.assignment_status ?? "—",
              clip(job.worker ?? "—", 20),
            ]);
            for (const line of table(
              this.theme,
              ["Job", "Title", "Status", "Amount", "Assignment", "Worker"],
              marketRows,
              { tones: ["grey", "white", "green", "cyan", "purple", "grey"] },
            ))
              this.print(line);
          }
        }
      } catch (error) {
        this.print(this.theme.paint("amber", `Marketplace jobs unavailable: ${errorMessage(error)}`));
      }
    }
    this.print("");
  }
}

async function readStdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > 1024 * 1024) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}
