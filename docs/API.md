# API

The Ash backend is an HTTP service owned by the Node process. It binds to loopback by default and can be exposed deliberately with remote mode. It is started by `ash`, `ash web`, `ash server start`, or directly with `node dist/server/main.js`.

## Base URL and authentication

- Default local launcher: `127.0.0.1`, private ephemeral API port; browser listener on `ASH_SERVER_PORT` (default `5050`). Direct/remote server launches use the configured port.
- The launcher writes `$ASH_DATA_DIR/server.json` (mode `0600`) with `url`, `port`, `pid`, the session token, and the public UI URL. One-time codes are never stored in this file.
- Every protected `/api/*` request needs either:

```http
Authorization: Bearer <session-token>
```

or a browser session cookie obtained from `POST /api/auth/login`.

Bearer authentication is the default for the TUI, scripts and remote API clients. Browser authentication is a convenience for the bundled web UI: a code or compatible token is exchanged once for an opaque `HttpOnly; SameSite=Strict` cookie, and every mutating cookie request must also send:

```http
X-Ash-Client: web
```

That custom header forces a CORS preflight cross-origin and prevents CSRF. The token itself is never stored in the cookie. Login attempts are rate-limited, and sessions expire after 12 hours.

The TUI receives `ASH_API_URL` and `ASH_API_TOKEN` from the launcher. For scripts, use those environment variables rather than copying the token into a URL. The browser UI is served at `/` when `ASH_SERVER_UI=true`.

```bash
ASH_API_URL="$(node -p 'require(process.env.ASH_DATA_DIR + "/server.json").url')"
ASH_API_TOKEN="$(node -p 'require(process.env.ASH_DATA_DIR + "/server.json").token')"
printf 'Authorization: Bearer %s\n' "$ASH_API_TOKEN" | curl -sS --header @- "$ASH_API_URL/api/state"
```

Do not put the token in shell history, a URL, a screenshot, or a receipt.

## Response conventions

Success responses are JSON. Errors use:

```json
{
  "error": {
    "code": "BUDGET_EXCEEDED",
    "message": "Commitment of 60.00 USDC exceeds the authorized budget.",
    "hint": "Raise the budget with approval or reduce the plan."
  }
}
```

Status codes: `400` validation, `401` missing/invalid session token, `403` approval/unsafe operation or rejected origin, `404` unknown record, `409` conflict/budget invariant, `429` login/rate limit, `503` unavailable provider, `500` unexpected failure.

Bodies are limited to 1 MiB. All financial checks run again in the backend service; an API caller cannot bypass them.

## Browser authentication

### `POST /api/auth/login`

Public (rate-limited by client address). Provide exactly one credential:

```json
{ "token": "<ASH_SERVER_TOKEN>" }
```

or the one-time code printed by `ash frontend on`, `ash frontend code`, or the second B:

```json
{ "code": "<single-use code>" }
```

The older `ticket` field is also accepted for compatibility. HTTPS adds the Secure cookie flag.

Success sets `Set-Cookie: ash_web=...; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200` and returns `{ "ok": true, "method": "cookie", "expires_at": "...", "mode": "LIVE" }`. A wrong token, used ticket or expired ticket returns `401`. The ninth attempt from one address within a minute returns `429` until the window clears.

### `GET /api/auth/session`

Returns `{ "authenticated": true, "method": "cookie", "expires_at": "...", "mode": "..." }` for a valid bearer token or cookie, otherwise `{ "authenticated": false }`.

### `POST /api/frontend/code`

Local bearer-authenticated callers can request a fresh `{code, expires_at}` while the frontend is ON. The code is displayed only in the requesting terminal, never in URLs or persisted files. Issuing a new code invalidates the previous code. See the frontend administration reference below.

### `POST /api/auth/logout`

Revokes the cookie session and sends a clearing cookie. It never revokes the long-lived `ASH_SERVER_TOKEN`.

## Health

### `GET /api/health`

```json
{
  "ok": true,
  "service": "ash",
  "version": "1.1.0",
  "pid": 1234,
  "started_at": "2026-11-03T11:00:00.000Z",
  "mode": "SIMULATION"
}
```

## State

### `GET /api/state` / `GET /api/dashboard`

Returns the authoritative snapshot used by the TUI:

- server status, mode and engine state;
- active task with plan, subtask attempts and phases;
- latest task summaries;
- ledger totals as decimal strings;
- marketplace connection and balance;
- pending approvals;
- recent engine events;
- recent receipts and chain integrity;
- redacted public configuration.

### `GET /api/tasks`

```json
{ "tasks": [ { "id": "task_...", "status": "planned", "budget": "150.00", "currency": "USDC" } ] }
```

### `POST /api/tasks`

Creates a separate task session and ledger. Required: `description`, explicit `budget`, `currency`. Optional fields match `TaskInput`.

