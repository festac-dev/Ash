# Troubleshooting

For the Go TUI, API, session-token and reconnection issues, see [TUI_GUIDE.md](TUI_GUIDE.md) and [API.md](API.md). For browser/remote login, cookies, TLS and reverse-proxy issues, see [REMOTE.md](REMOTE.md). The sections below cover the backend engine and the legacy readline shell.

Start with:

```
status
approvals
budget
transactions
verify
```

For deeper diagnostics set `ASH_LOG_LEVEL=debug` and inspect `logs/ash.log` and `logs/audit.log`. Logs are redacted, but treat them as sensitive task data.

## Remote browser UI

### The browser shows the login screen again

Browser sessions are in memory and expire after 12 hours or when the backend restarts. Sign in again. If `ASH_SERVER_SECURE_COOKIES=always` is set while the page is served over HTTP, the browser will not send the Secure cookie; use HTTPS or a trusted local setup.

### `403` on a create/approve/execute request

Cookie-authenticated mutations need `X-Ash-Client: web`. The bundled UI sends it; a custom API client should use `Authorization: Bearer` instead. Browser origins must match the request/public origin; loopback aliases must also use the same protocol and port.

### `Cannot reach Ash` or missing UI assets

Check `ash server status`, then `ash doctor`. Run `npm run build` (or `npm run build:web`) if the UI files are missing from a production checkout. Do not open the HTML file directly; use the served URL so cookies and API paths work.

### Remote bind is refused

That is the safe default. Set `ASH_SERVER_ALLOW_REMOTE=true` and a fixed `ASH_SERVER_TOKEN` of at least 24 characters, or use an SSH tunnel / local TLS proxy. Never expose plain HTTP to the internet.

## Startup

### `ASH CONFIGURATION ERROR`

Configuration is invalid and nothing ran. Run with `ASH_LOG_LEVEL=debug` only if the message is unclear; the message names the bad variable. Common causes:

- `ASH_MODEL_PROVIDER=demo` without `ASH_DEMO=1`;
- `ASH_MARKET_MODE=pro` without `ASH_ALLOW_IN_CALL_SPEND=true`;
- a base URL with embedded credentials;
- an HTTP market URL that is not localhost;
- `ASH_MAX_PARALLEL_JOBS` outside 1–8;
- both `MARKET_API_TOKEN` and `MARKET_API_TOKEN_FILE` set.

### `.env` seems ignored

Shell variables win over `.env`. Check:

```bash
node -e 'console.log(Object.keys(process.env).filter(k => /^(ASH_|MARKET_)/.test(k)).join("\n"))'
```

The diagnostic prints names only, keeping secret values out of terminal output. Use `ASH_ENV_FILE=/path/to/file` to point at a different file. The loader does not expand variables or multiline values.

### `Unknown project workstream` or `Ash project inputs are invalid or missing`

Run `tracks` for the six workstream IDs in the Ash project. Values are validated rather than invented: `network` must match the selected provider (NEAR Intents uses mainnet only), `fail_mode` WARN/BLOCK, `retention_mode` no-server-side-persistence, `treasury_type` sputnik/trezu, NEAR accounts must look like named accounts, and percentage splits must total 100%. Project inputs are keyed as `workstream.key` (for example `realworld.network`). Never put a private key or API key in a project input.

### A workstream stopped at its approval gate

That is intentional. The workstream template says to present the architecture/RULES/data-source review and wait for your explicit OK before contracts, mainnet, real funds or provider deployment. Continue only after reviewing it; Ash does not self-approve the gate.

### Boot shows `AI model ... not configured`

Planning and DIY work are disabled. Configure `ASH_MODEL_PROVIDER`, `ASH_MODEL_NAME`, `ASH_MODEL_BASE_URL` and (if needed) `ASH_MODEL_API_KEY`, or use `plan import <file>`.

### Boot shows `AI model ... demo` outside simulation

The demo provider is simulation-only. Set `ASH_DEMO=1` for demos/tests, or select a real provider.

### Boot shows `LEDGER ... CHAIN BROKEN`

Do not continue spending. Run `verify`, preserve the files it names, and restore them from backup. Ash refuses to append to a broken chain. Never delete receipts to “fix” it.

### `new` rejects a bare budget amount

The new-task wizard requires an explicit currency: `150 USDC` or `$150`. A bare `150` is rejected instead of being silently assigned to USD or USDC. Once a task exists, `budget set <amount>` uses that task's existing currency; the ledger cannot switch currency mid-task.

## Model

### `MODEL_UNAVAILABLE` / timeout

- Check the base URL includes `/v1` for OpenAI-compatible servers.
- Check the model name exists.
- Check the API key and network.
- Raise `ASH_MODEL_TIMEOUT_MS` for slow local models.
- With Ollama, confirm the server is running and `ASH_MODEL_BASE_URL=http://127.0.0.1:11434/v1`.

Ash retries transient failures and reports the provider’s HTTP error. It does not fabricate a plan when the model is unavailable.

