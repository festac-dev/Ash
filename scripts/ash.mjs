#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
// Keep npm start -- <command> compatible while an argument-free start opens the terminal.
if (args[0] === "start" && args[1] && !args[1].startsWith("-") && args[1] !== "shell") args.shift();
if ((args[0] === "demo" || process.env.ASH_DEMO === "1") && process.env.NODE_ENV === "production") {
  console.error("Ash: demo mode is disabled when NODE_ENV=production.");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function mtime(file) {
  return (await fs.stat(file).catch(() => null))?.mtimeMs ?? 0;
}
async function latest(dir, extensions) {
  let newest = 0;
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.name === "bin" || item.name.endsWith("_test.go")) continue;
    const file = path.join(dir, item.name);
    newest = Math.max(
      newest,
      item.isDirectory()
        ? await latest(file, extensions)
        : extensions.some((ext) => item.name.endsWith(ext))
          ? await mtime(file)
          : 0,
    );
  }
  return newest;
}
function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const sourceTime = Math.max(
  await latest(path.join(root, "src"), [".ts"]),
  ...(await Promise.all(["tsconfig.json", "scripts/build-server.mjs"].map((file) => mtime(path.join(root, file))))),
);
const entry = path.join(root, "dist", "index.js");
if (sourceTime > (await mtime(path.join(root, "dist", ".server-built"))) || !(await mtime(entry))) {
  console.error("Building Ash backend…");
  run([path.join(root, "scripts", "build-server.mjs")]);
}
const terminal = !args.length || ["start", "tui", "demo"].includes(args[0]);
if (terminal && !args.includes("--headless") && !args.includes("--shell")) {
  const goSource = Math.max(
    await latest(path.join(root, "tui"), [".go", "go.mod", "go.sum"]),
    await mtime(path.join(root, "scripts", "build-tui.mjs")),
  );
  if (goSource > (await mtime(path.join(root, "dist", process.platform === "win32" ? "ash-tui.exe" : "ash-tui"))))
    run([path.join(root, "scripts", "build-tui.mjs")]);
}
const child = spawn(process.execPath, [entry, ...args], { cwd: root, stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
