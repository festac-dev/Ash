# Architecture

Ash has a Node.js backend that owns the engine and persists everything to disk, plus a Go Bubble Tea terminal client. The launcher starts/reuses the authenticated localhost API, and the legacy readline shell remains available headlessly. See [ARCHITECTURE.md](ARCHITECTURE.md) for the client/server design; this document describes the backend engine and legacy shell.

## Module map

```
src/
├── index.ts                  entry point / launcher routing
├── launcher.ts               ash, tui, server, doctor and logs commands
├── config.ts                 strict environment parsing, .env loader
├── errors.ts                 typed error codes and hints
├── logger.ts                 structured file logs + audit log + redaction
├── tracks.ts                 one Ash project, six workstreams, gates and input validation
├── report.ts                 Markdown/JSON task report export
├── notify.ts                 optional Telegram Bot API notifier (best-effort, never blocks work)
├── server/
│   ├── main.ts               standalone API process
│   ├── server.ts             HTTP auth, routes, SSE and shutdown
│   ├── service.ts            API operations over the existing engine
│   └── event-bus.ts          in-process event fan-out
├── cli/
│   ├── app.ts                command loop, approvals, execution control
│   ├── services.ts           dependency wiring and startup checks
│   ├── wizard.ts             dynamic task/budget setup
│   ├── splash.ts             animated/static boot sequence
│   ├── dashboard.ts          dashboard, plan tree, budget views
│   ├── components.ts         panels, tables, wrapping
│   ├── theme.ts              colour/Unicode/terminal detection, gradients
│   └── logo.ts               custom Ash emblem and ASCII fallback
├── domain/
│   ├── types.ts              task, plan, ledger, approval, receipt types
│   ├── schemas.ts            Zod schemas for every persisted record
│   └── plan.ts               plan validation, cycles, readiness, budget math
├── state/store.ts            task sessions, atomic writes, locks, events
├── ledger/ledger.ts          integer-minor budget ledger and invariants
├── transactions/ledger.ts    receipt writer, SHA-256 chain, integrity report
├── security/
│   ├── approvals.ts          expiring typed-phrase approval records
│   └── guard.ts              MCP allowlist, subprocess/artifact/SSRF guards
├── ai/
│   ├── model.ts              configurable model adapter + demo model
│   ├── prompts.ts            planner/worker/verifier prompts
│   ├── planner.ts            model → validated budget-safe plan
│   ├── worker.ts             DIY artifact generation and confinement
│   └── verifier.ts           deterministic + model + human verification
├── market/
│   ├── types.ts              normalized marketplace interface
│   ├── mcp-adapter.ts        real MCP Streamable HTTP client
│   ├── simulated-adapter.ts  durable, clearly labelled simulation
│   ├── normalize.ts          response normalization helpers
│   ├── discovery.ts          agent filtering and ranking
│   └── negotiation.ts        one counter-offer per vendor
└── engine/engine.ts          execution state machine and recovery

tui/                          Go + Bubble Tea/Lip Gloss/Bubbles client
scripts/build-tui.mjs         optional Go build/test helper
```

The model, marketplace and CLI are replaceable behind interfaces. The engine depends on `MarketAdapter` and `ModelAdapter`, not on concrete network providers.

## One project, six workstreams

Ash's hackathon scope is a single project defined in `src/tracks.ts`. The six workstreams are not separate hardcoded apps and not separate project profiles: they are selectable scopes inside one project (`track_id: "ash"`, with `project_scopes` recording the selected workstreams). Each workstream defines a build order, approval gate, required runtime inputs (validated for network, account format, percentage totals, fail-safe policy, etc.) and constraints. Project inputs use the `workstream.key` form so two workstreams cannot overwrite each other's values.

The CLI asks which workstreams a task covers (default: all six), collects the corresponding values, stores them on the task, and injects the combined template into the planner prompt. Plan installation validates that each selected workstream has its labelled `human_approval` criterion. The planner must place it before dependent gated work and must not claim mocks or testnet plans as evidence. Actual workstream implementation remains future work with its own provider credentials and approvals. Tasks created by earlier versions with a single workstream id remain readable and resolve to that workstream.

## Data flow

```
human ──► wizard/task input ──► TaskStore (task.json + ledger.json)
                                     │
                                     ▼
                              TaskPlanner (model)
                                     │ validated Plan
                                     ▼
                          plan approval (human or autonomous)
                                     │
                                     ▼
┌───────────────────────── ExecutionEngine ─────────────────────────┐
│ readiness → DIY worker / agent discovery → budget check           │
│ → approval gate → MCP hire → poll job → fetch deliverable         │
│ → verifier (deterministic + model) → revision or human review     │
│ → acceptance approval → MCP acceptance page → poll completed      │
│ → ledger release → TransactionLedger.record() → next subtask      │
└───────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                 tasks/<id>/deliverables, transactions/Ash_*.json
```

## Execution state machine

Each subtask persists one phase:

| Phase | Meaning |
|---|---|
| `pending` | Waiting for dependencies |
| `ready` | Dependencies satisfied; eligible for a slot |
| `running_diy` | Local model producing artifacts |
| `discovering` | Searching/ranking marketplace agents |
| `awaiting_hire_approval` | Local human approval request pending |
| `preparing_draft` | Calling `prepare_job` / `create_job` |
| `awaiting_market_approval` | Draft awaiting the human on the market page |
| `waiting_bids` | Public board posting collecting bids |
| `awaiting_market_award` | Award page returned; waiting for assignment |
| `waiting_job` | Market job funded; polling for delivery |
| `verifying` | Deliverable stored; checks running |
| `awaiting_human_review` | Verifier needs a human decision |
| `awaiting_acceptance_approval` | Verified; local acceptance approval pending |
| `awaiting_market_acceptance` | Acceptance page returned; waiting for market completion |
| second attempt | One revision round for the same job; the market job id is reused |
| `completed`, `failed`, `cancelled`, `blocked` | Terminal |

