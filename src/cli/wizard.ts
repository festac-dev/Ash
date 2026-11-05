export interface Questioner {
  question(question: string): Promise<string>;
}
import type { AppConfig } from "../config.js";
import type { ExecutionStrategy, TaskInput, TaskRecord } from "../domain/types.js";
import { TaskInputSchema } from "../domain/schemas.js";
import { PROJECT, SCOPES, getScope, scopeInputKey, validateProjectInputs, type ProjectScope } from "../tracks.js";
import { TaskStore } from "../state/store.js";
import { parseAmount, CURRENCIES, type Currency } from "../util/money.js";
import { clip } from "../util/strings.js";
import type { Theme } from "./theme.js";
import { panel } from "./components.js";

export async function runNewTaskWizard(options: {
  rl: Questioner;
  theme: Theme;
  store: TaskStore;
  config: AppConfig;
  prefillDescription?: string;
}): Promise<TaskRecord | null> {
  const { rl, theme, store, config } = options;
  const lines = [
    theme.paint("cyan", "NEW TASK SESSION"),
    "Ash collects only what this task needs. Every task gets its own budget ledger.",
    theme.dim("Press Enter to accept a default or skip an optional field."),
  ];
  process.stdout.write(`\n${panel(theme, "NEW TASK", lines, { tone: "purple", shadow: true }).join("\n")}\n\n`);

  let description = options.prefillDescription?.trim() ?? "";
  let descriptionTries = 0;
  while (description.length < 3) {
    descriptionTries += 1;
    if (descriptionTries > 3) {
      process.stdout.write(theme.paint("red", "No task description was provided. Nothing was created.\n"));
      return null;
    }
    description = (await ask(rl, theme, "What would you like me to accomplish?")).trim();
    if (description.length < 3)
      process.stdout.write(theme.paint("amber", "Please describe the task in at least a few words.\n"));
  }

  const selectedScopes = await askProjectScopes(rl, theme);
  if (selectedScopes === null) return null;
  const trackInputs: Record<string, string> = {};
  if (selectedScopes.length > 0) {
    const intro = [
      theme.paint("purple", `${PROJECT.name} — ${PROJECT.theme}`),
      theme.dim(PROJECT.description),
      "",
      `${theme.paint("cyan", "WORKSTREAMS IN SCOPE")} ${selectedScopes.map((scope) => `${scope.name} (${scope.id})`).join(", ")}`,
      ...selectedScopes.map((scope) =>
        theme.paint("amber", `Gate [${scope.id}]: ${scope.approvalGate ?? "standard policy"}`),
      ),
      "",
      theme.dim("Ash asks for every project value this task needs; it never invents accounts, limits or routes."),
    ];
    process.stdout.write(`\n${panel(theme, "PROJECT SCOPE", intro, { tone: "purple", shadow: true }).join("\n")}\n\n`);
    for (const scope of selectedScopes) {
      process.stdout.write(
        `\n${theme.paint("cyan", `${scope.name} (${scope.id})`)} ${theme.dim(`— ${scope.theme}`)}\n`,
      );
      for (const spec of scope.requiredInputs) {
        const key = scopeInputKey(scope, spec.key);
        let value = "";
        if (spec.required) {
          let tries = 0;
          while (!value) {
            tries += 1;
            if (tries > 3) {
              process.stdout.write(
                theme.paint("red", `No value for ${scope.name} · ${spec.label}; task creation aborted.\n`),
              );
              return null;
            }
            value = (await ask(rl, theme, `${scope.name} · ${spec.label}:`)).trim();
            if (!value) {
              process.stdout.write(
                theme.paint("amber", `${spec.help} A value is required; do not make Ash invent it.\n`),
              );
            }
          }
        } else {
          value = (await ask(rl, theme, `${scope.name} · ${spec.label} (optional):`)).trim();
        }
        trackInputs[key] = value;
        process.stdout.write(theme.dim(`  ${spec.help}\n`));
      }
    }
    const missing = validateProjectInputs(selectedScopes, trackInputs);
    if (missing.length > 0) {
      process.stdout.write(theme.paint("red", `Missing or invalid project inputs: ${missing.join(", ")}\n`));
      return null;
    }
  }

  let budget: { amount: string; currency: Currency } | null = null;
  let budgetTries = 0;
  while (!budget) {
    budgetTries += 1;
    if (budgetTries > 3) {
      process.stdout.write(theme.paint("red", "No valid budget was provided. Nothing was created.\n"));
      return null;
    }
    const raw = (await ask(rl, theme, "Maximum total budget (required, e.g. 150 USDC or $150):")).trim();
    if (!raw) {
      process.stdout.write(theme.paint("amber", "A maximum budget is required. Ash will not invent one.\n"));
      continue;
    }
    budget = parseBudget(raw);
    if (!budget)
      process.stdout.write(
        theme.paint("amber", "Use a positive amount with an explicit currency, for example 150 USDC or $150.\n"),
      );
  }

  const deadline = await askDeadline(rl, theme);
  const quality = optional(await ask(rl, theme, "Quality requirements (optional):"));
  const preferred = optional(await ask(rl, theme, "Preferred agents, comma-separated (optional):"));
  const strategy = await askStrategy(rl, theme);
  const allowExternal = await askBool(rl, theme, "May Ash hire external marketplace agents?", true);
  const diyFirst = await askBool(rl, theme, "Should Ash attempt local DIY work before hiring?", true);
  const requireApproval = await askBool(rl, theme, "Require explicit approval before every hire?", true);
  const maxParallelRaw = (
    await ask(
      rl,
      theme,
      `Maximum parallel jobs (1-${config.policy.maxParallelJobs}, default ${config.policy.maxParallelJobs}):`,
    )
  ).trim();
  let maxParallel: number | null = null;
  if (maxParallelRaw) {
    const parsed = Number(maxParallelRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > config.policy.maxParallelJobs) {
      process.stdout.write(
        theme.paint(
          "amber",
          `Invalid parallelism; using the installation limit of ${config.policy.maxParallelJobs}.\n`,
        ),
      );
    } else {
      maxParallel = parsed;
    }
  }
  const additional = optional(await ask(rl, theme, "Additional instructions (optional, not published to the market):"));

  const raw: TaskInput = {
    description,
    budget: budget.amount,
    currency: budget.currency,
    deadline,
    quality_requirements: quality,
    preferred_agents: preferred
      ? preferred
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 10)
      : [],
    execution_strategy: strategy,
    allow_external: allowExternal,
    diy_first: diyFirst,
    require_hiring_approval: requireApproval,
    max_parallel_jobs: maxParallel,
    additional_instructions: additional,
    track_id: selectedScopes.length > 0 ? PROJECT.id : null,
    project_scopes: selectedScopes.map((scope) => scope.id),
    track_inputs: trackInputs,
  };

  let input: TaskInput;
  try {
    input = TaskInputSchema.parse(raw) as TaskInput;
    parseAmount(input.budget, input.currency);
    if (input.deadline && Date.parse(input.deadline) <= Date.now()) throw new Error("deadline in the past");
  } catch (error) {
    process.stdout.write(
      theme.paint("red", `Invalid setup: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return null;
  }

  const summary = [
    `${theme.dim("TASK")}      ${clip(input.description, theme.width - 16)}`,
    `${theme.dim("PROJECT")}   ${selectedScopes.length > 0 ? `${PROJECT.name} · ${selectedScopes.map((scope) => scope.name).join(", ")}` : "custom"}`,
    `${theme.dim("BUDGET")}    ${input.budget} ${input.currency}`,
    `${theme.dim("STRATEGY")}  ${input.execution_strategy}`,
    `${theme.dim("DEADLINE")}  ${input.deadline ?? "none"}`,
    `${theme.dim("EXTERNAL")}  ${input.allow_external ? "allowed" : "disabled"}`,
    `${theme.dim("APPROVAL")}  ${input.require_hiring_approval ? "every hire" : "plan authority"}`,
    `${theme.dim("PARALLEL")}  ${input.max_parallel_jobs ?? config.policy.maxParallelJobs}`,
  ];
  process.stdout.write(`\n${panel(theme, "CONFIRM TASK", summary, { tone: "cyan" }).join("\n")}\n`);
  const proceed = await askBool(rl, theme, "Create this task?", true);
  if (!proceed) {
    process.stdout.write(theme.dim("Task creation cancelled. Nothing was written.\n"));
    return null;
  }
  const task = await store.create(input);
  process.stdout.write(
    `\n${theme.paint("green", "Task created:")} ${theme.bold(task.id)}\n${theme.dim("Next: `plan` builds the execution plan, then `approve`/`execute`.")}\n\n`,
  );
  return task;
}

async function askProjectScopes(rl: Questioner, theme: Theme): Promise<ProjectScope[] | null> {
  const raw = (
    await ask(
      rl,
      theme,
      `Workstreams for this task (${SCOPES.map((scope) => scope.id).join(",")}, all, or custom; default all six, which asks for ${PROJECT.scopes.reduce((count, scope) => count + scope.requiredInputs.length, 0)} project values):`,
    )
  )
    .trim()
    .toLowerCase();
  if (!raw || raw === "all") return SCOPES;
  if (["none", "custom", "skip"].includes(raw)) return [];
  const ids = [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
  const unknown = ids.filter((id) => !getScope(id));
  if (unknown.length > 0) {
    process.stdout.write(
      theme.paint("red", `Unknown workstream(s): ${unknown.join(", ")}. Run \`tracks\` for the six workstreams.\n`),
    );
    return null;
  }
  return ids.map((id) => getScope(id)!);
}

