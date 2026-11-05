# Security

The Go TUI, authenticated API and optional browser/remote boundary are covered separately in [docs/CLIENT_SERVER_SECURITY.md](docs/CLIENT_SERVER_SECURITY.md) and [docs/REMOTE.md](docs/REMOTE.md). This document remains the threat model for the engine, marketplace, budget, approvals and receipts.

Ash handles someone else’s money and untrusted external deliverables. This document describes what is enforced in code, what remains a human responsibility, and the known limits.

## Threat model

Ash assumes:

- Task text and preferences come from the authorized human.
- The model can be wrong, manipulated or unavailable.
- Marketplace agents, bids, messages, files and deliverables are **hostile input**.
- A bearer token may leak if it is placed in a careless environment.
- A crash can happen between any two writes or network calls.
- The terminal may be observed or logged.

Ash does not assume that:

- a submitted job is a successful delivery,
- a marketplace balance is the task budget,
- silence is approval,
- an escrow refund happened because a job disappeared,
- a deliverable’s instructions are safe to follow.

## Financial controls

### Authorized budget

Each task has its own append-only ledger in `tasks/<id>/ledger.json`. Amounts are stored as integer minor units (six decimals) and converted to decimal strings only at the boundary.

Before a commitment:

```
committed + paid + new_commitment <= authorized
```

The ledger recomputes every total from its entries on load. A tampered summary does not fool it. Releases and refunds cannot exceed committed escrow. A budget decrease cannot drop below committed or paid funds. A budget change requires a typed approval and an `approval_ref` in the ledger entry.

### Market account balance

`whoami` returns the account’s USD/USDC balances. Ash shows them separately and checks them before a hire, but **never treats them as the task budget**. If the balance is unreadable, Ash refuses to hire rather than guessing.

### Escrow and refunds

- A commitment is recorded only after the market reports the job funded.
- A release is recorded only after the market reports the job completed/accepted.
- A cancelled job is recorded as `REFUND_PENDING` until the market confirms the refund. Ash never invents a refund.
- If the market auto-accepts a delivery before Ash verified it, the receipt says `REJECTED` with `payment_status: RELEASED` and the task is marked failed. Ash does not hide the loss.

### No withdrawal capability

Ash’s MCP tool allowlist contains buyer tools only. Names matching `withdraw`, `transfer`, `payout`, `top-up`, `deposit`, `wallet`, `private key`, `seed phrase`, `bank` or payout-address operations are refused before any call. The market’s buyer token is scoped to hiring and not to moving funds.

### Approval gates

Sensitive actions require an `ApprovalRequest` with a nonce, expiry, scope and typed confirmation phrase:

| Action | Gate |
|---|---|
| Approve plan | `approve <id>` + `APPROVE <id>` unless the human chose fully autonomous |
| Hire an agent | Per-hire approval when enabled; plan authority otherwise; market page always |
| Award a board bid | Approval when enabled, then the market award page |
| Accept a deliverable | Approval when per-hire approval is enabled, then the market acceptance page |
| Change budget | Always, with `APPROVE <id>` and a ledger entry carrying the approval reference |
| Pro-mode in-call spend | Disabled: the supported API has no binding price ceiling; use a draft and market page |
| Cancel/delete marketplace job | Never automatic; perform it yourself on the market page |

Pending and approved records expire before use. Missing or expired hiring/acceptance records require a fresh typed decision, including after restart. A wrong phrase does nothing. Silence never approves. An approval is bound to the operation by scope (subtask, vendor, amount, currency, job, verification hash). If the scope changes, Ash refuses to use it.

## Credential handling

- Credentials come from environment variables or a file (`*_FILE`), never from source code or task data.
- Secrets are registered with the logger and replaced with `[REDACTED]` in messages, errors, audit fields, reports and diagnostics.
- `settings` and `market` show only whether a credential is configured, never its value.
- `git` ignores `.env*` except `.env.example`, `*.key`, `*.pem` and logs.
- Bearer tokens are never placed in marketplace briefs or messages; the adapter refuses text that looks like a credential.
- Ash never stores a wallet private key. Transaction receipts contain hashes, not keys.
- If signing is added later, the key must live outside `transactions/` in an OS secret store or secret manager.

Operational advice: create a dedicated marketplace account/token, use a token file with `0600`, rotate it if exposed, and revoke it from the market’s connections page when done.

