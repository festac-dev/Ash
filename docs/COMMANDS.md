# Commands

## Launcher and TUI

`ash` (or `npm start`) starts the managed Node backend and opens the Go/Bubble Tea client. `ash web` (or `ash remote`) starts or attaches the backend and prints the browser UI URL; add `--open` to open the browser; enter the printed one-time code. `ash tui` requires the TUI; `ash server start|stop|status` manages the API independently; `ash doctor` checks the installation and `ash logs` tails the logs. See [TUI_GUIDE.md](TUI_GUIDE.md), [REMOTE.md](REMOTE.md) and [API.md](API.md).

`ash doctor --json` reports the current browser state as `web.enabled` and `web.url`.
`web.start_on_boot` separately reports the configured restart behavior. Turning the
frontend ON temporarily does not change the default after a service restart.

## Legacy readline shell

Start the legacy shell with `npm run dev -- shell`, or use one-shot commands such as `ash status` / `node dist/index.js status`. The prompt is:

```
╭─[ASH]─[TASK EXECUTION]─[IDLE]
╰─❯
```

`IDLE` means the engine is not running; `ONLINE` means it is. Commands can be typed at any time while the engine runs.

Natural language is supported: if a line is not a known command and is at least a few words long, Ash treats it as a new task description and opens the guided setup. Short unknown words show help instead.

## Task and planning

### `new [task text]`

Runs the guided setup. With text after `new`, that text is the prefilled task description. Ash asks for:

- maximum total budget and currency (`150 USDC`, `$150`); the currency must be explicit, because Ash never guesses a missing one,
- optional project workstreams (`realworld`, `business`, `security`, `privacy`, `swarms`, `social`; default all) and the project inputs for the selected workstreams,
- optional deadline, quality requirements, preferred agents,
- execution strategy: autonomous / plan-then-approve / DIY-first,
- whether external hiring and DIY-first are allowed,
- whether every hire needs explicit approval,
- maximum parallel jobs,
- optional private instructions.

Everything is validated before a task is created. Each task gets its own ledger. Nothing user-specific is hardcoded.

### `plan`

Asks the configured model for a plan, validates it, and stores it. The plan contains:

- summary, final outcome, assumptions and risks,
- subtasks with dependencies, complexity, skills and deliverable,
- DIY/EXTERNAL choice and rationale,
- acceptance criteria,
- estimated and maximum price per subtask,
- a contingency reserve.

Ash rejects plans that exceed the budget, fail the reserve, contain dependency cycles, use unknown dependencies, or contain external work when hiring is disabled. A model cannot add shell commands.

After planning:

- autonomous strategy: the plan is accepted automatically and the task is ready to execute;
- other strategies: an approval request is created. Nothing is hired until you run `approve <id>` with the exact phrase.

### `plan import <file.json>`

Validates and installs a reviewed plan from disk. Accepts either the full Ash `Plan` shape or a planner-style object; in the latter case Ash assembles the currency/budget fields. Imported plans go through exactly the same budget, dependency and criterion checks.

Example:

```
plan import ./plans/website.json
```

## Ash project and workstreams

### `tracks [id]`

Shows the one Ash project and its six workstreams. `tracks <id>` shows a workstream's mandatory build order, project inputs, constraints and exact approval gate.

When you run `new`, Ash asks which workstreams the task covers (`all` is the default; a comma-separated list such as `realworld,security` narrows it; `custom` selects none). It then asks for those workstreams' values and stores them with prefixes such as `realworld.network`. Project values are never invented. Gated work still requires your explicit OK and, for provider flows, evidence on a network the provider actually supports. NEAR Intents has no testnet; see [TRACKS.md](TRACKS.md).

## Human approvals

### `approvals`

Shows the task’s approval requests, their status, amount, expiry and scope. Scopes include the vendor, subtask, job, bid, currency, plan hash or verification hash, and a public-brief preview for board postings.

### `approve <id>`

