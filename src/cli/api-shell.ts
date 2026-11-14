import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { ServerSession } from "../server/server.js";
import type { AshState, TaskSummary, TransactionView } from "../server/service.js";
import { AshError, errorMessage, type AshErrorCode } from "../errors.js";
import { oneLine, sanitizeUntrustedText } from "../util/strings.js";
import { redact } from "../util/redact.js";
import { Theme } from "./theme.js";
import { table, keyValue } from "./components.js";
import { frontendRequest, frontendText } from "./frontend.js";

/** A terminal client, not a second engine. All mutations use the browser's API authority. */
export async function runApiShell(
  session: ServerSession,
  config: AppConfig,
  io: { input: Readable; output: Writable; terminal?: boolean } = {
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  },
): Promise<number> {
  const theme = new Theme(config, io.output as NodeJS.WriteStream);
  const lines = createInterface({
    input: io.input,
    output: io.output,
    terminal: io.terminal ?? false,
    historySize: 0,
  });
  const iterator = lines[Symbol.asyncIterator]();
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    lines.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const prefix = config.simulation ? "[DEMO] " : "";
  const write = (text: string) => io.output.write(`${prefix}${redact(text)}\n`);
  const label = (value: string) => value.replaceAll("_", " ");
  const present = (value: unknown, depth = 0): string[] => {
    if (value === null || value === undefined) return ["—"];
    if (typeof value !== "object") return [String(value)];
    if (Array.isArray(value))
      return value.length
        ? value.flatMap((item, index) => [`${index + 1}.`, ...present(item, depth + 1).map((line) => `  ${line}`)])
        : ["None"];
    return Object.entries(value).flatMap(([key, item]) =>
      item !== null && typeof item === "object"
        ? [theme.bold(label(key)), ...present(item, depth + 1).map((line) => `  ${line}`)]
        : [keyValue(theme, label(key), item === null ? "—" : String(item))],
    );
  };
  const show = (value: unknown) => write(present(value).join("\n"));
  const progress = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (io.terminal && process.env.ASH_NO_SPLASH !== "1") timer = setTimeout(() => write(`${label}…`), 600);
    try {
      return await work();
    } finally {
      clearTimeout(timer);
    }
  };
  const ask = async (prompt: string): Promise<string> => {
    if (io.terminal) io.output.write(theme.paint("cyan", `${prefix}${prompt} `));
    const next = await iterator.next();
    if (next.done) throw new AshError("CONFLICT", "Input ended before the command was complete.");
    return next.value.trim();
  };
  const request = async <T>(route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${session.url}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(config.model.timeoutMs + 30_000)]),
    });
    const result = (await response.json()) as T & { error?: { code?: AshErrorCode; message?: string; hint?: string } };
    if (!response.ok)
      throw new AshError(
        result.error?.code ?? "CONFLICT",
        result.error?.message ?? `Request failed (${response.status}).`,
        { hint: result.error?.hint },
      );
    return result;
  };
  const snapshot = () => request<AshState>("/api/state");
  const active = async () => {
    const state = await snapshot();
    if (!state.active_task_id) throw new AshError("NOT_FOUND", "No active task. Use new or switch <task-id>.");
    return { state, route: `/api/tasks/${encodeURIComponent(state.active_task_id)}` };
  };
  const status = async () => {
    const [state, frontend] = await Promise.all([snapshot(), frontendRequest(session, "status", abort.signal)]);
    write(theme.bold("ASH WORKSPACE"));
    write(keyValue(theme, "Task", state.task ? oneLine(state.task.description, 100) : "No active task"));
    write(
      keyValue(
        theme,
        "Execution",
        `${state.task?.status ?? "idle"} · engine ${state.engine_running ? "running" : "stopped"}`,
      ),
    );
    if (state.ledger)
      write(
        keyValue(
          theme,
          "Budget",
          `${state.ledger.available} ${state.ledger.currency} available / ${state.ledger.authorized} authorized`,
        ),
      );
    write(frontendText(frontend, false, true).trim());
  };
  const help = () =>
    write(
      [
        "Commands",
        "  status · tasks · new [description] · switch <task-id>",
        "  plan · execute · pause · resume · cancel",
        "  approvals · approve <id> · deny <id> · budget [amount]",
        "  review <subtask-id> <pass|fail> · settings [key value]",
        "  chat <message> · agents [query] · market · jobs",
        "  transactions · verify · history · export",
        "  B: start frontend → generate code → close frontend",
        "  frontend <status|on|off|code|logout-all> · help · quit",
        "Approvals and cancellation require their exact confirmation phrase.",
      ].join("\n"),
    );
  let exitCode = 0;
  try {
    write(
      config.simulation ? "ASH SIMULATION — no real agents, funds or external services." : "ASH — terminal workspace",
    );
    await status();
    if (process.env.ASH_NO_SPLASH !== "1") write("help · commands    B · browser");
    while (!abort.signal.aborted) {
      if (io.terminal) io.output.write(theme.paint("cyan", `${prefix}ash › `));
      const next = await iterator.next();
      if (next.done) break;
      const [raw = "", ...args] = next.value.trim().split(/\s+/);
      const command = raw.toLowerCase();
      if (!command) continue;
      if (["exit", "quit", "q"].includes(command)) break;
      try {
        if (["help", "?"].includes(command)) {
          help();
          continue;
        }
        if (command === "status") {
          await status();
          continue;
        }
        if (command === "b" || command === "frontend") {
          const action = command === "b" ? "cycle" : (args[0] ?? "status");
          if (!["cycle", "on", "off", "status", "code", "logout-all"].includes(action))
            throw new AshError("VALIDATION_FAILED", "Use frontend status|on|off|code|logout-all, or B.");
          const result = await progress("Updating browser access", () =>
            frontendRequest(session, action, abort.signal),
          );
          // Access codes are displayed only in direct responses to the requesting terminal.
          // Generic task/error output remains redacted; never send this through a logger.
          io.output.write(`${prefix}${sanitizeUntrustedText(frontendText(result, false))}`);
          continue;
        }
        if (command === "tasks") {
          const { tasks } = await request<{ tasks: TaskSummary[] }>("/api/tasks");
          if (!tasks.length) write("No tasks yet. Use new to create one.");
          else
            write(
              table(
                theme,
                ["Task", "Status", "Description"],
                tasks.map((task) => [task.id, task.status, oneLine(task.description)]),
              ).join("\n"),
            );
          continue;
        }
        if (command === "new") {
          const description = args.join(" ") || (await ask("Describe the task:"));
          const budget = await ask("Budget limit:");
          const currency = (await ask("Currency [USDC]:")) || "USDC";
          const { task } = await request<{ task: { id: string } }>("/api/tasks", {
            description,
            budget,
            currency,
            execution_strategy: "plan_then_approve",
            require_hiring_approval: true,
          });
          write(`Task created: ${task.id}.`);
          continue;
        }
        if (command === "chat") {
          const message = args.join(" ") || (await ask("Message:"));
          const state = await snapshot();
          const history = await progress("Ash is thinking", () =>
            request<{ messages: { role: string; content: string }[] }>("/api/chat", {
              task_id: state.active_task_id,
              message,
              request_id: randomUUID(),
            }),
          );
          write(sanitizeUntrustedText(history.messages.at(-1)?.content ?? "No reply returned."));
          continue;
        }
        if (["market", "jobs", "agents"].includes(command)) {
          show(
            await request(
              `/api/${command}${command === "agents" ? `?query=${encodeURIComponent(args.join(" "))}` : ""}`,
            ),
          );
          continue;
        }
        if (command === "transactions" || command === "verify") {
          const value = await request<TransactionView>("/api/transactions");
          show(command === "verify" ? value.integrity : value);
          continue;
        }
        if (command === "approvals") {
          show((await snapshot()).approvals);
          continue;
        }
        if (command === "history") {
          show((await snapshot()).events);
          continue;
        }
        if (command === "budget" && !args.length) {
          show((await snapshot()).ledger);
          continue;
        }
        if (command === "settings" && !args.length) {
          show(await request("/api/settings"));
          continue;
        }
        if (command === "switch") {
          if (!args[0]) throw new AshError("VALIDATION_FAILED", "Use switch <task-id>. List IDs with tasks.");
          await request(`/api/tasks/${encodeURIComponent(args[0])}/activate`, {});
          await status();
          continue;
        }
        if (
          ![
            "plan",
            "execute",
            "pause",
            "resume",
            "cancel",
            "approve",
            "deny",
            "budget",
            "settings",
            "review",
            "export",
          ].includes(command)
        )
          throw new AshError("VALIDATION_FAILED", `Unknown command ${oneLine(raw)}. Type help.`);
        const { state, route } = await active();
        if (["approve", "deny"].includes(command)) {
          if (!args[0])
            throw new AshError("VALIDATION_FAILED", `Use ${command} <approval-id>. List IDs with approvals.`);
          const phrase = await ask(`Type ${command.toUpperCase()} ${args[0]}:`);
          await request(`${route}/${command}`, { approval_id: args[0], phrase });
          write(`Approval ${args[0]} ${command === "approve" ? "approved" : "denied"}.`);
        } else if (command === "cancel") {
          const phrase = await ask(`Type CANCEL ${state.active_task_id}:`);
          await request(`${route}/cancel`, { phrase });
          write("Task cancelled.");
        } else if (command === "budget") show(await request(`${route}/budget`, { amount: args[0] }));
        else if (command === "settings")
          show(await request(`${route}/settings`, { key: args[0], value: args.slice(1).join(" ") }));
        else if (command === "review") {
          if (!args[0] || !["pass", "fail"].includes(args[1] ?? ""))
            throw new AshError("VALIDATION_FAILED", "Use review <subtask-id> <pass|fail>.");
          const phrase = await ask(`Type REVIEW ${args[0]} ${args[1]!.toUpperCase()}:`);
          show(await request(`${route}/review`, { subtask_id: args[0], decision: args[1], phrase }));
        } else if (command === "export") show(await request(`${route}/proof`, {}));
        else {
          write(`${command === "plan" ? "Preparing plan" : "Applying " + command}…`);
          await request(`${route}/${command}`, {});
          await status();
          if (command === "plan") {
            const planned = await snapshot();
            show(planned.task?.plan);
            show(planned.approvals);
          }
        }
      } catch (error) {
        if (abort.signal.aborted) break;
        exitCode = 1;
        write(`Error: ${sanitizeUntrustedText(errorMessage(error))}`);
        if (error instanceof AshError && error.hint) write(`Hint: ${sanitizeUntrustedText(error.hint)}`);
      }
    }
    return exitCode;
  } finally {
    stop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
