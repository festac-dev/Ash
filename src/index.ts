#!/usr/bin/env node
import { isAshError } from "./errors.js";
import { runLauncher } from "./launcher.js";
import { runServerMain } from "./server/main.js";
import { notify } from "./notify.js";
import { redact } from "./util/redact.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "__server__") {
    const code = await runServerMain();
    if (code !== 0) process.exitCode = code;
    return;
  }
  try {
    process.exitCode = await runLauncher(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = isAshError(error) ? error.code : "STATE_INVALID";
    const safe = redact(message);
    const exitCode =
      code === "CONFIG_INVALID" || code === "VALIDATION_FAILED"
        ? 2
        : code === "NOT_FOUND"
          ? 3
          : /APPROVAL|UNSAFE|AUTH/.test(code)
            ? 4
            : /INTEGRITY/.test(code)
              ? 5
              : /UNAVAILABLE|TIMEOUT/.test(code)
                ? 6
                : 1;
    if (argv.includes("--json"))
      process.stdout.write(
        `${JSON.stringify({ ok: false, simulated: process.env.ASH_DEMO === "1", error: { code, message: safe } })}\n`,
      );
    else
      process.stderr.write(`Ash: ${safe}\n${isAshError(error) && error.hint ? `Hint: ${redact(error.hint)}\n` : ""}`);
    if (argv.includes("--debug") && error instanceof Error) process.stderr.write(`${redact(error.stack ?? "")}\n`);
    void notify(`Ash stopped: ${redact(message)}`, "error");
    process.exitCode = exitCode;
  }
}

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`Unhandled failure: ${redact(message)}\n`);
  void notify(`Unhandled failure: ${redact(message)}`, "error");
  process.exitCode = 1;
});

process.on("uncaughtException", (error) => {
  process.stderr.write(`Uncaught failure: ${redact(error.message)}\n`);
  void notify(`Uncaught failure: ${redact(error.message)}`, "error").finally(() => process.exit(1));
});

void main();