Prints the request details and asks you to type exactly:

```
APPROVE <id>
```

Nothing is approved if the phrase differs, the request expired, the plan hash changed, the budget changed since the request, or the approval no longer matches the operation. Budget and plan approvals are applied immediately; hire/award/acceptance requests are picked up by the engine on its next check.

### `deny <id>`

Requires:

```
DENY <id>
```

A denied hire does nothing. A denied plan leaves the task awaiting a new plan. A denied acceptance leaves escrow untouched and records the failure.

## Execution

### `execute`

Starts the background engine for the approved plan. It refuses if:

- there is no plan,
- the plan is still awaiting approval,
- the task is already completed, failed or cancelled,
- another process holds the task’s execution lease.

The engine starts only the number of ready subtasks allowed by `ASH_MAX_PARALLEL_JOBS` (or the task’s lower value). Independent subtasks run concurrently; dependencies wait.

### `pause`

Stops starting new work. In-flight marketplace calls finish and persist their result. Run `resume` to continue. Ctrl+C at the prompt also pauses an executing task; a second Ctrl+C exits.

### `resume`

Sets a paused task back to executing and starts the engine if it is not already running.

### `cancel`

Requires typing:

```
CANCEL <task-id>
```

Cancels new work and records `CANCELLED` receipts for started subtasks. **It does not call `cancel_job` on the marketplace.** Any funded escrow is recorded as `REFUND_PENDING` and must be resolved on the market page. Ash never assumes the refund happened.

## Inspection

### `status` / `dashboard`

Shows actual state only:

- task description, status and status detail,
- authorized budget, market account balance snapshot, committed, paid, refunded and available,
- external plan and contingency,
- subtask completion, active work and parallelism,
- receipt count, last receipt hash and chain verification,
- market auth, pending approvals and the hiring gate.

No fictional balances, agents or jobs are generated.

### `budget`

Shows the ledger totals, plan reserve, unspent external plan, market balance snapshot and recent ledger entries.

### `budget set <amount> <USD|USDC>`

Requests a budget change. The currency cannot switch mid-task. Ash pre-checks committed, paid and plan reserve, then creates an approval request. The ledger is only adjusted after you type `APPROVE <id>`. A decrease cannot drop below committed or paid funds.

### `history [n]`

Lists recent append-only ledger entries with timestamps, amounts, references and descriptions.

### `transactions [n]`

Lists receipt files, status, item, vendor, agreed amount, payment status and hash prefix. Refuses to list a broken chain; use `verify` for details.

### `verify`

Runs the full SHA-256 chain check: hashes, previous links, genesis, sequence, duplicate ids, filenames, chain head and missing records. It reports the failing file and never rewrites committed receipts. It may finish a previously journaled append whose complete evidence still verifies.

### `show <subtask> [lines]`

Prints the stored deliverable text for a subtask, the verifier result, source and injection flags. Use `show task` to print the task description.

## Marketplace

### `agents <query>`

Searches the connected marketplace and shows name, handle, price, payable rails, success rate, delivered jobs and runtime. Simulation results are labelled.

### `jobs`

Shows external jobs for the active task (vendor, job id, agreed price, payment status, market state), then account-wide marketplace jobs if the connection supports it.

### `market`

Shows the endpoint, mode, server version, buyer tool count, hiring/acceptance capabilities, account handle, email verification and balances. It never prints the token.

## Verification and review

### `review <subtask> pass|fail [note]`

Used when verification returns `needs_human` (ambiguous evidence, model unavailable, or prompt-injection signals). Ash shows a preview and the verifier findings, then requires:

```
REVIEW <subtask> PASS
```

or `REVIEW <subtask> FAIL`. A human pass can unblock acceptance; a human fail triggers the normal verification failure path. The receipt records `reviewed_by: HUMAN` and the note.

### `accept <subtask>`

Shows the acceptance state, verification result, market job, page URL, and the pending acceptance approval id if one exists. Payment still happens on the market page.

