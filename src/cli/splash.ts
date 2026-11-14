import { renderLogo } from "./logo.js";
import type { Theme } from "./theme.js";
import { panel } from "./components.js";
import { stripAnsi } from "../util/strings.js";

export interface StartupCheck {
  label: string;
  status: "ok" | "warn" | "fail" | "sim";
  detail: string;
}

export function renderStartup(theme: Theme, checks: StartupCheck[]): string[] {
  const lines = renderLogo(theme);
  const checkLines = checks.map((check) => {
    const marker =
      check.status === "ok"
        ? theme.paint("green", theme.unicode ? `[${theme.symbol("ok")}]` : theme.symbol("ok"))
        : check.status === "sim"
          ? theme.paint("magenta", "[SIM]")
          : check.status === "warn"
            ? theme.paint("amber", theme.unicode ? `[${theme.symbol("warn")}]` : theme.symbol("warn"))
            : theme.paint("red", theme.unicode ? `[${theme.symbol("fail")}]` : theme.symbol("fail"));
    return `${marker} ${check.label.padEnd(24)} ${theme.paint(check.status === "fail" ? "red" : check.status === "warn" ? "amber" : "cyan", check.detail)}`;
  });
  lines.push(theme.paint("cyan", "  Connection checks"));
  lines.push(...checkLines);
  const failed = checks.some((check) => check.status === "fail");
  lines.push("");
  lines.push(failed ? theme.paint("red", "  Attention required") : theme.paint("green", "  Ready"));
  if (checks.some((check) => check.status === "sim")) {
    lines.push(theme.paint("magenta", "  DEMO · Simulated agents and payments"));
  }
  lines.push("");
  return lines;
}

/** Print completed startup checks once; long-running operations report their own progress. */
export async function animateStartup(theme: Theme, checks: StartupCheck[], _enabled: boolean): Promise<void> {
  for (const line of renderStartup(theme, checks)) process.stdout.write(`${line}\n`);
}

export function compactStartup(theme: Theme, checks: StartupCheck[]): string[] {
  const failed = checks.some((check) => check.status === "fail");
  const market = checks.find((check) => check.label.toLowerCase().includes("market"));
  return [
    "",
    theme.bold("ASH") + theme.dim("  //  TASK EXECUTION & SETTLEMENT"),
    theme.dim("─".repeat(Math.min(theme.width, 72))),
    `${theme.paint("cyan", "SECURITY")} ${checks.find((check) => check.label.toLowerCase().includes("security"))?.detail ?? "unknown"}   ${theme.paint("cyan", "LEDGER")} ${checks.find((check) => check.label.toLowerCase().includes("ledger"))?.detail ?? "unknown"}   ${theme.paint("cyan", "MARKET")} ${market?.detail ?? "unknown"}`,
    failed
      ? theme.paint("red", "ATTENTION REQUIRED — run `market` / `verify` for details")
      : theme.paint("green", "READY — think, plan, source, execute, verify, pay, record"),
    "",
  ];
}

export function startupPanel(theme: Theme, checks: StartupCheck[]): string[] {
  return panel(
    theme,
    "SYSTEM BOOT",
    renderStartup(theme, checks).filter((line) => stripAnsi(line).trim().length > 0),
    {
      tone: "green",
      shadow: true,
    },
  );
}
