import type { AppConfig } from "../config.js";
import { createModel, DemoModel } from "../ai/model.js";
import { McpMarketAdapter } from "../market/mcp-adapter.js";
import { SimulatedMarketAdapter } from "../market/simulated-adapter.js";

/** Composition root: all outbound work uses the same interfaces in either mode. */
export function createProviders(config: AppConfig) {
  return config.simulation
    ? { model: new DemoModel(), market: new SimulatedMarketAdapter(config, { latencyMs: 2_000 }) }
    : { model: createModel(config), market: new McpMarketAdapter(config) };
}