export function parseBudget(raw: string): { amount: string; currency: Currency } | null {
  const text = raw.trim();
  const match = /^\$?\s*([0-9]+(?:\.[0-9]{1,6})?)\s*(USD|USDC)?$/i.exec(text);
  if (!match?.[1]) return null;
  const explicitSymbol = text.startsWith("$");
  const explicitCode = match[2]?.toUpperCase();
  if (!explicitSymbol && !explicitCode) return null;
  if (explicitSymbol && explicitCode && explicitCode !== "USD") return null;
  const currency = (explicitCode as Currency | undefined) ?? "USD";
  if (!CURRENCIES.includes(currency)) return null;
  try {
    const value = parseAmount(match[1], currency);
    if (value <= 0n) return null;
    return { amount: match[1], currency };
  } catch {
    return null;
  }
}

async function askDeadline(rl: Questioner, theme: Theme): Promise<string | null> {
  const raw = (await ask(rl, theme, "Deadline (YYYY-MM-DD, ISO timestamp, or blank to skip):")).trim();
  if (!raw) return null;
  let iso: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) iso = `${raw}T23:59:59.000Z`;
  else {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) {
      process.stdout.write(theme.paint("amber", "Unrecognised date; skipping the deadline.\n"));
      return null;
    }
    iso = new Date(parsed).toISOString();
  }
  if (Date.parse(iso) <= Date.now()) {
    process.stdout.write(
      theme.paint("amber", "Deadline is in the past; skipping it. You can set a new one with `settings`.\n"),
    );
    return null;
  }
  return iso;
}