### `MODEL_RESPONSE_INVALID`

The model did not return the required JSON, the plan failed validation, or it was truncated. Ash asks once more with the validation error. If it still fails:

- use a stronger/more instruction-following model,
- lower temperature/raise the token limit at the provider,
- import a reviewed plan with `plan import`.

### Provider rejects `response_format`

Ash automatically retries without JSON mode once. If the provider still fails, set `ASH_MODEL_JSON_MODE=false`.

## Marketplace connection

### `MARKET_AUTH_REQUIRED` / 401 / 403

The bearer token is missing, expired, revoked or lacks buyer permission.

- Ensure `MARKET_API_TOKEN`/`MARKET_API_TOKEN_FILE` contains the token from the market’s OAuth consent, not an agent-only `aat_` token if you need buyer tools.
- Authorize as the **person**, not as one of your agents; an agent token sees worker tools and cannot hire.
- Re-authorize and replace the token, then restart Ash.
- Check that `MARKET_MCP_URL` is the intended deployment.

### `No marketplace credential configured`

Ash still plans offline. Set a token or use simulation. Hiring is disabled until the connection works.

### `email_verification_required`

The market account has not confirmed its email. Open the confirmation link from signup (or request a new one on the market site), then retry. Ash pauses instead of retrying every agent.

### `-32006` / wrong currency rail

The agent does not accept the task’s currency. Ash filters agents by `payable_with`, but a stale listing or manual job can still produce this. Choose an agent that accepts USD/USDC, or start the task in the other currency. Do not switch a task ledger’s currency mid-task.

### `The market's ... balance is unreadable`

Ash will not hire without a readable balance. Check `market`, the account selection at consent, and the market’s status. If the market returns `usdc: null` while the deployment has no USDC rail, use USD or a supported rail.

### `No agent meets the ... maximum`

Every discovered agent was too expensive, on the wrong rail, paused, low quality, suspicious, or out of slots. Options:

- increase the subtask/budget allocation and replan;
- lower scope;
- allow DIY fallback (`diy_first`);
- run in board mode so agents bid;
- wait and retry.

Ash records a `WALKED_AWAY` receipt; it does not overspend.

### `create_job` refused

`create_job` exists only in pro mode and spends inside the call. Ash refuses it unless:

```dotenv
ASH_MARKET_MODE=pro
ASH_ALLOW_IN_CALL_SPEND=true
```

and you approve each spend. Prefer standard mode.

## Hiring and jobs

### Draft created but no approval URL

Ash refuses to guess. The draft may exist in your account, but it will not proceed without a safe HTTPS page. Check the market UI and the connection’s capabilities with `market`.

### Draft never funds

You have not approved it on the market page. Open the link shown by `status`/events. Ash polls; it cannot approve the charge. If you declined the draft, `cancel` the task so its state is explicit.

### Job stuck at `waiting_job`

- The agent may still be working. `status`/`jobs` show `expected_by` and the last market state.
- Ash backs off polling (10s, 30s, 2m, 5m) rather than holding long connections.
- If the job is overdue, use the market page. Ash will not cancel or dispute it automatically.
- After 24 hours with no deliverable, Ash records a failed receipt with escrow unresolved.

### `result_available` but no content

The market may have a delivery in a shape Ash cannot read, or object storage may be disabled. Ash does not retry in a tight loop. Open the job page and inspect it; then use `review` or resolve on the market.

### External deliverable link could not be fetched

Ash only fetches HTTPS links that resolve to public addresses, with redirect and size limits. Private/localhost targets, non-text content, redirect loops and SSRF attempts are refused. The task stops with escrow unresolved; inspect the link manually and decide on the market page.

### Verification failed

- Attempt 1: Ash requests one revision from the same agent when the capability exists. The new version is re-verified.
- Attempt 2 or no revision tool: the receipt is `REJECTED` with `payment_status: ESCROWED`. Ash does not accept. Resolve on the market page (revision, dispute, or walk away).
- DIY: one local revision is attempted, then the receipt is `FAILED`/`UNPAID`.

### Verification `needs_human`

Usually a prompt-injection signal, an unavailable verifier, ambiguous evidence or a link Ash cannot read. Inspect with `show <subtask>`, then:

```
review <subtask> pass
```

with the exact confirmation phrase, or `fail`. A human pass still requires the acceptance approval and the market page. It is not a payment shortcut.

### Market accepted before Ash verified

The market’s acceptance window can auto-accept. Ash records `REJECTED` with `RELEASED` and marks the task failed. It cannot undo the market’s decision. Verify promptly or extend the acceptance window when hiring.

## Budget

### `BUDGET_EXCEEDED` / `BUDGET_INVARIANT`

A commitment would exceed the authorized budget, or a ledger record violates an invariant. Do not edit `ledger.json` by hand. If you genuinely need more budget:

```
budget set <amount> <CURRENCY>
approve <id>
APPROVE <id>
```