## Settings and reports

### `settings`

Shows redacted configuration (mode, provider, host, token configured or not, policy limits, data directory) and the active task’s preferences.

### `settings set <key> <value>`

Changes permitted task preferences while the task is not executing:

| Key | Values |
|---|---|
| `strategy` / `execution_strategy` | `autonomous`, `plan_then_approve`, `diy_first` |
| `require_hiring_approval` / `hire_approval` | `true` / `false` |
| `max_parallel_jobs` | 1..installation limit |
| `allow_external` | `true` / `false` |
| `diy_first` | `true` / `false` |
| `deadline` | ISO timestamp, `YYYY-MM-DD`, or `none` |
| `quality` / `quality_requirements` | text, empty to clear |
| `additional_instructions` / `instructions` | private text, empty to clear |
| `preferred_agents` | comma-separated names/handles/ids |

Budget changes are deliberately not allowed here. Use `budget set` plus approval.

### `export [path]`

Writes a Markdown report and a JSON bundle containing the task, plan, ledger, approvals, receipts and integrity report. Without a path, files go to `tasks/<id>/reports/`. Reports contain no credentials.

### `notify-test`

Sends one Telegram test message when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured. If notifications are disabled or delivery fails, it reports that clearly and does not affect the task.

## Sessions

### `tasks`

Lists local task sessions, statuses, budgets and ages.

### `switch <id|prefix|latest|active>`

Changes the active task. Not allowed while the engine is running; pause/cancel first.

## Observation

### `wait [seconds]`

Lets the background engine advance, then prints the dashboard. Useful while watching a long job; capped at 300 seconds.

### `help [command]`

Shows command help.

### `exit` / `quit` / `q`

Stops the engine, releases the execution lease, disconnects the marketplace and exits. Persisted receipts and task state remain.

## Non-interactive use

Ash reads stdin as a command script when it is not attached to a TTY. This is how tests drive it:

```bash
printf 'status\nexit\n' | ASH_DEMO=1 ASH_DATA_DIR=/tmp/ash-demo node dist/index.js
```

Read-only commands can also be run directly:

```bash
ash verify
ash status
ash transactions
ash export ./reports
```

For a scripted new task, supply the wizard answers in order, one per line. Use `wait` to let the engine advance before the script exits.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Normal exit |
| `1` | Runtime failure |
| `2` | Configuration invalid at startup |

## Current frontend and scripting commands (1.1)

`ash frontend on|off|status|code|logout-all` all accept `--json`. ON and code print the
requested code only to stdout; status never reveals one. OFF revokes all sessions and
codes. B first checks state and starts the frontend with its URL/port. A second B
displays the code; a third B closes and revokes access. Public/SSH flows are in DEPLOYMENT.md. Old `ash web --open` now opens an unsigned
URL and prints a code to enter; there are no URL tickets or persisted sign-in links.

`--help` is contextual for every advertised command. `--no-color`, `--quiet`/`-q`,
`--verbose`, `--debug` and `--version` are global. Read-only commands support structured
service data via `--json`; unsupported combinations return a JSON error. Use
`ash completion bash|zsh|fish` for shell completion. Typed financial/cancellation phrases
remain mandatory; a generic yes flag does not bypass them.

Structured CLI exit codes: 0 success, 2 usage/config, 3 missing resource, 4 auth/safety,
5 integrity failure, 6 unavailable/timeout, 1 other failures. The retained interactive
shell reports failed commands as 1. `npm --silent start -- …` avoids npm's own banners;
`node dist/index.js …` is the direct scripting entrypoint.

`npm start` opens the TUI or shared API text shell. Use `npm start -- --shell` to
select the text shell; `npm run demo -- --shell` uses it after the isolated walkthrough.
Both keep frontend OFF initially. B cycles start (URL only), code, then close/revoke.
The shell accepts B followed by Enter. Use `help` for its task and approval commands.
