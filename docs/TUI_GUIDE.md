# Ash TUI Guide

Ash's terminal client is a Go + Bubble Tea application. It talks to the local Node backend, which owns planning, budgets, approvals, marketplace calls and receipts.

## Build and run

```bash
npm install
npm run build:tui       # Go 1.25+ required
npm start               # or ./dist/index.js / linked `ash`
```

`ash` starts a managed backend when none is healthy, then opens the TUI. `ash tui` does the same but refuses to fall back if the TUI is missing. `ash server start` runs only the backend.

If the TUI is not built, `npm start` opens the text shell connected to the same backend. Use `npm start -- --shell` to select it explicitly.

For a browser instead of a terminal, run `ash web` (or `ash remote`). The backend serves the same authenticated API and browser command centre; see [REMOTE.md](REMOTE.md).

To attach the TUI to an existing backend (including a remote one), set `ASH_API_URL` and `ASH_API_TOKEN`, then run `ash tui --remote`. The launcher does not start a local backend in that mode.

## Windows Terminal and PowerShell

Install Node.js 22.13+ and Go 1.25+, then open a PowerShell tab in Windows Terminal at the repository folder:

```powershell
npm ci
npm run demo
# Or configure .env and run your normal workspace:
npm start
```

The launcher builds and opens `dist\ash-tui.exe`; Bash, WSL and Unix commands are not required. Chat, colours, arrow keys, clickable controls and scrolling use the same terminal interface. Use a Unicode font such as Cascadia Mono. Mouse reporting depends on the terminal; keyboard controls remain available.

If PowerShell blocks the `npm.ps1` shim under its execution policy, use `npm.cmd ci`, `npm.cmd start`, or `npm.cmd run demo` instead. This does not require changing execution policy. Optional environment overrides use PowerShell syntax:

```powershell
$env:ASH_GO_BIN = 'C:\Program Files\Go\bin\go.exe'
$env:ASH_ANIMATION = 'false'
npm.cmd start
```

Windows CI builds the native executable, runs Node/Go tests, and checks the PowerShell backend lifecycle. The nginx TLS integration check runs on Linux.

## Layout

```text
ASH                         SIMULATION / CONNECTED
Chat   New task   Execution   Money   Replay   Browser   More

Conversation and compact task summary

Message Ash                                   Send
```

Buttons use their rendered width and consistent spacing; Tab and Enter provide keyboard access.
More opens the command palette, including actions that do not fit the current width.
The empty conversation’s Create a task button and the access dialog’s Get code,
Stop web and Back buttons are clickable. Details appear in the selected screen or dialog. The footer keeps short contextual
hints at the bottom; the Help view lists shortcuts. Agent search can also be clicked.

## Screens

### Dashboard

- Ash-grey conversation workspace with a compact task and budget summary in wide terminals.
- A persistent chat input below the conversation; click it or press `I` to focus.
- At narrow widths the conversation fills the dashboard; `4` opens the full task graph.
- Task progress updates from backend events while Ash answers.
- Press `:` to switch tasks or find a command; each task has its own conversation.

### Chat with Ash

Press **I**, type a message, and press **Enter**. **Alt+Enter** (or Ctrl+J) inserts a newline. **Esc** leaves the input so **M** opens Money, **R** opens Replay, and other dashboard shortcuts work. **PgUp/PgDn** or the mouse wheel scroll conversation history. Ordinary letters, including M/R/Q, remain text while the input is focused.

Chat uses the configured model and a snapshot of the active task's plan, phases, budget, pending approvals and recent events. Try “Why is this task waiting?”, “Explain my budget”, or “Help me plan a launch checklist”. `npm run demo` supplies clearly labelled sample replies; configure your model in `.env` for a full conversation. Messages and this limited task context are sent to that configured provider.

To turn a discussion into work, use `/task brief`, replacing `brief` with your agreed task description. For example:

```text
/task Create a launch checklist for my freelancer portfolio
```

This opens the existing task form with the brief filled in. Choose the budget and preferences, then submit. Chat itself does not execute jobs or approve payments. Failed model requests keep the draft for retry; a repeated request ID returns the saved turn without another model call.

Completed conversations are stored in `tasks/<task-id>/chat.json`; general chat without a task uses `chat.json` in the data directory. The latest 200 messages are retained, with a notice when older messages have been removed. The model receives a bounded recent conversation window. Drafts stay in memory while switching tasks, but unsent drafts do not survive an app restart. Known credentials and terminal control sequences are stripped from persisted messages and task context before it is encoded for the provider.

### New Task

Runtime form; no source changes.

- Description and explicit budget/currency.
- Optional deadline, quality requirements, preferred agents and private instructions.
- Strategy: plan-then-approve, autonomous, or DIY-first.
- External hiring, DIY-first and every-hire approval toggles.
- Maximum parallel jobs.
- `Ctrl+S` creates the task and asks the backend planner for a plan. Pause or finish a running task before creating another one.
- `Esc` cancels the form without writing anything.

