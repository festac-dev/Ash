#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = path.join(root, "dist", ".server-built");
// A partial/failed build must never become eligible for startup on the next run.
await fs.rm(stamp, { force: true });
for (const args of [
  [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--noEmitOnError"],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await fs.writeFile(stamp, "built\n");
