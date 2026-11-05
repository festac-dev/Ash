import { AshError } from "../errors.js";
import { APP_VERSION } from "../version.js";

export const commands: Record<string, [string, string, string]> = {
  start: ["Open the terminal connected to the shared backend", "start [--shell]", "npm start"],
  tui: ["Open the terminal workspace", "tui [--remote]", "ash tui"],
  shell: ["Open the command shell", "shell", "ash shell"],
  demo: ["Run the offline walkthrough, then open the terminal", "demo [--shell] [--headless] [--json]", "npm run demo"],
  web: ["Open or stop the browser workspace", "web [--open | --stop]", "ash web --open"],
  remote: ["Alias for web", "remote [--open]", "ash remote --open"],
  frontend: [
    "Manage browser access or issue a one-time code",
    "frontend <on|off|status|code|logout-all> [--json]",
    "ash frontend on",
  ],
  server: ["Manage the local API process", "server <start|stop|status> [--json]", "ash server status --json"],
  doctor: ["Check configuration, runtime and receipt integrity", "doctor [--json]", "ash doctor --json"],
  logs: ["Read recent redacted application logs", "logs [1-500]", "ash logs 50"],
  status: ["Show task, budget and execution status", "status [--json]", "ash status --json"],
  tasks: ["List saved tasks", "tasks [--json]", "ash tasks"],
  new: ["Create a task with the guided wizard", "new [description]", "ash new"],
  plan: ["Plan the active task or import a plan", "plan [import <file>]", "ash plan"],
  execute: ["Execute an approved plan", "execute", "ash execute"],
  pause: ["Pause the active execution", "pause", "ash pause"],
  resume: ["Resume after checking approval gates", "resume", "ash resume"],
  cancel: ["Cancel a task after typed confirmation", "cancel", "ash cancel"],
  budget: ["Inspect the authorized budget", "budget [--json]", "ash budget"],
  approvals: ["List pending human decisions", "approvals [--json]", "ash approvals"],
  approve: ["Approve a specific request with its typed phrase", "approve <id>", "ash approve apr_example"],
  deny: ["Deny a request with its typed phrase", "deny <id>", "ash deny apr_example"],
  review: ["Review a deliverable", "review <subtask-id> <pass|fail>", "ash review st_1 pass"],
  agents: ["Search the configured marketplace", "agents [query] [--json]", "ash agents security"],
  jobs: ["List marketplace jobs", "jobs [--json]", "ash jobs"],
  market: ["Inspect marketplace connectivity", "market [--json]", "ash market"],
  transactions: ["Inspect receipts and chain integrity", "transactions [--json]", "ash transactions --json"],
  verify: ["Verify the receipt hash chain", "verify [--json]", "ash verify --json"],
  history: ["Read task execution history", "history [--json]", "ash history"],
  settings: ["Inspect or edit task preferences", "settings [key value] [--json]", "ash settings"],
  export: ["Export the active task and its evidence", "export [--json]", "ash export"],
  switch: ["Select a saved task", "switch <task-id>", "ash switch task_example"],
  tracks: [
    "Inspect or verify the six local track modules",
    "tracks [run <all|id> | verify] [--json]",
    "ash tracks verify --json",
  ],
  wait: ["Wait for execution progress", "wait [seconds]", "ash wait 5"],
  "notify-test": ["Explicitly send a configured Telegram test", "notify-test", "ash notify-test"],
  completion: [
    "Print shell completion definitions",
    "completion <bash|zsh|fish>",
    "ash completion bash > ~/.ash-completion.bash",
  ],
  help: ["Show command-specific help", "help [command]", "ash help plan"],
};
export function helpText(command?: string): string {
  const item = command ? commands[command] : null;
  if (command && !item) throw new AshError("VALIDATION_FAILED", `Unknown command "${command}". Run ash --help.`);
  const body = item
    ? [`${item[0]}`, "", `Usage: ash ${item[1]}`, "", `Example: ${item[2]}`]
    : [
        `Ash ${APP_VERSION} — task execution & settlement`,
        "",
        "Usage: ash [command] [options]",
        "",
        "Start here:  npm run demo      Offline simulation, no credentials",
        "             ash              Terminal workspace (B: frontend on / code / off)",
        "",
        ...Object.entries(commands).map(([name, value]) => `  ${name.padEnd(15)}${value[0]}`),
      ];
  return [
    ...body,
    "",
    "Options: -h, --help  --version  -q, --quiet  --verbose  --debug  --no-color",
    "         --json (supported inspection commands; unsupported operations fail explicitly)",
    "Financial approvals and cancellation retain exact typed confirmation; --yes cannot bypass them.",
    "Credentials: use environment variables or owner-only *_FILE files, never command-line flags.",
    "",
  ].join("\n");
}
export function completion(shell: string): string {
  const words = Object.keys(commands).join(" ");
  if (shell === "bash")
    return `complete -W '${words} --help --version --json --quiet --verbose --debug --no-color' ash\n`;
  if (shell === "zsh")
    return `#compdef ash\n_arguments '1:command:(${words})' '*:option:(--help --version --json --quiet --verbose --debug --no-color)'\n`;
  if (shell === "fish") return `complete -c ash -f -a '${words}'\n`;
  throw new AshError("VALIDATION_FAILED", "Choose a completion shell: bash, zsh or fish.");
}
