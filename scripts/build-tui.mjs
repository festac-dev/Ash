#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tuiDir = path.join(repo, "tui");
// A static Linux executable runs on the Android kernel without an Android cgo linker.
const targetOS =
  process.env.GOOS ||
  (process.platform === "win32" ? "windows" : process.platform === "android" ? "linux" : process.platform);
const buildEnv = { ...process.env, GOOS: targetOS, CGO_ENABLED: process.env.CGO_ENABLED ?? "0" };
const out = path.join(repo, "dist", targetOS === "windows" ? "ash-tui.exe" : "ash-tui");
const args = process.argv.slice(2);
const testOnly = args.includes("--test");
const required = args.includes("--required") || testOnly;

function findGo() {
  const candidates = [
    process.env.ASH_GO_BIN,
    "go",
    "/usr/local/go/bin/go",
    path.join(process.env.HOME ?? "", "go", "bin", "go"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["version"], { encoding: "utf8", timeout: 10_000 });
    if (result.status === 0) return candidate;
  }
  return null;
}

const go = findGo();
if (!go) {
  const message = "Go 1.25+ was not found. Install Go or set ASH_GO_BIN to build the Bubble Tea TUI.";
  if (required) {
    console.error(`ASH TUI BUILD FAILED: ${message}`);
    process.exit(1);
  }
  console.warn(`ASH TUI BUILD SKIPPED: ${message}`);
  process.exit(0);
}

if (testOnly) {
  const result = spawnSync(go, ["test", "./..."], { cwd: tuiDir, stdio: "inherit", env: buildEnv });
  process.exit(result.status ?? 1);
}

await fs.mkdir(path.dirname(out), { recursive: true });
const result = spawnSync(go, ["build", "-trimpath", "-o", out, "."], {
  cwd: tuiDir,
  stdio: "inherit",
  env: buildEnv,
});
if (result.status !== 0) {
  console.error("ASH TUI BUILD FAILED");
  process.exit(result.status ?? 1);
}
console.log(`Ash TUI built: ${path.relative(repo, out)}`);