Task states: `draft`, `planned`, `awaiting_plan_approval`, `executing`, `paused`, `completed`, `failed`, `cancelled`.

The engine tick:

1. Loads the task and recomputes readiness from the dependency graph.
2. Marks dependants of failed subtasks `blocked`.
3. Lets active phases check their timers; new `pending`/`ready` work gets only free parallel slots.
4. Runs at most one operation per subtask at a time (`inflight` map).
5. Finalizes the task when every subtask is terminal.

## Persistence and recovery

```
ASH_DATA_DIR/
├── tasks/<task-id>/
│   ├── task.json            plan, subtask phases, attempts, vendor/job ids
│   ├── ledger.json          append-only budget entries
│   ├── approvals.json       expiring approval requests and decisions
│   ├── events.jsonl         append-only execution timeline
│   ├── engine.lock          execution lease with heartbeat
│   ├── deliverables/        verified text artifacts
│   └── reports/
├── workspaces/<task>/...    confined DIY artifacts
├── transactions/            receipts + chain head
├── logs/                    ash.log, audit.log
└── cache/                   market/simulation cache
```

- **Atomic writes**: temp file + fsync + rename; exclusive creation uses an atomic hard link where supported.
- **Optimistic task updates**: `TaskStore.update` takes a per-task file lock, reloads the latest task, applies the mutation, validates the full schema and writes.
- **Ledger writes**: separate lock; the mutator receives the latest ledger and the result is revalidated.
- **Engine lease**: only one process advances a task. The lock has a heartbeat; an old lease can be reclaimed only after its local owner is confirmed dead. A live owner is never displaced merely because its heartbeat is old.
- **Restart**: a funded job remains `waiting_job`; the new process polls the same job ID. A draft remains `awaiting_market_approval`; the same `client_request_id` replays it. A stored deliverable is re-verified rather than re-fetched.
- **No duplicate payments**: receipt writes are idempotent per `(task, subtask)`; ledger releases/refunds check for an existing entry with the same job reference; MCP hire retries use a persisted idempotency key.
- **No duplicate receipts**: the transaction writer checks the chain and returns an existing receipt for a replayed key.

## Budget model

`LedgerRecord` is append-only:

```
AUTHORIZE(amount)
COMMIT(amount, job ref)          committed += amount
RELEASE(amount, job ref)         committed -= amount; paid += amount
REFUND(amount, job ref)          committed -= amount; refunded += amount
ADJUST_UP / ADJUST_DOWN          authorized changes, with approval_ref
```

Derived available = `authorized - committed - paid`. Totals are recomputed from entries on every load. The engine checks the ledger and the market balance separately before preparing a hire, then commits exactly the funded amount.

## Marketplace integration

`McpMarketAdapter`:

- connects with the SDK’s Streamable HTTP transport and a bearer token;
- discovers all tools via `tools/list` (with pagination);
- filters through the buyer allowlist and refuses wallet operations;
- maps normalized suffixes such as `prepare_job`, `get_draft_status`, `get_job_status`, `get_job_result`, `accept_result`, `post_job`, `list_bids`, `award_bid`;
- validates arguments against the tool’s advertised schema and refuses to guess capabilities;
- normalizes responses and preserves raw payloads where useful;
- uses a token-bucket rate limiter and bounded retries.

`SimulatedMarketAdapter` implements the same interface without a socket. It generates agents, drafts, bids and deliverables, persists state in `cache/sim-market.json`, and marks every operation `simulated`. It is used by tests and `ASH_DEMO=1`.

Direct hiring uses `prepare_job` and a draft page. Board hiring posts a public job, waits for bids, can make one counter-offer, then uses `award_bid` and the human award page. In both cases the market page remains the money-moving authority.

## Verification pipeline

1. Validate the stored delivery path; never read outside the data directory.
2. Scan for prompt injection and control characters.
3. Run deterministic criteria: presence, required terms, JSON validity, confined file existence, optional allowlisted commands.
4. Ask the model to judge only `llm_review` criteria, with the deliverable delimited as untrusted data.
5. If anything fails: request one revision for the same job, or stop and record `REJECTED`/`ESCROWED`.
6. If anything is ambiguous or flagged: stop at `awaiting_human_review`; the human uses `review <id> pass|fail`.
7. Only a passed verification can lead to an acceptance approval.

## CLI

The CLI is a custom renderer over ANSI, not a full-screen TUI framework. It detects TTY, colour, Unicode and width, then chooses panels, gradients or ASCII fallbacks. The engine runs in the background; commands remain available, and engine events are persisted before being printed. Non-TTY input is read as a command script, which keeps CI and tests deterministic.

## Design trade-offs

- **No database**: JSON files with locks and atomic writes are easy to inspect, back up and audit. This is appropriate for one operator and one active engine per task.
- **Explicit process ownership**: closing a TUI stops the backend it started. An attached TUI leaves an existing backend running. `ash server start` and `ash web` start a detached backend; stop it with `ash server stop`.
- **Model-agnostic**: any OpenAI-compatible endpoint works; there is no trainer or fine-tune dependency.
- **Conservative money**: standard `/mcp` cannot spend inside calls, so full autonomy stops at the human market page. That is intentional and documented.

The task ledger is authoritative for budget recovery if a task snapshot lags an approved ledger write. Shared locks do not evict live owners. Funding evidence is saved before escrow accounting or pause/cancel checks, and unresolved funding blocks resumed execution. Gate presence is validated structurally; semantic build-order compliance still needs human plan review. Older persisted plans are not silently rewritten.
