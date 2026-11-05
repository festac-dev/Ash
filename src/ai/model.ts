import { AshError } from "../errors.js";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { redact } from "../util/redact.js";
import { withRetries } from "../util/async.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface ModelUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ModelResponse {
  text: string;
  usage: ModelUsage;
  finishReason: string | null;
}

export interface ModelAdapter {
  readonly id: string;
  readonly modelName: string;
  readonly available: boolean;
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<ModelResponse>;
}

export class UnavailableModel implements ModelAdapter {
  readonly id = "unavailable";
  readonly modelName = "none";
  readonly available = false;
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  async complete(): Promise<ModelResponse> {
    throw new AshError("MODEL_UNAVAILABLE", this.reason, {
      hint: "Set ASH_MODEL_PROVIDER, ASH_MODEL_NAME, ASH_MODEL_BASE_URL and ASH_MODEL_API_KEY, or run npm run demo for an offline simulation.",
    });
  }
}

export class OpenAICompatibleModel implements ModelAdapter {
  readonly id = "openai-compatible";
  readonly modelName: string;
  readonly available = true;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly jsonMode: boolean;
  private readonly maxRetries: number;

  constructor(config: AppConfig) {
    if (!config.model.baseUrl || !config.model.name) {
      throw new AshError("CONFIG_INVALID", "Model provider is missing a base URL or model name.");
    }
    this.baseUrl = config.model.baseUrl.replace(/\/+$/, "");
    this.modelName = config.model.name;
    this.apiKey = config.model.apiKey;
    this.timeoutMs = config.model.timeoutMs;
    this.jsonMode = config.model.jsonMode;
    this.maxRetries = config.policy.maxRetries;
  }

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<ModelResponse> {
    const wantJson = options.json ?? false;
    const attempt = async (jsonMode: boolean): Promise<ModelResponse> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.modelName,
            messages,
            temperature: options.temperature ?? 0.2,
            max_tokens: options.maxTokens ?? 4_000,
            ...(wantJson && jsonMode ? { response_format: { type: "json_object" } } : {}),
          }),
        });
        if (!response.ok) {
          const body = redact(await readModelBody(response, 1_000, true));
          const retryable =
            response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
          throw new AshError("MODEL_UNAVAILABLE", `Model provider returned HTTP ${response.status}: ${body}`, {
            retryable,
            details: { status: response.status },
          });
        }
        const data = JSON.parse(await readModelBody(response, 8 * 1024 * 1024)) as {
          choices?: Array<{
            message?: { content?: string | Array<{ type?: string; text?: string }> };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const choice = data.choices?.[0];
        const rawContent = choice?.message?.content;
        const text = Array.isArray(rawContent)
          ? rawContent.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("")
          : (rawContent ?? "");
        if (!text.trim()) {
          throw new AshError("MODEL_RESPONSE_INVALID", "The model returned an empty response.", { retryable: true });
        }
        return {
          text,
          usage: {
            promptTokens: data.usage?.prompt_tokens ?? null,
            completionTokens: data.usage?.completion_tokens ?? null,
          },
          finishReason: choice?.finish_reason ?? null,
        };
      } catch (error) {
        if (error instanceof AshError) throw error;
        if ((error as Error).name === "AbortError") {
          throw new AshError("MODEL_UNAVAILABLE", "The model request timed out.", { retryable: true, cause: error });
        }
        throw new AshError("MODEL_UNAVAILABLE", "Could not reach the model provider.", {
          retryable: true,
          cause: error,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      return await withRetries(() => attempt(this.jsonMode), {
        attempts: Math.max(1, Math.min(this.maxRetries, 3)),
        retryable: (error) => error instanceof AshError && error.retryable,
        onRetry: (error, attemptNumber, delay) => {
          logger.warn("Model request failed; retrying", {
            attempt: attemptNumber,
            delay_ms: delay,
            error: redact(error instanceof Error ? error.message : String(error)),
          });
        },
      });
    } catch (error) {
      // Some OpenAI-compatible servers reject response_format. Retry once
      // without it rather than failing a valid provider.
      if (
        wantJson &&
        error instanceof AshError &&
        (error.details.status === 400 || error.details.status === 422) &&
        /response_format|json/i.test(error.message)
      ) {
        logger.warn("Provider rejected JSON mode; retrying without response_format");
        return withRetries(() => attempt(false), {
          attempts: Math.max(1, Math.min(this.maxRetries, 2)),
          retryable: (inner) => inner instanceof AshError && inner.retryable,
        });
      }
      throw error;
    }
  }
}

async function readModelBody(response: Response, limit: number, preview = false): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > limit) {
        await reader.cancel();
        if (!preview) throw new AshError("MODEL_RESPONSE_INVALID", "Model response exceeds the 8 MiB safety limit.");
        chunks.push(value.subarray(0, limit - total));
        break;
      }
      total += value.byteLength;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

