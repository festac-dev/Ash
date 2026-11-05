# Architecture

Ash now has two cooperating processes and one existing engine:

```
                    ┌──────────────────────────────┐
  keyboard / mouse  │  Go + Bubble Tea TUI          │
  ─────────────────►│  dashboards, forms, modals    │
                    │  screens, SSE client          │
                    └──────────────┬───────────────┘
                                   │ authenticated HTTP + SSE
                                   │ bearer token
                    ┌──────────────▼───────────────┐
  browser ─────────►│  Node.js Ash API + web UI     │
  (optional remote) │  state, tasks, approvals,     │
                    │  market, receipts, security   │
                    └──────────────┬───────────────┘
                                   │ in-process calls
                    ┌──────────────▼───────────────┐
                    │  Existing Ash engine          │
                    │  planner, ledger, marketplace │
                    │  verifier, receipts, store    │
                    └──────────────────────────────┘
```

The Node process remains the authoritative application. The Go TUI is a client: it can request an operation, but it never authorizes a payment, changes a ledger directly, or verifies a receipt itself.

## Processes

### Launcher

`src/launcher.ts` is the `ash` command:

- `ash` / `ash tui` ensures a healthy local backend exists, then starts the Go binary with `ASH_API_URL` and `ASH_API_TOKEN` in its environment.
- A backend started by the launcher is managed: it is stopped when the TUI exits.
- A backend already running in a healthy session is reused and left running.
- `ash server start` starts a detached backend.
- `ash server stop` calls the authenticated shutdown endpoint; it never signals an unrelated process.
- `ash server status`, `ash doctor`, `ash logs` provide headless diagnostics.
- `ash web` / `ash remote` starts or reuses the backend and prints the browser UI URL; `--open` opens the browser; enter the printed one-time code.
- `ash tui --remote` skips local backend startup and attaches the TUI to `ASH_API_URL` with `ASH_API_TOKEN`.
- Legacy read/write commands such as `ash status` and `ash verify` still use the original readline shell.

### Backend

`src/server/main.ts` loads the same `AppConfig` as the old CLI and starts:

- `src/server/server.ts` — HTTP routing, bearer/cookie authentication, web assets, body limits, SSE and shutdown.
- `src/server/auth.ts` — in-memory browser sessions, hashed, single-use login codes and login rate limiting.
- `src/server/service.ts` — task, plan, approval, market, receipt, security and settings operations.
- `src/server/event-bus.ts` — in-process fan-out to SSE clients.
- `frontend/` — React/Vite landing at `/` and private overview at `/workspace`; `web/` — full controls at `/workspace/controls` (`/console` alias).

The service wraps the existing `TaskStore`, `TaskPlanner`, `ExecutionEngine`, `TransactionLedger`, `ApprovalManager` and `MarketAdapter`. It does not reimplement budget arithmetic, verification or receipt hashing.

## Session discovery and authentication

On startup the backend:

1. The local launcher binds a private core API to an ephemeral loopback port. The separately toggled browser listener uses `ASH_SERVER_PORT`, default `5050`; direct/remote server launches use that configured port. A non-loopback bind requires `ASH_SERVER_ALLOW_REMOTE=true` and an explicit token.
2. Generates a 32-byte session token with `crypto.randomBytes` unless `ASH_SERVER_TOKEN` is supplied for automation or remote operation.
3. Writes `${ASH_DATA_DIR}/server.json` with the connect URL, public UI URL, PID and bearer token, mode `0600`. One-time codes are never written to this file.
4. Requires `Authorization: Bearer <token>` (TUI/scripts) or a valid browser cookie (web UI) on protected `/api/*` requests.
5. Accepts the configured public origin, the request's own origin, or loopback aliases with the same port; cross-port loopback origins are rejected. Cookie mutations require `X-Ash-Client: web`.
6. Removes its session file on graceful shutdown; browser sessions live only in memory.

Tokens are never placed in URLs, logs, receipts or browser output. The TUI receives them in its process environment. `ash web --open` displays a separate single-use code in the requesting terminal. The browser submits it by POST; codes never appear in URLs. Remote access uses an SSH tunnel or an explicitly configured HTTPS proxy.

## HTTP API

The surface is deliberately small and task-oriented:

| Area | Endpoints |
|---|---|
| Health | `GET /api/health` |
| State | `GET /api/state`, `GET /api/dashboard` |
| Tasks | `GET/POST /api/tasks`, `GET /api/tasks/:id` |
| Planning/execution | `POST /api/tasks/:id/plan`, `execute`, `pause`, `resume`, `activate` |
| Human gates | `GET /api/approvals`, `POST /api/tasks/:id/approve`, `deny`, `review`, `cancel`, `budget` |
| Marketplace | `GET /api/market`, `/api/agents?query=`, `/api/jobs` |
| Evidence | `GET /api/transactions`, `/api/receipts/:file`, `/api/security` |
| Configuration | `GET /api/settings`, `POST /api/tasks/:id/settings` |
| Live | `GET /api/events` (SSE) |
| Lifecycle | `POST /api/admin/shutdown` |

Every mutation validates its body and delegates to the backend service. Errors use a typed JSON envelope and never include secrets.

## Browser UI

`frontend/` is the React/Vite frontend at `/`, with a lazy-loaded React Three Fiber globe and backend-derived events. `npm run build:web` builds and prerenders it, compresses public assets and copies the legacy HTML/CSS/JS controls from `web/` to `/console`. The TUI B control starts/stops an independent loopback browser listener without stopping the core API.