```json
{
  "description": "Build a production-ready website with auth and tests",
  "budget": "150.00",
  "currency": "USDC",
  "execution_strategy": "plan_then_approve",
  "allow_external": true,
  "diy_first": true,
  "require_hiring_approval": true,
  "max_parallel_jobs": 3,
  "deadline": null,
  "quality_requirements": "Must pass the provided tests",
  "preferred_agents": [],
  "additional_instructions": null
}
```

Track-backed tasks may supply `track_id: "ash"`, `project_scopes`, and `track_inputs`; the same validation as the legacy wizard applies.

### `GET /api/tasks/:id`

Returns one task. Prefix references are resolved by the store.

### `POST /api/tasks/:id/plan`

Asks the configured model for a validated plan, installs it, and either auto-accepts it for the autonomous strategy or creates a plan approval request.

```json
{
  "task": { "id": "task_...", "status": "planned" },
  "approval": null,
  "plan_summary": "A dependency-ordered plan..."
}
```

If an approval is required, `approval.id` is present and the task remains `awaiting_plan_approval`.

### `POST /api/tasks/:id/execute`

Starts the backend engine. Requires a plan and a plan approval unless the task is autonomous. It refuses if another execution is running.

### `POST /api/tasks/:id/pause` / `resume` / `activate`

- `pause` sets the task paused and stops the engine.
- `resume` sets it executing and starts the engine.
- `activate` makes another task the active session; it is refused while the engine is running.

### `POST /api/tasks/:id/cancel`

Requires the exact phrase `CANCEL <task-id>`:

```json
{ "phrase": "CANCEL task_20261103T..." }
```

It does not call the marketplace cancel tool. Funded escrow remains for human resolution.

## Approvals

### `GET /api/approvals`

Returns pending approvals for the active task.

### `POST /api/tasks/:id/approve`

```json
{
  "approval_id": "apr_...",
  "phrase": "APPROVE apr_..."
}
```

The backend verifies the exact phrase, expiry, plan hash (for plan approvals) and budget scope. An API caller can submit the phrase only if it has the session token; the TUI still requires the human to type it.

### `POST /api/tasks/:id/deny`

```json
{ "approval_id": "apr_...", "phrase": "DENY apr_..." }
```

### `POST /api/tasks/:id/budget`

Requests a budget change; the ledger is not changed until the resulting approval is approved.

```json
{ "amount": "175.00", "currency": "USDC" }
```

### `POST /api/tasks/:id/review`

For a deliverable in `awaiting_human_review`:

```json
{
  "subtask_id": "st_2",
  "decision": "pass",
  "phrase": "REVIEW st_2 PASS",
  "note": "Inspected the stored artifact."
}
```

## Marketplace

### `GET /api/market`

Returns connection mode, endpoint, tools, balance and whoami. It never returns the market token.

### `GET /api/agents?query=security`

Returns the real/simulated marketplace agents for the query. A blank query lists the available catalog.

### `GET /api/jobs`

Returns account-wide marketplace jobs for the connected buyer.

## Evidence

### `GET /api/transactions?limit=100`

```json
{
  "integrity": { "ok": true, "receipt_count": 4, "last_hash": "..." },
  "receipts": [ { "file": "Ash_20261103_1115.json", "receipt": { "...": "..." } } ],
  "report": ["Ledger: VERIFIED", "Receipts: 4"]
}
```

If the chain is broken, `integrity.ok` is false and receipts are omitted; the backend does not serve a partial chain as if it were verified.

### `GET /api/receipts/:file`

Returns one receipt after checking that the filename is a valid receipt name and that it appears in the verified chain. Filenames are validated and resolved inside the receipt directory; traversal paths are rejected.

### `GET /api/security`

Returns chain integrity, engine state, pending approvals, recent events, mode and policy limits.

## Settings

### `GET /api/settings`

Returns redacted public config and the active task preferences. Secrets only appear as configured/not configured.

### `POST /api/tasks/:id/settings`

```json
{ "key": "max_parallel_jobs", "value": "2" }
```

Editable task preferences: `max_parallel_jobs`, `require_hiring_approval`, `allow_external`, `diy_first`, `execution_strategy` (before a plan), `quality_requirements`, `deadline`, `additional_instructions`, `preferred_agents`. Budget changes use the budget endpoint and approval. Provider/model/market credentials remain environment-backed and require a restart.

## Live events

### `GET /api/events`

Requires a valid bearer token or browser session cookie. Clients should request `Accept: text/event-stream`. Authorization is rechecked on events and heartbeats, and at most 64 streams are accepted.

```
event: ready
data: {"ok":true}

event: engine
data: {"type":"engine","event":{"at":"...","code":"SUBTASK_RECEIPT","message":"..."}}

event: refresh
data: {"type":"refresh","reason":"approval approved"}
```

Heartbeat comments (`: heartbeat`) keep local proxies from closing an idle stream. Clients should reconnect with backoff and re-fetch `/api/state`.

## Lifecycle

### `POST /api/admin/shutdown`