If the strategy requires approval, the plan is shown and a pending approval is created. Open Security to approve it. If that request expires, press P to renew authorization for the same plan. Existing attempts, job IDs and escrow remain recorded; a plan that has started cannot be replaced.

### Market

- Search by skill/name/handle with `/`; Enter searches.
- Lists real/simulated agent name, price, payable rails, success rate and delivered jobs.
- Enter opens the selected agent's description in a modal.
- No agent, price or reputation is fabricated. Simulation is labelled in the header.

### Execution

- Actions for plan, execute, pause/resume, human review (pass/fail), cancel and receipts.
- Task summary and dependency tree with per-subtask phase.
- Live execution log from SSE, with scrolling and reconnect state.
- Errors and budget failures remain in the backend log and the Security/events panel.
- Cancelling requires the exact `CANCEL <task-id>` phrase.

### Transactions

- Verified receipt chain status, count and head.
- Receipt table with file, status, item, payment, agreed amount and hash prefix.
- Enter opens the receipt detail: task/subtask, vendor, planned/agreed, verification result and criteria, job id, hash, previous hash, timestamp and mode.
- If the chain is broken, the TUI does not present unverified receipts as verified.

### Security

- Receipt chain, engine, API auth, market mode, policy limits and recent events.
- Pending human gates with typed phrases.
- Enter approves the selected request; `D` denies it; the exact phrase is required.
- Explains that the backend authorizes financial actions and the TUI only displays results.

### Settings

- Redacted runtime configuration: model provider/model/key status, market URL/token status/mode, notifications, data directory.
- Editable task preferences: parallel jobs, hire approval, external hiring, DIY-first, strategy (before a plan), quality, deadline, private instructions and preferred agents.
- `B` starts the frontend, a second B displays the access code, and a third B stops it and revokes browser access without stopping CLI execution. Budget changes remain in Money and the command palette and require approval.
- Provider/model/market credentials are environment-backed; edit `.env` and restart Ash. Secrets are never shown.

## Keyboard

| Key | Action |
|---|---|
| `1`-`9` | Switch screen (numeric shortcuts remain available) |
| `Tab` / `Shift+Tab` | Next/previous screen (outside a form) |
| `H` / `L`, `←` / `→` | Previous/next screen |
| `I` | Focus chat on the dashboard |
| `N` | New task |
| `P` | Create/refresh plan for the active task |
| `E` | Execute the approved plan |
| `Space` | Pause/resume while in Execution |
| `V` / `F` | Human-review pass/fail when the verifier asks |
| `X` | Cancel task (typed phrase) |
| `B` | Start frontend → get code → close frontend |
| `A` | Security / approvals |
| `T` | Transactions |
| `3` | Market |
| `M` | Money timeline |
| `R` | Recorded-event replay |
| `S` | Settings |
| `F5` | Refresh current screen |
| `J` / `K`, `↑` / `↓` | Navigate lists/log |
| `Enter` | Open/approve/edit selected item |
| `D` | Deny selected approval |
| `?` | Help |
| `Q` / `Ctrl+C` | Quit; the managed backend is stopped |

Forms use `Tab`/`Shift+Tab` to move, `Enter` to advance, `Space` to toggle, `←`/`→` to change choices, and `Ctrl+S` to submit.

## Mouse

Where the terminal reports mouse events:

- click a tab;
- click an action button;
- click a task, agent, receipt or approval row;
- wheel to scroll the execution log or a list.

Keyboard remains fully functional if mouse reporting is unavailable. Bubble Tea restores the terminal on normal exit and recovered panic; `SIGKILL` cannot restore it.

## Approvals and payments

The TUI cannot approve a marketplace charge. For a plan, budget, hire, award or acceptance, it shows the pending request and asks you to type the exact phrase. The backend validates phrase, expiry, scope and plan/verification hash.

In standard marketplace mode, the market page still performs the funding/acceptance. Ash polls the real status and only records a ledger release after the market reports completion. Job submission is never treated as payment proof.

## Troubleshooting

### `Ash TUI is not built`

```bash
npm run build:tui
# or
ASH_GO_BIN=/path/to/go npm run build:tui
```

### TUI starts but API reconnects

- `ash server status --json`
- `ash doctor --json`
- inspect `$ASH_DATA_DIR/logs/server.log`
- confirm Node is on 20.11+ and the backend is bound to loopback.

### Session token errors

Stop and start Ash so a fresh token is written. Do not edit `server.json` by hand.

### Terminal looks broken after a crash

Run `reset` or open a new terminal. The next `ash` run starts in a clean alternate screen.

### Mouse does not work

Some terminals disable mouse reporting or require a setting. Use the keyboard shortcuts; the application is fully operable without a mouse.

## Terminal mission control

Run `npm start` for the ash-grey terminal workspace. It builds missing or stale backend/TUI artifacts when the toolchain is available. Without Go, the shared API text shell is used. Run `npm run demo` for an isolated simulation in a fresh private OS temporary directory. The normal planner, approval and engine flow runs first, then the terminal attaches to that same backend. Both modes leave frontend OFF until B. `--shell` explicitly selects the text shell.