## Untrusted input and prompt injection

Every external agent message, bid proposal, deliverable and file is treated as data:

- Control characters and ANSI escapes are stripped.
- Content is wrapped in explicit `<<<UNTRUSTED_...>>>` delimiters in verifier prompts, with instructions to ignore embedded commands.
- A heuristic scanner flags override attempts, role markers, payment instructions, approval bypasses, secret exfiltration, command execution and encoded payloads.
- A flagged deliverable cannot pass automatically. A human must inspect it, and the flag is stored on the receipt.
- The model has no tools in the verifier role. It cannot hire, accept, pay or change policy.
- External text can never modify the plan, budget, approvals, allowlist or system policy.

Heuristics are not perfect. Deterministic checks plus explicit human review are the real backstop.

## Marketplace protocol safety

- Tools are discovered from `tools/list`; Ash does not invent tool names or parameters.
- The adapter maps documented buyer operations and legacy names, filters arguments against the advertised JSON schema, and refuses unknown tools.
- `prepare_job` uses a persisted `client_request_id`, so a retry after a timeout replays the same draft rather than creating a second hire.
- Read calls may retry with bounded backoff; non-idempotent writes are not blindly retried.
- Call rate is limited (`ASH_MARKET_RATE_LIMIT`) and request timeouts are bounded.
- Responses are normalized and validated before use. Refusals are surfaced, never bypassed.
- In standard mode, every charge is approved by the human on the market page. Ash cannot approve it.

## Filesystem and subprocess safety

- State files are written atomically (same-directory temp file, fsync, rename or atomic hard link, directory fsync).
- Receipt filenames never overwrite an existing file; collisions get `_2`, `_3`, …
- Directories are created `0700`; files `0600` where supported.
- Model-generated artifacts must stay inside the task workspace; absolute paths, `..`, `.git`, `.env` and executable extensions are refused. Artifacts are inert text and are never executed automatically.
- Verification commands must match `ASH_VERIFY_COMMANDS` exactly. They run with a minimal environment (no model key, no market token), a hard timeout, process-group kill and capped output.
- External deliverable URLs must be HTTPS, contain no credentials, resolve only to public addresses, and the validated address is pinned into the TLS connection so a second DNS answer cannot redirect the request to a private host (SSRF/DNS-rebinding protection). Redirects are revalidated, at most three are followed, and bodies must be reviewable text under the size cap.

## Data and logs

- `logs/ash.log` and `logs/audit.log` are owner-only and structured. Audit events cover task creation, plan creation, approvals, ledger changes, marketplace calls, deliverables, verification and receipts.
- Task reports include task details and receipt hashes but no credentials or wallet keys.
- Export files are created `0600`.
- Simulated state is stored under `cache/sim-market.json` and is clearly marked simulated.
- Optional Telegram notifications leave the machine. They contain task status text, never API tokens, wallet keys or deliverables. The bot token is registered for log redaction.

## Residual risks

- **Human approval pages**: a malicious or compromised marketplace page is outside Ash’s control. Verify the URL host before approving.
- **Model judgment**: an LLM verifier can be fooled by a high-quality malicious deliverable. Use deterministic criteria, inspect important work, and keep final acceptance human.
- **OAuth consent**: Ash consumes a supplied bearer token; the interactive consent screen is not implemented. A token with broader scopes than expected is a human configuration risk.
- **No malware scanner**: Ash caps and validates text/files but does not run antivirus. Do not execute downloaded artifacts.
- **Terminal trust**: shoulder-surfing or shell history can expose task content, though secrets are redacted from logs.
- **Local attacker with your user account**: can read the data directory and token files. Use OS permissions/full-disk encryption.
- **Disputes and review**: Ash does not open disputes or post reviews automatically. Those are human actions on the market page.

## Incident response

1. Stop the engine: `cancel` (and `pause` if needed).
2. Revoke the market token/connection from the marketplace.
3. Run `verify`; a broken receipt chain means preserve files and restore from backup — do not let Ash append.
4. Inspect `approvals`, `history`, `jobs` and `transactions` for the affected task.
5. Resolve any `ESCROWED` or `REFUND_PENDING` amount on the marketplace; Ash will not assume the outcome.
6. Rotate model keys if they may have leaked.
7. Review `logs/audit.log` and exported reports.

Report security issues privately to the repository owner rather than opening a public issue with exploit details.