Returns `202` and stops the server after the response is sent. It removes the session file, stops the engine, disconnects the market and closes the HTTP listener. Any authenticated caller (bearer token or browser session with `X-Ash-Client: web`) can call it.

## Remote access

Remote binding is optional and off by default. To enable it, set a non-loopback `ASH_SERVER_HOST`, `ASH_SERVER_ALLOW_REMOTE=true` and a fixed `ASH_SERVER_TOKEN` of at least 24 characters. `ASH_SERVER_PUBLIC_URL` sets the origin used for UI links, and `ASH_SERVER_SECURE_COOKIES=always` is recommended behind TLS termination.

For remote use:

- prefer an SSH local-forward such as `ssh -L 8787:127.0.0.1:8787 user@host`;
- or place a properly authenticated TLS reverse proxy in front and keep Ash bound to loopback;
- never publish an unauthenticated or plain-HTTP Ash backend to the internet;
- rotate `ASH_SERVER_TOKEN` and restart if it may have leaked. Browser sessions are in-memory and end when the backend restarts or expires;
- custom cross-origin browser frontends are not enabled. Serve the bundled UI from Ash, or call the API from a trusted backend/proxy with a bearer token.

See [REMOTE.md](REMOTE.md) for setup, proxy examples and troubleshooting.

### Terminal evidence tools

- `GET /api/tasks/:id/timeline` returns `{task_id, currency, entries, events, events_truncated}`. Entries are the authoritative task ledger in append order; events are the latest 2,000 persisted engine events. This endpoint does not execute or replay operations.
- `POST /api/tasks/:id/proof` exports the task to its backend report directory and returns `{markdownPath, jsonPath, htmlPath}`. The request cannot select an arbitrary output path. The HTML is standalone and escaped; JSON and text are redacted. All usual API authentication and browser mutation requirements apply.

## Terminal chat

### `GET /api/chat?task_id=<id>`

Returns `{schema_version: 1, task_id, messages, truncated}`. Omit `task_id` for the general conversation. Each message has `request_id`, `role` (`user` or `assistant`), `content` and `at`. Conversations remain separate from the active-task selection.

### `POST /api/chat`

```json
{"task_id": null, "request_id": "chat_unique_request_123", "message": "Help me shape a task brief"}
```

`task_id` is an exact existing task ID or `null` for general chat. `message` is 1–4,000 characters; `request_id` is 8–80 letters, digits, underscores or hyphens. Success returns the updated history after the provider replies. Repeating a completed request ID still present in the retained history with the same text returns the saved turn; different text produces `409`. Concurrent sends to the same conversation also produce `409`. Allow up to two minutes for the configured provider and retries. Failed turns do not alter saved history.

Chat receives a bounded, redacted task snapshot and recent conversation. It has no engine, marketplace or approval-write capability. Chatting never creates or executes a task. `/task brief` is handled locally by the TUI to open an editable task form. The endpoint uses the same bearer/session authentication and CSRF checks as other mutations.

## Frontend administration and public probes (1.1)

These details supersede the older URL-ticket descriptions above. Credentials are
never supplied in URL fragments or query parameters, and startup session files no
longer contain `ui_ticket`. The compatibility `/api/auth/ticket` route issues a **code**
with the same local-only restrictions as `/api/frontend/code`.

| Route | Behavior |
| --- | --- |
| `GET /healthz` | Public `{ok:true, service:"ash"}` liveness |
| `GET /readyz` | Public storage/draining readiness; 200 or 503; a stalled storage probe times out after two seconds, with only one underlying probe in flight |
| `GET /api/frontend` | Local bearer-only `{running,url,port,next_action}` |
| `POST /api/frontend` | `{running:true|false}` or `{}` to toggle; ON returns `{code,expires_at}` |
| `POST /api/frontend/cycle` | B action: OFF → ON (no code) → issue code → OFF/revoke; returns next_action=start/code/stop |
| `POST /api/frontend/code` | Issue/rotate a one-time code while ON |
| `POST /api/frontend/logout-all` | Revoke sessions and unused code |
| `POST /api/auth/login` | `{code:"ABCD-…"}` or `{token:"…"}`; one-time code accepted in either input |

Codes are 64-bit random values displayed as four groups, expire in five minutes by
default and are consumed once. Only hashes are retained. Eight attempts per minute
per peer; failures thereafter return 429. Off/restart revokes sessions and codes.
Browser sessions remain HttpOnly/SameSite=Strict and Secure for public HTTPS.
Frontend administration requires loopback peer/Host and bearer auth, not a browser
cookie. A proxy/public browser cannot request codes. See SECURITY.md.

`POST /api/tracks/verify` is available only in demo mode: these modules are explicitly
local simulation fixtures, and live mode returns 403 instead of fake provider results.

Public HTML routes are `/` (landing), `/workspace` (sign-in/private overview), and
`/workspace/controls` (full task controls; `/console` alias). Private API routes continue
to require authentication; no task data is embedded in prerendered HTML.