If the ledger itself is corrupt, restore from backup and run `verify`.

### `A decrease ... would invalidate the plan`

Cancel or replan before shrinking the budget below the plan’s external allocation plus reserve.

### Funding requires reconciliation

A missing/invalid funded amount, wrong currency or unexpected charge is not replaced with the quote. Ash records the returned job and reported funding evidence, pauses and leaves escrow unresolved. `RECONCILIATION_REQUIRED` prevents resume from starting new work. Resolve the discrepancy with the marketplace and preserve the task and ledger for reconciliation; there is no automatic approval or refund shortcut.

An interrupted public board post is also retained as an attempted side effect. If the response was lost, Ash pauses instead of reposting a potentially duplicate listing.

### Committed money remains after cancellation

Correct. Ash does not assume a refund. Check `jobs`/the market page and resolve the escrow there. The receipt says `REFUND_PENDING`.

## Approvals

### `Phrase did not match`

Nothing was approved. Copy the exact `APPROVE <id>` or `DENY <id>` phrase shown. Do not use “yes”.

### `Approval ... expired`

Request a fresh operation. Approvals expire after `ASH_APPROVAL_TTL_MINUTES`; both pending and approved records become unusable at expiry. A matching unexpired decision may be reused only for recovery of its original operation.

### `Approval does not match the selected vendor or amount`

The plan, vendor or price changed after the request. Ash pauses rather than hiring under a stale approval. Inspect `approvals`, then create a fresh request (often by resuming/retrying the task).

### Plan approval after regeneration

Regenerating a plan changes its hash. The old plan approval cannot be used. Approve the new request.

## Locks and recovery

### `Task ... is already being executed by PID ...`

Another Ash process holds the engine lease. Check `ps -p <pid>`. If it is gone, wait two minutes for the lease to expire, or remove `tasks/<task-id>/engine.lock` **only after confirming no Ash process is running**. Do not remove task or ledger locks while a process is active.

### After a crash

1. Start Ash and run `status`.
2. Run `verify`.
3. If a subtask was funded, run `execute`; it polls the same job and does not pay again.
4. If a draft was awaiting approval, open the market page or cancel.
5. Check `approvals` for pending decisions.
6. Do not delete `task.json`, `ledger.json` or receipts to “reset” a task. Use `cancel` or a new task.

### `readline was closed` / piped commands do nothing

Fixed in this version by reading non-TTY stdin as a command script. If you see it, ensure you are running the current build (`npm run build`). For interactive use, run in a real terminal.

## Terminal and platform

### Boxes look broken

Set `ASH_UNICODE_MODE=never`. Ash then uses ASCII borders and `[OK]` markers.

### No colours

Colours are disabled when the output is not a TTY, under `NO_COLOR`, or with `ASH_COLOR_MODE=never`. Force with `ASH_COLOR_MODE=always` if your terminal supports 256 colours.

### Narrow terminal

Ash adapts down to 40 columns and clips rather than crashing. Widen the terminal or use `ASH_UNICODE_MODE=never` for more space.

### Termux

- Use `ASH_DATA_DIR` inside the Termux home directory.
- Install `nodejs-lts`; build with `npm run build` and run `node dist/index.js`.
- If npm install fails building `esbuild`, update Termux packages and retry; `npm run dev` needs it, the compiled build does not.

### Old Node

Ash requires Node 22.13+. Check `node --version` and the platform results in [VERIFICATION.md](VERIFICATION.md).

## Simulation

### Simulation lost state after a restart

It should not: `cache/sim-market.json` preserves simulated jobs. If you delete the data directory, the simulation resets. Simulation is for demos/tests; it never reflects real balances.

### Simulation says “No such simulated job”

The job was created before the durable cache existed, or the cache/data directory was removed. Start a fresh task. Live-market task state is unaffected.

### Simulation looks too easy

It is deterministic demo behavior, not a quality benchmark. It exists to exercise approvals, verification, ledger and receipt flow without spending funds.

## Telegram notifications

### Nothing arrives, but a warning says only one value is set

Set **both** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. A partial configuration disables notifications rather than calling Telegram with an incomplete request.

### `notify-test` reports that delivery failed

- Confirm the bot token from @BotFather is current.
- Send the bot a message first, or add it to the target group.
- Confirm the chat id (negative for groups, e.g. `-100...`).
- Check outbound network access to `api.telegram.org`.
- Increase `TELEGRAM_TIMEOUT_MS` only if the network is slow; the default is 5 seconds.

Telegram is best-effort and is not part of the budget, approval or payment path. A delivery failure is logged, never raised into the task.

## Reports and data

### Export path is not writable

Choose a path your user owns. Default reports go to `tasks/<id>/reports/` with owner-only permissions.

### Backups

Back up the whole `ASH_DATA_DIR`, especially `tasks/` and `transactions/`. To verify a restored copy:

```bash
ASH_DATA_DIR=/path/to/backup ash verify
```

If the chain is broken, restore the original files; do not let Ash append until it verifies.
