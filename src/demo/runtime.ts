import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../config.js";
import { AshError } from "../errors.js";
import type { AshService } from "../server/service.js";
import type { Services } from "../cli/services.js";
import { sleep } from "../util/async.js";

/** This is the only demo entry boundary. Caller configuration and .env are never loaded. */
export async function createDemoConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  if (env.NODE_ENV === "production")
    throw new AshError("CONFIG_INVALID", "Demo mode is disabled when NODE_ENV=production.");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ash-demo-"));
  await fs.chmod(dataDir, 0o700);
  return loadConfig({
    ASH_DEMO: "1",
    ASH_SIMULATE: "true",
    ASH_MODEL_PROVIDER: "demo",
    ASH_DATA_DIR: dataDir,
    ASH_SERVER_PORT: "0",
    ASH_SERVER_HOST: "127.0.0.1",
    ASH_SERVER_UI: "false",
    ASH_COLOR_MODE: env.NO_COLOR !== undefined ? "never" : "auto",
  });
}

export interface DemoResult {
  simulated: true;
  task_id: string;
  status: string;
  receipt_count: number;
  integrity: boolean;
  rejected_cases: string[];
  data_dir: string;
}

/** Uses the same services, planner, approval checks, engine, verifier and ledgers as the UI. */
export async function runDemoFlow(
  service: AshService,
  services: Services,
  report: (message: string) => void = () => {},
  signal?: AbortSignal,
): Promise<DemoResult> {
  if (!services.config.simulation || services.config.model.provider !== "demo")
    throw new AshError("UNSAFE_OPERATION", "The demo driver requires isolated simulated providers.");
  signal?.throwIfAborted();
  const rejected: string[] = [];
  const input = {
    description: "Freelancer launch pack with an independent delivery review",
    budget: "100.00",
    currency: "USDC",
    execution_strategy: "plan_then_approve",
    require_hiring_approval: false,
    allow_external: true,
  };
  try {
    await service.createTask({ ...input, budget: "-1.00" });
  } catch {
    rejected.push("invalid_budget");
    report("Validation rejected a negative budget. No task was created.");
  }
  if (!rejected.length)
    throw new AshError("STATE_INVALID", "Demo validation check unexpectedly accepted a negative budget.");
  const task = await service.createTask(input);
  report("Task created. Planning through the configured model provider…");
  const planned = await service.planTask(task.id);
  signal?.throwIfAborted();
  if (!planned.approval) throw new AshError("STATE_INVALID", "Demo expected a plan approval gate.");
  try {
    await service.approve(task.id, planned.approval.id, "APPROVE wrong-request");
  } catch {
    rejected.push("wrong_approval");
    report("Approval rejected the wrong confirmation phrase. The budget is unchanged.");
  }
  if (rejected.length !== 2)
    throw new AshError("STATE_INVALID", "Demo approval check unexpectedly accepted the wrong phrase.");
  report(
    `Review: ${planned.task.plan?.subtasks.length} steps, ${planned.task.plan?.external_planned} USDC simulated spending ceiling.`,
  );
  // Explicit consent exists only inside this simulation driver; live users type the phrase.
  await service.approve(task.id, planned.approval.id, `APPROVE ${planned.approval.id}`);
  report("SIMULATED operator approved the plan. Executing with local providers…");
  signal?.throwIfAborted();
  await service.execute(task.id);
  const deadline = Date.now() + 180_000;
  for (;;) {
    signal?.throwIfAborted();
    const current = await services.store.load(task.id);
    if (current.status === "completed") break;
    if (["failed", "cancelled", "paused"].includes(current.status) || Date.now() >= deadline) {
      throw new AshError(
        "STATE_INVALID",
        `Demo stopped at ${current.status}: ${current.status_detail ?? "execution timed out"}. Inspect ${services.config.dataDir}.`,
      );
    }
    await sleep(300);
  }
  const integrity = await services.transactions.verify();
  if (!integrity.ok) throw new AshError("INTEGRITY_FAILED", "Demo receipt verification failed.");
  await service.exportProof(task.id);
  report(`Completed. ${integrity.receipt_count} simulated receipts verified; evidence exported.`);
  return {
    simulated: true,
    task_id: task.id,
    status: "completed",
    receipt_count: integrity.receipt_count,
    integrity: true,
    rejected_cases: rejected,
    data_dir: services.config.dataDir,
  };
}

export async function runDemo(args: string[]): Promise<number> {
  const config = await createDemoConfig();
  const json = args.includes("--json");
  const report = (message: string) => {
    if (!json) process.stdout.write(`[DEMO] ${message}\n`);
  };
  report("ASH SIMULATION · no real agents, funds or external network services.");
  const { startAshServer } = await import("../server/server.js");
  const server = await startAshServer({ config, port: 0, inlineFrontend: true });
  const { runTerminal } = await import("../launcher.js");
  report("Frontend OFF · B opens browser access.");
  report(`Private temporary data: ${config.dataDir}`);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const unsubscribe = server.bus.subscribe((event) => {
    if (event.type === "engine" && ["SUBTASK_RECEIPT", "TASK_COMPLETED", "SUBTASK_FAILED"].includes(event.event.code))
      report(event.event.message);
  });
  try {
    const result = await runDemoFlow(server.service, server.services, report, abort.signal);
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, ...result, frontend_running: false })}\n`);
    if (!args.includes("--headless")) {
      if (json) {
        if (!abort.signal.aborted)
          await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
      } else {
        unsubscribe();
        return await runTerminal(config, server.session, { shell: args.includes("--shell") });
      }
    }
    return abort.signal.aborted ? 130 : 0;
  } catch (error) {
    if (abort.signal.aborted) return 130;
    throw error;
  } finally {
    unsubscribe();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await server.close();
  }
}
