import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../src/config.js";

export async function tempDir(prefix = "ash-test-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.ASH_DATA_DIR = dir;
  return dir;
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export function testConfig(dataDir: string, overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(
    {
      ASH_DEMO: "1",
      ASH_SIMULATE: "true",
      ASH_DATA_DIR: dataDir,
      ASH_MODEL_PROVIDER: "demo",
      ASH_SERVER_UI: "true",
      ASH_LOG_LEVEL: "error",
      ASH_COLOR_MODE: "never",
      ASH_UNICODE_MODE: "never",
      ASH_ANIMATION: "false",
      ASH_MAX_PARALLEL_JOBS: "3",
      ...overrides,
    },
    process.cwd(),
  );
}

export async function waitFor<T>(
  check: () => Promise<T | null | false | undefined>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeout = options.timeoutMs ?? 30_000;
  const interval = options.intervalMs ?? 200;
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${options.label ?? "condition"}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
