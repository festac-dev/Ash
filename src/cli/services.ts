import type { AppConfig } from "../config.js";
import { TaskStore } from "../state/store.js";
import { TransactionLedger } from "../transactions/ledger.js";
import { createProviders } from "../providers/runtime.js";
import type { MarketAdapter } from "../market/types.js";
import { type ModelAdapter } from "../ai/model.js";
import { TaskPlanner } from "../ai/planner.js";
import { ExecutionEngine } from "../engine/engine.js";
import type { EngineEvent } from "../domain/types.js";
import { initLogger } from "../logger.js";
import { configureTelegram } from "../notify.js";
import { errorMessage, isAshError } from "../errors.js";
import { redact } from "../util/redact.js";
import type { StartupCheck } from "./splash.js";

export interface Services {
  config: AppConfig;
  store: TaskStore;
  transactions: TransactionLedger;
  market: MarketAdapter;
  model: ModelAdapter;
  planner: TaskPlanner;
  engine: ExecutionEngine;
  marketError: string | null;
}

export async function createServices(config: AppConfig, onEvent?: (event: EngineEvent) => void): Promise<Services> {
  await initLogger({
    dataDir: config.dataDir,
    level: config.logLevel,
    echo: config.logLevel === "debug" || (process.env.NODE_ENV === "production" && !process.stdout.isTTY),
  });
  configureTelegram(config.simulation ? { botToken: null, chatId: null, timeoutMs: 1000 } : config.telegram);
  const store = new TaskStore(config);
  await store.init();
  const { model, market } = createProviders(config);
  const engine = new ExecutionEngine({ config, store, market, model, onEvent });
  const services: Services = {
    config,
    store,
    transactions: new TransactionLedger(config.dataDir),
    market,
    model,
    planner: new TaskPlanner(config, model),
    engine,
    marketError: null,
  };
  return services;
}

export async function attemptMarketConnection(
  services: Services,
  timeoutMs = 12_000,
): Promise<{ connected: boolean; error: string | null }> {
  if (!services.config.simulation && !services.config.market.apiToken) {
    services.marketError = "No marketplace credential configured (MARKET_API_TOKEN / MARKET_API_TOKEN_FILE).";
    return { connected: false, error: services.marketError };
  }
  try {
    await withTimeout(services.market.connect(), timeoutMs, "market connection");
    services.marketError = null;
    return { connected: true, error: null };
  } catch (error) {
    const message = isAshError(error) ? error.message : `Marketplace connection failed: ${errorMessage(error)}`;
    services.marketError = redact(message);
    return { connected: false, error: services.marketError };
  }
}

export async function startupChecks(services: Services): Promise<StartupCheck[]> {
  const checks: StartupCheck[] = [];
  checks.push({ label: "Core engine", status: "ok", detail: "online" });

  const activeId = await services.store.getActive();
  let task = null;
  try {
    task = activeId ? await services.store.load(activeId) : null;
  } catch {
    task = null;
  }

  let pending = 0;
  if (task) {
    pending = (
      await services.store
        .approvals(task.id)
        .pending()
        .catch(() => [])
    ).length;
  }
  checks.push({
    label: "Security subsystem",
    status: services.config.simulation ? "sim" : "ok",
    detail: services.config.simulation
      ? "simulation — no real funds"
      : `approval gate enforced${pending > 0 ? ` · ${pending} pending` : ""}`,
  });

  const integrity = await services.transactions.verify().catch(() => null);
  checks.push({
    label: "Transaction ledger",
    status: integrity ? (integrity.ok ? "ok" : "fail") : "warn",
    detail: integrity
      ? integrity.exists
        ? `${integrity.receipt_count} receipt(s) · ${integrity.ok ? "chain verified" : "CHAIN BROKEN"}`
        : "empty · created on first receipt"
      : "could not verify",
  });

  const connection = await attemptMarketConnection(services);
  checks.push({
    label: "Agent marketplace",
    status: connection.connected ? (services.config.simulation ? "sim" : "ok") : "warn",
    detail: connection.connected
      ? services.config.simulation
        ? "simulation catalog ready"
        : `${services.market.capabilities().tools.length} buyer tools`
      : clip(connection.error ?? "offline", 90),
  });

  checks.push({
    label: "AI model",
    status: services.model.available ? (services.config.model.provider === "demo" ? "sim" : "ok") : "warn",
    detail: services.model.available
      ? `${services.config.model.provider} · ${services.config.model.name ?? "unnamed"}`
      : "not configured · planning disabled",
  });

  checks.push({
    label: "Execution engine",
    status: "ok",
    detail: task?.plan
      ? task.status === "executing"
        ? `active · ${task.status}`
        : `${task.status} · plan ready`
      : "idle · no plan",
  });

  return checks;
}

export async function refreshMarketBalance(services: Services): Promise<void> {
  if (!services.market.capabilities().buyer && !services.config.simulation) {
    const connected = await attemptMarketConnection(services, 8_000);
    if (!connected.connected) return;
  }
  const activeId = await services.store.getActive();
  if (!activeId) return;
  try {
    const who = await withTimeout(services.market.whoami(), 8_000, "balance refresh");
    await services.store.update(activeId, (task) => {
      task.market_snapshot = {
        at: new Date().toISOString(),
        source: services.config.simulation ? "simulated" : "whoami",
        account_id: who.account?.id ?? null,
        handle: who.user_handle,
        balances: who.account?.balances ?? {},
        credit_usd: who.account?.credit_usd ?? null,
        note: who.note,
      };
    });
  } catch {
    // The dashboard keeps the last real snapshot and labels it as such.
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