export function createModel(config: AppConfig): ModelAdapter {
  switch (config.model.provider) {
    case "openai-compatible":
    case "ollama":
      return new OpenAICompatibleModel(config);
    case "demo":
      if (!config.simulation) {
        return new UnavailableModel("The demo model is only available in simulation mode.");
      }
      return new DemoModel();
    case "none":
      return new UnavailableModel("No AI model is configured, so Ash cannot plan or verify work autonomously.");
  }
}

const ASH_CONTEXT_PATTERN = /<ash_context>\s*([^<]*?)\s*<\/ash_context>\s*$/;

export function readAshContext(messages: ChatMessage[]): Record<string, unknown> | null {
  for (const message of [...messages].reverse()) {
    const match = ASH_CONTEXT_PATTERN.exec(message.content);
    if (!match?.[1]) continue;
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Deterministic, clearly-labelled model used only in simulation mode. It
 * reads the structured context the planner/worker/verifier already has, so
 * simulation never pretends to be a real LLM.
 */
export class DemoModel implements ModelAdapter {
  readonly id = "demo";
  readonly modelName = "ash-simulation-planner";
  readonly available = true;

  async complete(messages: ChatMessage[]): Promise<ModelResponse> {
    const context = readAshContext(messages);
    const mode = typeof context?.mode === "string" ? context.mode : "unknown";
    if (mode === "chat")
      return {
        text: demoChat(context ?? {}, messages),
        usage: { promptTokens: null, completionTokens: null },
        finishReason: "stop",
      };
    if (mode === "plan")
      return {
        text: demoPlan(context ?? {}),
        usage: { promptTokens: null, completionTokens: null },
        finishReason: "stop",
      };
    if (mode === "diy")
      return {
        text: demoDiy(context ?? {}),
        usage: { promptTokens: null, completionTokens: null },
        finishReason: "stop",
      };
    if (mode === "verify")
      return {
        text: demoVerify(context ?? {}),
        usage: { promptTokens: null, completionTokens: null },
        finishReason: "stop",
      };
    throw new AshError("MODEL_RESPONSE_INVALID", "Simulation model received an unknown request.");
  }
}

function demoPlan(context: Record<string, unknown>): string {
  const task = (context.task ?? {}) as Record<string, unknown>;
  const description = String(task.description ?? "Complete the requested work");
  const currency = String(task.currency ?? "USDC");
  const budget = String(task.budget ?? "10.00");
  const externalPool = String(context.external_pool ?? budget);
  const project = (task.project ?? null) as Record<string, unknown> | null;
  const projectName = project && typeof project.name === "string" ? project.name : null;
  const workstreams =
    project && Array.isArray(project.workstreams) ? (project.workstreams as Array<Record<string, unknown>>) : [];
  const gates = workstreams
    .filter((workstream) => typeof workstream.approval_gate === "string" && workstream.approval_gate.trim())
    .map((workstream) => ({
      id: typeof workstream.id === "string" ? workstream.id : "workstream",
      gate: String(workstream.approval_gate),
    }));
  const lower = description.toLowerCase();
  const software = /\b(website|web app|application|software|saas|dashboard|api|authentication|payment|tests?)\b/.test(
    lower,
  );
  const research = /\b(research|report|analysis|market|study)\b/.test(lower);
  const design = /\b(design|brand|logo|visual|ui|ux)\b/.test(lower);
  const data = /\b(data|dataset|etl|pipeline|scrape|csv)\b/.test(lower);

  const external: Array<{ title: string; skills: string[]; deliverable: string }> = [];
  const diy: Array<{ title: string; deliverable: string }> = [];
  if (software) {
    diy.push({ title: "Architecture and scope", deliverable: "Architecture notes and implementation scope" });
    external.push({
      title: "UI/UX design",
      skills: ["ui design", "ux", "design"],
      deliverable: "A design specification and component guidance",
    });
    diy.push({ title: "Backend implementation", deliverable: "Backend source and implementation notes" });
    diy.push({ title: "Database design", deliverable: "Schema and data model documentation" });
    external.push({
      title: "Security review",
      skills: ["security", "code review"],
      deliverable: "Security findings and remediation guidance",
    });
    external.push({
      title: "Automated test suite",
      skills: ["testing", "qa", "automation"],
      deliverable: "Automated tests and a test report",
    });
    diy.push({ title: "Final integration", deliverable: "Integrated implementation and handover notes" });
  } else if (research) {
    diy.push({ title: "Research plan", deliverable: "Research questions and source criteria" });
    external.push({
      title: "Primary research",
      skills: ["research", "analysis"],
      deliverable: "Sourced research findings",
    });
    diy.push({ title: "Synthesis", deliverable: "Synthesized report and conclusions" });
    external.push({
      title: "Independent fact review",
      skills: ["review", "fact checking"],
      deliverable: "Verification notes on key claims",
    });
  } else if (design) {
    diy.push({ title: "Creative brief", deliverable: "Brief, constraints and acceptance checklist" });
    external.push({
      title: "Visual design",
      skills: ["design", "branding"],
      deliverable: "Design deliverables in the requested formats",
    });
    diy.push({ title: "Design QA", deliverable: "QA notes against the brief" });
    external.push({
      title: "Accessibility review",
      skills: ["accessibility", "design review"],
      deliverable: "Accessibility findings",
    });
  } else if (data) {
    diy.push({ title: "Data requirements", deliverable: "Schema, quality rules and scope" });
    external.push({
      title: "Data collection",
      skills: ["data", "scraping"],
      deliverable: "Dataset in the requested format",
    });
    diy.push({ title: "Analysis", deliverable: "Analysis notes and summary" });
    external.push({
      title: "Data validation",
      skills: ["data quality", "validation"],
      deliverable: "Completeness and validity report",
    });
  } else {
    diy.push({ title: "Scope and plan", deliverable: "Scope, assumptions and acceptance checklist" });
    external.push({
      title: "Specialist delivery",
      skills: ["delivery"],
      deliverable: "The requested specialist output",
    });
    diy.push({ title: "Integration and handover", deliverable: "Integrated result and handover notes" });
    external.push({
      title: "Independent quality review",
      skills: ["review", "quality"],
      deliverable: "Review findings against acceptance criteria",
    });
  }

  const externalTotal = parseMinor(externalPool, currency);
  // A simulation must honor the same hiring preference and smallest-unit budget.
  if (task.allow_external === false || externalTotal < BigInt(external.length)) {
    diy.splice(
      1,
      0,
      ...external.map((item) => ({
        title: item.title,
        deliverable: `Local planning notes for ${item.deliverable}; specialist execution is unavailable`,
      })),
    );
    external.length = 0;
  }
  const shares =
    external.length === 1
      ? [1]
      : external.map((_, index) => (index === 0 ? 0.45 : index === 1 ? 0.3 : 0.25 / Math.max(1, external.length - 2)));
  const allocations: bigint[] = [];
  let allocated = 0n;
  external.forEach((_, index) => {
    if (index === external.length - 1) {
      allocations.push(externalTotal - allocated > 0n ? externalTotal - allocated : 1n);
    } else {
      const share = BigInt(Math.round((shares[index] ?? 0) * 1_000_000));
      const amount = (externalTotal * share) / 1_000_000n;
      allocations.push(amount > 0n ? amount : 1n);
      allocated += amount > 0n ? amount : 1n;
    }
  });

  const subtasks: Array<Record<string, unknown>> = [];
  let id = 0;
  const nextId = (): string => `st_${++id}`;
  const keywords = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4)
    .slice(0, 3);
  const designIds: string[] = [];

  const architectureId = nextId();
  const architecture = diy[0]!;
  subtasks.push({
    id: architectureId,
    title: architecture.title,
    description: `Define scope, constraints and an implementation approach for: ${description}`,
    execution: "DIY",
    dependencies: [],
    complexity: "medium",
    skills: ["planning", "architecture"],
    deliverable: architecture.deliverable,
    acceptance_criteria: [
      ...demoCriteria(architecture.deliverable, keywords, false),
      ...gates.map((entry) => ({
        kind: "human_approval",
        description: `Workstream approval gate [${entry.id}]: ${entry.gate}`,
      })),
    ],
    planned_max: "0.00",
    estimated_cost: "0.00",
    rationale: "Ash can produce this planning artifact directly and safely.",
  });

  external.forEach((item, index) => {
    const subtaskId = nextId();
    const deps = index === 0 ? [architectureId] : [architectureId, ...designIds.slice(0, 1)];
    subtasks.push({
      id: subtaskId,
      title: item.title,
      description: `${item.title} for the task: ${description}. Deliver ${item.deliverable} with enough detail to verify against the acceptance criteria.`,
      execution: "EXTERNAL",
      dependencies: deps.filter((dep) => dep !== subtaskId),
      complexity: index === 0 ? "high" : "medium",
      skills: item.skills,
      deliverable: item.deliverable,
      acceptance_criteria: demoCriteria(item.deliverable, keywords, true),
      planned_max: minorToDecimal(allocations[index] ?? 1n, currency),
      estimated_cost: minorToDecimal(((allocations[index] ?? 1n) * 80n) / 100n, currency),
      rationale: "Requires specialist work or independent verification that Ash cannot perform reliably itself.",
    });
    designIds.push(subtaskId);
  });

  const diyMid = diy.slice(1, -1);
  for (const item of diyMid) {
    subtasks.push({
      id: nextId(),
      title: item.title,
      description: `${item.title} for: ${description}. Produce ${item.deliverable}.`,
      execution: "DIY",
      dependencies: [architectureId],
      complexity: "medium",
      skills: ["implementation", "documentation"],
      deliverable: item.deliverable,
      acceptance_criteria: demoCriteria(item.deliverable, keywords, false),
      planned_max: "0.00",
      estimated_cost: "0.00",
      rationale: "Ash can produce this artifact locally; no external spend is needed.",
    });
  }

  const lastDiy = diy[diy.length - 1]!;
  subtasks.push({
    id: nextId(),
    title: lastDiy.title,
    description: `${lastDiy.title}: consolidate every deliverable for "${description}" and document what was actually produced.`,
    execution: "DIY",
    dependencies: subtasks.map((item) => String(item.id)),
    complexity: "high",
    skills: ["integration", "documentation"],
    deliverable: lastDiy.deliverable,
    acceptance_criteria: demoCriteria(lastDiy.deliverable, keywords, false),
    planned_max: "0.00",
    estimated_cost: "0.00",
    rationale: "Ash consolidates and documents the work without claiming external execution.",
  });

  const reserve = parseMinor(String(context.contingency ?? "0.00"), currency);
  return JSON.stringify({
    summary: `A dependency-ordered plan for: ${description}`,
    final_outcome: `The requested outcome is delivered and each deliverable is checked against explicit acceptance criteria.`,
    assumptions: [
      "Simulation mode: no real marketplace calls or funds are involved.",
      ...(projectName
        ? [
            `Project ${projectName} is active with ${workstreams.length || 1} workstream(s); their build orders${gates.length > 0 ? " and approval gates" : ""} must be honored.`,
          ]
        : []),
    ],
    risks: ["External deliverables need a real marketplace and human approval in live mode."],
    contingency: minorToDecimal(reserve, currency),
    subtasks,
  });
}

function demoCriteria(deliverable: string, keywords: string[], external: boolean): Array<Record<string, unknown>> {
  const criteria: Array<Record<string, unknown>> = [
    {
      kind: "deliverable_present",
      description: "Deliverable text is present and substantive.",
      min_chars: external ? 120 : 180,
    },
    {
      kind: "contains",
      description: "Deliverable addresses the requested scope.",
      all: keywords.length > 0 ? keywords : ["deliverable"],
    },
  ];
  criteria.push({
    kind: "llm_review",
    description: "Deliverable meets the brief and is internally consistent.",
    rubric: `Check that the deliverable addresses: ${deliverable}. Fail if it is generic, empty, or contradicts the brief.`,
  });
  return criteria;
}

function demoDiy(context: Record<string, unknown>): string {
  const subtask = (context.subtask ?? {}) as Record<string, unknown>;
  const task = (context.task ?? {}) as Record<string, unknown>;
  const title = String(subtask.title ?? "Deliverable");
  const description = String(subtask.description ?? "");
  const taskDescription = String(task.description ?? "");
  const criteria = Array.isArray(subtask.acceptance_criteria) ? subtask.acceptance_criteria : [];
  const keywords = criteria
    .filter((criterion) => criterion && (criterion as Record<string, unknown>).kind === "contains")
    .flatMap((criterion) => ((criterion as Record<string, unknown>).all as unknown[]) ?? [])
    .map(String);
  const body = [
    `# ${title}`,
    "",
    "> SIMULATION MODE: this artifact was generated by Ash's deterministic demo model.",
    "",
    "## Objective",
    "",
    description || taskDescription,
    "",
    "## Context",
    "",
    `Task: ${taskDescription}`,
    "",
    "## Deliverable",
    "",
    `This document is the ${title.toLowerCase()} deliverable. It captures the agreed scope, decisions and handover notes.`,
    "",
    `Scope words: ${keywords.join(", ")}`,
    "",
    "## Checklist",
    "",
    "- [x] Scope is explicit",
    "- [x] Assumptions are recorded",
    "- [x] Handover notes are included",
    "",
    "## Implementation notes",
    "",
    "1. Confirm the acceptance criteria before consuming this artifact.",
    "2. Integration steps are documented for the dependent subtasks.",
    "3. No external work is claimed by this local artifact.",
    "",
  ].join("\n");
  return JSON.stringify({
    summary: `${title} completed as a local simulation artifact.`,
    files: [{ path: "deliverable.md", content: body }],
  });
}

function demoVerify(context: Record<string, unknown>): string {
  const text = String(context.delivery_text ?? "");
  const criteria = Array.isArray(context.criteria) ? context.criteria : [];
  const results = criteria
    .filter((criterion) => criterion && (criterion as Record<string, unknown>).kind === "llm_review")
    .map((criterion) => {
      const record = criterion as Record<string, unknown>;
      const passed = text.trim().length >= 100;
      return {
        criterion: String(record.description ?? "LLM review"),
        passed,
        details: passed
          ? "The deliverable is present and addresses the brief."
          : "The deliverable is too short to assess.",
      };
    });
  return JSON.stringify({
    passed: results.every((result) => result.passed),
    results,
    summary: results.every((result) => result.passed)
      ? "All model-assessed criteria passed."
      : "The deliverable needs revision.",
  });
}

function parseMinor(value: string, _currency: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  const scale = 6;
  const padded = fraction.padEnd(scale, "0").slice(0, scale);
  return BigInt(whole || "0") * 10n ** BigInt(scale) + BigInt(padded || "0");
}

function minorToDecimal(value: bigint, _currency: string): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function demoChat(context: Record<string, unknown>, messages: ChatMessage[]): string {
  const question =
    [...messages]
      .reverse()
      .find((m) => m.role === "user")
      ?.content.toLowerCase() ?? "";
  const task = context.task as {
    description?: string;
    status?: string;
    status_detail?: string;
    subtasks?: Array<{ id: string; phase: string }>;
  } | null;
  const ledger = context.ledger as
    { committed?: string; paid?: string; available?: string; currency?: string } | undefined;
  const label = "[Demo reply — simulated model]\n\n";
  if (/money|budget|spen[dt]|paid|escrow/.test(question) && ledger) {
    return (
      label +
      `${ledger.available} available (${ledger.currency}). ${ledger.committed} in escrow; ${ledger.paid} paid. These amounts are simulated. Money has the full ledger.`
    );
  }
  if (/status|waiting|progress|happen|blocked|why/.test(question) && task) {
    const steps = task.subtasks ?? [];
    const completed = steps.filter((step) => step.phase === "completed").length;
    return (
      label +
      `Status: ${task.status?.replaceAll("_", " ") ?? "unknown"}. ${completed} of ${steps.length} steps complete.${task.status_detail ? `\n${task.status_detail}` : ""}\n\nExecution has the details.`
    );
  }
  if (/replay/.test(question))
    return label + "Replay shows recorded approvals, funding and verification. It never repeats jobs or payments.";
  return (
    label +
    "What result do you want? We can shape a brief, then use New task to set a budget and review a plan. Chat alone does not execute work."
  );
}
