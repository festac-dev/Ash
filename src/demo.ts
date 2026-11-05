import type { AppConfig } from "./config.js";
import { TaskStore } from "./state/store.js";
import { validatePlan } from "./domain/plan.js";
import { AshError } from "./errors.js";

/** A real engine run against the simulation adapter, with a visible fan-out/join. */
export async function createDemoTask(config: AppConfig): Promise<string> {
  if (!config.simulation || config.model.provider !== "demo")
    throw new AshError("CONFIG_INVALID", "The showcase requires simulation and the demo model.");
  const store = new TaskStore(config);
  await store.init();
  const active = await store.getActive();
  if (active) {
    const task = await store.load(active);
    if (!["completed", "failed", "cancelled"].includes(task.status)) return task.id;
  }
  const task = await store.create({
    description: "Freelancer launch pack: invoice template, independent review and delivery handover",
    budget: "25.00",
    currency: "USDC",
    deadline: null,
    quality_requirements: "Clearly label all simulated results. Produce reviewable local artifacts.",
    preferred_agents: [],
    execution_strategy: "autonomous",
    allow_external: true,
    diy_first: true,
    require_hiring_approval: false,
    max_parallel_jobs: 2,
    additional_instructions: "This is a simulated workflow showcase, not an on-chain invoicing product.",
  });
  const node = (id: string, title: string, dependencies: string[], execution: "DIY" | "EXTERNAL", amount: string) => ({
    id,
    title,
    description: `${title}. Cover the brief, acceptance checks, risks and next actions.`,
    dependencies,
    execution,
    complexity: "low",
    skills: execution === "EXTERNAL" ? ["review"] : [],
    deliverable: `${title} as a written artifact`,
    acceptance_criteria: [
      { kind: "deliverable_present", description: "A substantive written deliverable is present", min_chars: 80 },
    ],
    planned_max: amount,
    estimated_cost: amount,
    rationale: execution === "DIY" ? "Produce the local planning artifact." : "Obtain an independent simulated review.",
  });
  const plan = validatePlan(
    {
      schema_version: 1,
      summary: "Draft a brief, run local and external work in parallel, then assemble a handover.",
      final_outcome: "A simulated freelancer launch pack with verified receipts",
      assumptions: ["No real funds or invoice payments are involved."],
      risks: [
        "Live invoicing requires a separate provider integration and explicitly approved settlement demonstration.",
      ],
      currency: "USDC",
      authorized_budget: "25.00",
      contingency: "3.00",
      external_planned: "14.00",
      subtasks: [
        node("st_1", "Define invoice requirements", [], "DIY", "0.00"),
        node("st_2", "Independent launch review", ["st_1"], "EXTERNAL", "14.00"),
        node("st_3", "Draft invoice workflow", ["st_1"], "DIY", "0.00"),
        node("st_4", "Assemble client handover", ["st_2", "st_3"], "DIY", "0.00"),
      ],
    },
    task.authorized_budget,
    task.currency,
    { allowedVerifyCommands: [], contingencyRatio: config.policy.contingencyRatio },
  );
  await store.installPlan(task.id, plan, { planApprovalRef: "strategy:autonomous" });
  return task.id;
}