- Login redeems a single-use code (or a compatible configured token) by POST for an `HttpOnly; SameSite=Strict` cookie. HTTPS sessions use Secure cookies; credentials are not stored by the page.
- The UI renders with DOM text nodes rather than HTML injection, uses a strict Content-Security-Policy, and sends `X-Ash-Client: web` on mutations.
- It can create tasks, plan, approve/deny with exact phrases, execute/pause/resume/cancel, inspect market agents/jobs, browse receipts, view security state and edit allowed task preferences.
- It cannot edit credentials, approve a marketplace payment page, move funds or bypass the backend's budget and receipt rules.

## Live updates

`GET /api/events` is authenticated SSE:

- an initial `ready` event;
- engine events from `ExecutionEngine.onEvent`;
- `refresh` events after API mutations;
- a heartbeat comment every 15 seconds.

The Go client reconnects with exponential backoff and reports a disconnect in the UI. It also polls `/api/state` every five seconds, so a temporary SSE interruption never hides the authoritative state.

## TUI architecture

`tui/` is a Go module using Bubble Tea's Elm architecture:

- `main.go` — reads API session from the environment, starts the program with alt-screen and mouse reporting.
- `internal/api` — HTTP/SSE client and JSON contract types.
- `internal/ui/model.go` — `Model`, `Init`, `Update`, screen transitions, modal state and async `tea.Cmd` requests.
- `internal/ui/forms.go` — task form with Bubbles text inputs/textarea.
- `internal/ui/views.go` — Lip Gloss layout, panels, tables, log viewport, progress, modals and click hitboxes.
- `internal/ui/styles.go` — visual system: ash-grey, black and white, with restrained status accents, borders and focus states.
- `internal/ui/settings.go` — editable task preferences.

Bubbles components used: text input, textarea, viewport, spinner, help, paginator-style custom list windows and progress. Lip Gloss supplies borders, padding, layout and responsive panels. Mouse clicks target tabs, action buttons, agent rows, receipt rows and approvals; the wheel scrolls the active list or log. Keyboard navigation remains complete without a mouse.

## State and recovery

The TUI holds only view state: active screen, form contents, cursors, modal input and the last received snapshot. Durable state stays in the Node data directory:

```
ASH_DATA_DIR/
├── server.json                  # local API session (0600)
├── tasks/<id>/task.json
├── tasks/<id>/ledger.json
├── tasks/<id>/approvals.json
├── tasks/<id>/events.jsonl
├── transactions/Ash_*.json
├── logs/ash.log
├── logs/audit.log
└── logs/server.log
```

- The existing atomic writes, task/ledger locks and engine lease remain unchanged.
- A TUI exit does not erase state.
- A backend crash shows a reconnect state; the launcher can restart it on the next `ash` run.
- A duplicate `ash` invocation reuses a healthy session instead of starting a second engine.
- Receipts are still appended exactly once per task/subtask and verified before append.

## Financial boundary

The Go client can display approvals and submit the typed phrase, but the decision is recorded by `ApprovalManager` in the Node process. In standard marketplace mode the external market page still performs the actual charge and acceptance. The TUI has no wallet, no private key, no withdrawal operation and no direct market token.

## Compatibility

- Node 22.13+ is required.
- Go 1.25+ is required to build the TUI; without it, the launcher falls back to the shared API text shell.
- Existing task and receipt formats remain valid. Simulation now requires explicit ASH_DEMO=1; one-time-code login replaces URL tickets.
- `npm run build` builds the backend, browser frontend and, when Go is available, the TUI. `npm start` builds only stale backend/TUI artifacts; the browser builds on first launch.

## November 2026 hardening

The existing TypeScript engine, repositories, provider interfaces and Go/React clients
are retained. `src/providers/runtime.ts` is the composition root choosing real versus
simulated model/market adapters. `src/demo/runtime.ts` creates an isolated temporary
configuration and drives the same services; the engine does not gain a parallel mock
implementation. A data-directory mode marker prevents accidental live/demo mixing.

`src/server/auth.ts` stores only a one-time-code hash; `frontend.ts` owns the dedicated
listener or a logical browser gate on the standalone listener. Local-only frontend
administration is separate from browser task authority. `health.ts` provides cached,
bounded storage readiness. `src/cli/commands.ts` centralizes contextual help/completion;
`headless.ts` serializes service data directly rather than scraping terminal output.
The browser's CanvasGlobe fallback projects the same network when WebGL is unavailable.

No database replacement, framework rewrite, queue, multi-instance coordinator or
new production dependency was introduced. Deployment deliberately uses one process
with persistent local files and quiesced backups.

## Shared terminal and browser lifecycle

`npm start` starts/reuses one backend and attaches either Go TUI or `src/cli/api-shell.ts`.
The text shell calls the same authenticated API as the browser; fallback no longer
creates a second engine. Demo first runs its isolated normal service flow and then
attaches that terminal to the existing in-process backend. Headless demo exits.

The server owns the B sequence through `/api/frontend/cycle`. Its `next_action` is
start, code, or stop. Frontend access mutations are serialized by rejecting overlap;
code issuance remains local and bearer-only. Stop revokes browser sessions/codes.
The shared frontend formatter is used by commands and the text shell.
