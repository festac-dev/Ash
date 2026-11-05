# Client/Server Security

This document covers the new local API and Go TUI boundary. The existing financial, approval and receipt controls in [../SECURITY.md](../SECURITY.md) still apply unchanged.

## Trust boundaries

| Boundary | Trust |
|---|---|
| Go TUI ↔ Node API | Authenticated HTTP; the API is authoritative |
| Browser UI ↔ Node API | Same-origin HTTP with an HttpOnly session cookie and CSRF header; the API is authoritative |
| Node API ↔ existing engine | In-process; existing budget/approval/receipt rules apply |
| Node API ↔ marketplace | Existing MCP adapter, buyer allowlist and market-page approvals |
| TUI ↔ terminal input | Untrusted display data; only the requested access code is shown in its private dialog |
| Local filesystem | Private data directory; `server.json` contains the session token |

The TUI submits approval phrases; the backend independently validates their scope, expiry and budget before any operation. The external marketplace page still performs standard-mode charges.

## API and browser authentication

- Binds to `127.0.0.1`, `::1` or `localhost` by default. A non-loopback bind requires `ASH_SERVER_ALLOW_REMOTE=true` and an explicit token of at least 24 characters.
- Generates a 32-byte random session token with `crypto.randomBytes` at each loopback server start, unless `ASH_SERVER_TOKEN` is supplied.
- Compares bearer tokens with constant-time comparison.
- Authenticates every protected `/api/*` route, including health, state, receipts and SSE.
- The public `/api/auth/login` route accepts only the server token or a one-time code, is rate-limited per client address, and returns a generic failure. It never echoes the credential. A fresh code requires loopback-only bearer administration through `POST /api/frontend/code`; cookie sessions cannot mint one.
- Browser login exchanges the token once for an opaque in-memory session id in an `HttpOnly; SameSite=Strict` cookie. The long-lived token is not stored in the cookie or in browser storage.
- Cookie-authenticated mutations require `X-Ash-Client: web`; cross-origin pages cannot set that header without a CORS preflight, which Ash does not grant. SameSite=Strict is a second layer.
- Accepts the configured public origin, request origin, or loopback aliases on the same protocol and port. Cross-port loopback browser origins are rejected.
- Enforces a 1 MiB request-body limit, request timeouts and JSON validation.
- Never logs the `Authorization` header, token, cookie value or one-time code.
- Writes the session file with mode `0600`; the data directory is created `0700`.
- Removes the session file only when its token matches the running server.
- The session token is never placed in a URL, receipt, task record, SSE event or UI text. `ash web --open` prints a separate one-time code in the requesting terminal, consumed through a POST login and expiring after five minutes. No credential appears in the URL.

`ASH_SERVER_TOKEN` is intended for tests, automation and remote operation. If set, it must be a strong random value; do not put it in a shared shell profile. Browser sessions expire after 12 hours or when the server restarts.

## Session discovery

`$ASH_DATA_DIR/server.json`:

```json
{
  "schema_version": 1,
  "pid": 1234,
  "host": "127.0.0.1",
  "port": 8787,
  "token": "[session token]",
  "started_at": "...",
  "url": "http://127.0.0.1:8787",
  "version": "1.1.0"
}
```

The launcher reads it to reuse a healthy backend. `ash server stop` authenticates with the token before requesting shutdown. Health checks verify service, PID, start time and mode. If the recorded process is still alive but unresponsive, the launcher preserves the session and refuses to start a replacement. It removes a stale session only after the owner is gone; it never signals a guessed PID.

## Financial authorization

The server service calls the existing `ApprovalManager`, `LedgerRecord` and `ExecutionEngine`. It does not bypass:

- the authorized task budget;
- committed + paid + new commitment checks;
- market-balance checks;
- plan approval;
- hire/award/acceptance approvals;
- the marketplace's human approval page in standard mode;
- refund/release reconciliation;
- receipt hashing and chain verification.

A compromised client holding the API token can submit exact approval phrases, so the token must be treated as full control authority. Budget, scope and marketplace capability checks still run in the backend. Standard-mode charges require the marketplace page; pro mode can spend inside an explicitly enabled, approved call.

## Secrets in the TUI

The TUI receives:

- `ASH_API_URL` (local, or the explicitly selected remote URL);
- `ASH_API_TOKEN` (session bearer token);
- `ASH_TUI_VERSION`.

It does not receive the market token, model key, Telegram bot token or wallet secrets. `/api/settings` returns only configured/not-configured booleans. Task descriptions and receipt metadata are displayed, so the terminal itself should be trusted or protected.

## Terminal state

Bubble Tea runs in the alternate screen with mouse reporting. On normal exit, `Q`/`Ctrl+C`/terminal interrupt, or panic recovery, it restores the terminal. If a wrapper kills the process with `SIGKILL`, the terminal may need `reset` or a new shell.

## Remote operation

Remote binding is **off by default**. Enabling it requires all three of a non-loopback `ASH_SERVER_HOST`, `ASH_SERVER_ALLOW_REMOTE=true`, and a fixed `ASH_SERVER_TOKEN`. An HTTPS public URL is required unless the explicitly unsafe `ASH_ALLOW_INSECURE_PUBLIC_HTTP=true` override is set. Use TLS termination and set `ASH_SERVER_PUBLIC_URL` so UI links and `Origin` checks match the public origin.

Do not expose a plain-HTTP Ash backend to the internet. A remote deployment should sit behind Caddy, nginx, a load balancer or an SSH tunnel. The token is a control secret for the whole task engine, not a public read-only API key. Rotate it and restart if it may have leaked.

Ash serves the public landing at `/`, private workspace at `/workspace`, and full controls at `/workspace/controls` (`/console` alias). Cross-origin browser frontends are not enabled; custom clients should call the API with a bearer token from a trusted backend or proxy. See [REMOTE.md](REMOTE.md).

## Denial-of-service and local attackers

- A local process running as the same OS user can read `server.json` and control Ash; use OS account isolation and full-disk encryption.
- SSE clients are capped at 64. Slow/disconnected clients are closed; cookie authorization is rechecked before events and heartbeats.
- Request bodies are capped.
- Output lists are bounded by the existing store/receipt limits.
- The TUI renders untrusted task/receipt text as terminal text; ANSI/control characters from deliverables are sanitized by the existing utilities before storage. The UI truncates long fields.
- A very large number of tasks or receipts can still consume memory while serializing a snapshot; use the existing data-directory retention and back up/prune deliberately.

## Residual risks

- Remote mode relies on the operator to terminate TLS correctly and to keep the token secret. Plain HTTP is available only if explicitly configured and should be limited to a trusted network.
- The market's OAuth consent screen is still not automated; a buyer token is supplied.
- The marketplace page remains a human action outside Ash's control.
- The receipt chain is locally witnessed, not externally anchored.
- Provider/model/market credentials are environment-backed; the Settings screen shows status but does not edit secret files.
- The TUI is tested with automated model tests and PTY smoke tests, not every terminal emulator. Mouse reporting and alt-screen behavior vary by terminal.

## Incident response

1. Stop the client (`Q`/`Ctrl+C`).
2. Stop the backend with `ash server stop`; if it is unresponsive, kill only the process recorded in `server.json` after confirming its command line.
3. Rotate/revoke the market credential and model key if they may have leaked.
4. Run `ash doctor --json` and inspect `logs/audit.log`.
5. Preserve receipts; run `ash verify` and never rewrite a broken chain.
6. Resolve any escrow or refund on the marketplace page.
