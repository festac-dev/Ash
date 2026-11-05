# Architecture Audit

Historical architecture snapshot from the initial client/server migration. For the current frontend, process ownership and review results, see [ARCHITECTURE.md](../ARCHITECTURE.md), [FRONTEND.md](../FRONTEND.md) and [CODE_REVIEW.md](CODE_REVIEW.md).

Date: 2026-11-03
Repository: Ash
Scope: audit before adding the Go/Bubble Tea terminal client and the Node HTTP backend.

## Executive summary

Ash today is a single Node.js 20+ TypeScript application. It already contains the hard parts: task sessions, model-backed planning, budget enforcement, marketplace discovery and negotiation, approval gates, deliverable verification, restart-safe execution and a SHA-256 receipt chain. Its current interface is a custom ANSI/readline command shell.

The requested Go + Bubble Tea client and the client/server split do not exist yet. The existing engine must therefore be wrapped by an authenticated local HTTP/SSE service, and the Go client must consume that service rather than reimplement financial or execution rules.

No existing business logic should be rewritten merely to fit the new interface. The existing readline shell remains available as the headless/legacy fallback.

## Repository and runtime

| Item | Finding |
|---|---|
| Language | TypeScript, ESM, strict compiler settings |
| Runtime | Node.js >= 20.11 (tested on Node 24) |
| Package manager | npm |
| Existing dependencies | `@modelcontextprotocol/sdk`, `zod`; dev: TypeScript, `tsx`, Node types |
| Entry point | `src/index.ts` -> `src/cli/app.ts` |
| Persistence | JSON/JSONL files under `ASH_DATA_DIR`, atomic writes and file locks |
| Database/server/daemon | None |
| Go toolchain | Not installed in the audit environment; installed locally for this implementation and build verification |
| Test runner | Node's built-in `node:test` through `tsx --test` |

## Existing and working

### Configuration

- `src/config.ts` loads `.env` without overriding shell variables.
- Strict validation for model provider, market URL/mode, data directory, colour/Unicode, parallel limits, approval TTL, contingency and verification allowlist.
- Secrets are loaded from environment variables or `*_FILE` files and registered with the redactor.
- Optional Telegram notification settings were added in the previous change.

### Task sessions and planning

- Dynamic `TaskInput` includes description, budget, currency, deadline, quality requirements, preferred agents, strategy, external hiring, DIY preference, approval policy, parallelism, instructions and project workstreams.
- Six workstream templates (`realworld`, `business`, `security`, `privacy`, `swarms`, `social`) are planning scopes in one project.
- `TaskPlanner` asks a configurable OpenAI-compatible model for a JSON plan and validates it through `validatePlan`.
- Plan validation covers currency, budget, reserve, duplicate ids, unknown dependencies, cycles, DIY/external pricing, allowed acceptance criteria and shell-command allowlisting.
- The deterministic demo model is available only in simulation mode.

### Execution engine

- `ExecutionEngine` is a persisted state machine with a per-task lease, dependency readiness, parallel slots and restart reconciliation.
- It supports DIY work, direct marketplace hires, board jobs with bids, one counter-offer, status polling, deliverable retrieval, revision, human review, acceptance and finalization.
- It does not approve or move money inside standard MCP calls; the market page remains the payment authority.
- Failed, cancelled, rejected and walked-away work still produces a receipt.

### Budget and approvals

- `LedgerRecord` is append-only with integer minor units and derived totals.
- Commits, releases, refunds and budget adjustments enforce invariants.
- `ApprovalManager` creates expiring, scoped approval requests with typed confirmation phrases.
- Plan, budget, hire, board award, acceptance and in-call spend gates are implemented.
- Standard MCP mode returns market pages for funding/acceptance; Ash cannot click them.

### Marketplace integration

- `McpMarketAdapter` connects over Streamable HTTP, discovers tools through `tools/list`, filters a buyer-only allowlist, validates arguments against advertised schemas, normalizes responses and limits retries/rate.
- `SimulatedMarketAdapter` provides a clearly labelled durable simulation.
- Wallet, transfer, payout and key tools are rejected by the allowlist.
- Discovery ranks agents by price, payable rail, reputation, relevance and suspicious claims.

### Verification and receipts

- Deterministic checks, optional model review, prompt-injection scanning, revision and human review are implemented.
- External deliverable fetch is HTTPS-only with address pinning, redirect validation and size limits.
- `TransactionLedger` writes one file per subtask, verifies hashes and previous links, handles filename collisions atomically and never overwrites a receipt.
- `.chain-head.json` provides a local tail-deletion witness.
- `verify` reports exact files and never repairs.

### Existing interface

- Custom ANSI renderer, boot checks, dashboard, plan tree, budget bars, tables, coloured prompt, ASCII/no-colour fallback.
- Readline command loop with natural-language task entry.
- Background engine with command availability while running.
- Non-TTY command-script mode used by tests.

## Existing but incomplete