The Execution screen shows a live dependency graph. Select a node with ↑/↓ or the mouse, then press Enter (or click) to inspect the deliverable path, criteria, verification, price, job and approval URL. Press G to switch to a dependency matrix: a filled cell means the row depends on the column. Phase labels and payment totals refresh from backend SSE events; a periodic state refresh recovers missed events. The activity sparkline counts actual events over the last minute.

On narrower terminals, panels stack and tabs become compact numbered targets. Mouse coordinates follow the visible layout. Arrow keys and Tab remain available when a mobile terminal does not forward mouse events. Set `ASH_ANIMATION=false` to disable the decorative live pulse. Q/Ctrl+C exits.

| Key / screen | Action |
|---|---|
| `:` or Ctrl+P | Searchable command palette, including task switching |
| 1 / Workspace | Conversation, task progress and budget summary |
| 4 / Execution | Graph/matrix and live events; Space pauses/resumes |
| M / Money | Actual ledger entries, paid/escrow trend graphs; Enter inspects an entry |
| R / Replay | Step through persisted events with ←/→; Space plays/pauses, Home rewinds |
| O | Export HTML proof, Markdown and redacted JSON on the backend host |
| 3 / Market, C | Pin/unpin up to three observed agents |
| 3 / Market, V | Compare pinned agents' actual price, success rate, delivery count and response time |
| 4 / Execution, V / F | Review the selected eligible subtask, with a typed pass/fail phrase |
| PgUp / PgDn | Scroll the execution log |
| ↑/↓ or wheel in a detail view | Scroll long evidence and receipt details |

Replay helps explain how a run reached its current state: step through when approvals were requested, escrow was funded, and verification passed or failed. It is a read-only event history, not a rerun or a reconstruction of unseen historical state. It never retries a payment. Task-changing commands in the palette are blocked while Replay is open. The selected event stays selected when newer events arrive; playback pauses with a notice if that event falls outside the loaded history. At most the newest 2,000 events are loaded, with an explicit truncation notice. Money trends are visual summaries; exact amounts remain visible in ledger rows. Unknown agent metrics remain unknown.

Proof HTML is a standalone, escaped, redacted local report. It records the chain verification result at export time; it is not independent blockchain settlement proof. Original receipt files remain the source for cryptographic verification. Exported reports still contain task details: review them before sharing.

## npm shortcuts

| Command | Purpose |
|---|---|
| `npm start` | Build as needed and open the terminal dashboard |
| `npm run demo` | Run the isolated simulation showcase |
| `npm run tui` | Open the TUI, requiring the Go binary |
| `npm run tui -- --remote` | Attach to `ASH_API_URL` with `ASH_API_TOKEN` |
| `npm run cli -- <command>` | Run any Ash command, such as `tasks`, `budget` or `approvals` |
| `npm run status` | Print the current task status |
| `npm run doctor` | Check runtime, model, market, API, TUI and receipts |
| `npm run verify` | Verify the original receipt chain |
| `npm run export` | Export the current task's proof reports |
| `npm run logs -- 100` | Print recent logs |
| `npm run server:start` / `server:stop` / `server:status` | Manage the backend |
| `npm run check` | TypeScript and Node tests |
| `npm run test:tui` | Go API-client and terminal UI tests |
| `npm run test:all` | Node, Go and TLS integration tests (nginx/OpenSSL required) |

The demo uses a fresh private OS temporary directory and ignores .env/provider credentials. `npm run demo -- --headless` executes the normal planner/approval/engine flow, verifies receipts and exits. The terminal opens for an interactive `npm run demo`; B starts the browser frontend, B again displays its code, and B again closes it.

The React browser frontend is separate from the CLI. See [FRONTEND.md](FRONTEND.md) for port 5050, the ash-grey themes, automatic globe and platform support.

## Buttons and task creation

The top row contains clickable **Chat**, **New task**, **Execution**, **Money**, **Replay**, **Browser**, and **More** buttons. **Tab** / **Shift+Tab** moves button focus outside text inputs; **Enter** selects. At narrow widths the row scrolls to the focused button. Number shortcuts, **M**, **R**, and the **B** browser toggle remain available outside inputs. **More** opens the searchable command palette with agents, receipts, approvals, settings and task switching.

**New task** opens a focused form for the outcome, budget and currency. **Options** reveals deadline, quality requirements, preferred agents, private instructions, strategy and hiring controls. Tab through fields or click them; the mouse wheel scrolls expanded options. **Plan task** sends the task to the existing planner for review. **Cancel** returns to the workspace without creating a task. `/task your brief` opens this same editable form. The default hiring approvals remain enabled.

The home screen keeps conversation primary; **Send** is clickable. **Confirm**, **Cancel**, **Close**, and scroll buttons are available in dialogs. More remains reachable in narrow terminals. Use **Execution** for the graph/matrix and event log. Unsent chat drafts and the existing accounting and approval safeguards retain their behavior.