async function askStrategy(rl: Questioner, theme: Theme): Promise<ExecutionStrategy> {
  process.stdout.write(
    [
      "",
      theme.paint("cyan", "How should Ash approach execution?"),
      "  1. Fully autonomous within the approved plan and limits",
      "  2. Plan first, then request my approval",
      "  3. Prefer DIY unless external expertise is necessary",
      "",
    ].join("\n"),
  );
  const raw = (await ask(rl, theme, "Choose 1-3 (default 2):")).trim().toLowerCase();
  if (raw === "1" || raw.includes("autonomous")) return "autonomous";
  if (raw === "3" || raw.includes("diy") || raw.includes("yourself")) return "diy_first";
  return "plan_then_approve";
}

async function askBool(rl: Questioner, theme: Theme, question: string, fallback: boolean): Promise<boolean> {
  const raw = (await ask(rl, theme, `${question} [${fallback ? "Y/n" : "y/N"}]`)).trim().toLowerCase();
  if (!raw) return fallback;
  if (["y", "yes", "1", "true"].includes(raw)) return true;
  if (["n", "no", "0", "false"].includes(raw)) return false;
  process.stdout.write(theme.paint("amber", `Unrecognised answer; using ${fallback ? "yes" : "no"}.\n`));
  return fallback;
}

async function ask(rl: Questioner, theme: Theme, question: string): Promise<string> {
  return (await rl.question(theme.paint("cyan", `${question} `))).toString();
}

function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