| Area | Gap |
|---|---|
| Remote/API access | No HTTP API, session token, SSE or headless server. |
| Multi-client support | One CLI process owns the engine; no shared backend for additional clients. |
| Mouse interaction | None; readline shell is keyboard-only. |
| Structured screens | Dashboard is rendered text; no focusable components, modals, pagination or search UI. |
| Runtime settings | Providers, model and market credentials are environment-only; only task preferences can be changed live. |
| Workstream execution | Six workstreams are planning scopes, not shipped provider products. |
| OAuth | The market's browser consent flow is not implemented; a bearer token is supplied. |
| Receipt anchoring | Hash chain is locally witnessed, not externally signed or anchored. |
| Telegram verification | Unit-tested with a fake transport; no real bot/chat credentials in this environment. |

## Missing

- Go/Bubble Tea/Lip Gloss/Bubbles frontend.
- Authenticated localhost HTTP server.
- Session token generation and protected endpoints.
- SSE live updates with reconnection.
- Backend lifecycle management (`server start|stop|status`), duplicate prevention, `doctor`, `logs`.
- Mouse support and terminal state restoration for a full-screen TUI.
- Go unit tests and API integration tests for the new surface.
- Documentation for the new TUI/API.

## Broken or risky

| Finding | Severity | Action |
|---|---|---|
| No Go toolchain in the base environment | Build-time only | Build script detects Go and reports a clear message; launcher falls back to legacy shell when the TUI binary is absent. |
| Existing CLI owns the engine in-process | Architecture | Add a server that owns the engine; legacy mode remains unchanged. |
| API could expose financial actions | Security | Authenticate every API request; revalidate all financial rules in the backend service; never move authorization into the TUI. |
| Token in session file | Security | Localhost only, file mode `0600`, token generated with `crypto.randomBytes`, never logged or placed in URLs. |
| Settings mutation at runtime | Scope | Expose safe task-preference changes; provider/credential changes remain environment + restart. |
| Duplicate engine processes | Reliability | Server session file + `/api/admin/shutdown`; launcher reuses a healthy backend and never kills unrelated processes. |
| Engine events only reach the current shell | UI | Add an event bus and SSE stream; the engine callback publishes events. |

## Proposed changes

1. **Backend service layer** (`src/server/service.ts`) that wraps the existing store, planner, engine, ledger, approvals, marketplace and receipt ledger. No financial rule is duplicated.
2. **Authenticated HTTP server** (`src/server/server.ts`, `src/server/main.ts`) on `127.0.0.1` with:
   - session token and `server.json` discovery file;
   - JSON endpoints for state, tasks, plan, approvals, market, agents, transactions, receipts, security and settings;
   - SSE `/api/events`;
   - body limits, origin checks, timeouts and redacted errors;
   - `/api/admin/shutdown`.
3. **Launcher** (`src/launcher.ts`) for `ash`, `ash tui`, `ash server start|stop|status`, `ash doctor`, `ash logs`, `ash --version`, and legacy command passthrough.
4. **Go TUI** under `tui/` using Bubble Tea, Lip Gloss and Bubbles:
   - Elm model/update/view;
   - dashboard, task creation, marketplace, execution, transactions, security and settings screens;
   - keyboard, mouse click/wheel, focus, tabs, modals, search, viewport, progress, spinner, help, pagination;
   - SSE client with reconnect and disconnect status.
5. **Build integration** (`scripts/build-tui.mjs`) producing `dist/ash-tui` when Go is available.
6. **Tests and documentation**: Node API tests, Go model/client tests, architecture, API, security, development and TUI guides.

## Compatibility rules

- Existing `npm run dev`, `npm test`, `npm run typecheck` and `npm run build` remain valid.
- Existing readline commands remain available for headless use and as a fallback.
- The engine, ledger, approvals and receipts remain backend-owned.
- A TUI action is only an authenticated request; it is never proof that a payment or verification succeeded.
- No fake marketplace data is introduced outside the existing explicitly simulated adapter.

## Baseline checks

Before this work, the repository passed:

- `npm run typecheck`
- `npm test` (62 tests)
- `npm run build`

These are re-run after the changes.

## Post-audit status

Implemented in this change:

- authenticated loopback HTTP API with task, approval, market, receipt, security, settings, SSE and shutdown routes;
- launcher lifecycle (`ash`, `ash tui`, `server start|stop|status`, `doctor`, `logs`) with managed/detached backends and session discovery;
- Go Bubble Tea client with Lip Gloss/Bubbles screens, keyboard and mouse navigation, modals, live SSE log, task form, receipts, approvals and settings;
- Go API/client/model tests, Node API/SSE tests and build integration;
- optional remote binding, browser session authentication, CSRF enforcement, one-time login tickets and a dependency-free web command centre served by the backend;
- architecture, API, remote, security, development and TUI documentation.

Still partial or environment-backed:

- provider/model/market credential editing stays in `.env` and requires a restart;
- remote deployments rely on the operator to terminate TLS and protect `ASH_SERVER_TOKEN`; Ash does not provide its own public TLS server;
- real marketplace settlement and a real Telegram bot still require external credentials and human approval;
- the six workstreams remain planning scopes, not shipped provider products.
