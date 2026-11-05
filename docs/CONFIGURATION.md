# Configuration

Ash reads configuration from environment variables. On startup it also loads `.env` from the current directory (or `ASH_ENV_FILE`) **without overriding variables already set by the shell**. `.env` is ignored by git; never commit it.

Everything user-specific is supplied at runtime through the wizard or environment. No task, budget, currency, agent, price or preference is hardcoded.

## AI model

| Variable | Default | Meaning |
|---|---|---|
| `ASH_MODEL_PROVIDER` | `none` | `openai-compatible`, `ollama`, `demo` (simulation only), or `none` |
| `ASH_MODEL_NAME` | — | Model identifier required for real providers |
| `ASH_MODEL_BASE_URL` | Ollama local URL for `ollama` | OpenAI-compatible base ending in `/v1` |
| `ASH_MODEL_API_KEY` | — | Provider key; redacted from logs and diagnostics |
| `ASH_MODEL_API_KEY_FILE` | — | Read the key from a file instead of the environment |
| `ASH_MODEL_TIMEOUT_MS` | `120000` | Request timeout, 10s–10min |
| `ASH_MODEL_JSON_MODE` | `true` | Send `response_format: json_object`; Ash retries without it if the provider rejects it |

Examples:

```dotenv
ASH_MODEL_PROVIDER=openai-compatible
ASH_MODEL_BASE_URL=https://api.openai.com/v1
ASH_MODEL_NAME=gpt-4.1-mini
ASH_MODEL_API_KEY=sk-...
```

```dotenv
ASH_MODEL_PROVIDER=ollama
ASH_MODEL_NAME=llama3.1
ASH_MODEL_BASE_URL=http://127.0.0.1:11434/v1
```

If the model is unavailable, Ash does not fake reasoning. Planning and DIY work stop with a clear error; you can configure a model, retry, or import a reviewed plan.

### Simulation model

`ASH_MODEL_PROVIDER=demo` is accepted only when `ASH_DEMO=1`. It is a deterministic local planner/worker/verifier used for tests and demos. Its output is labelled simulated, and it cannot be selected in live mode.

## Marketplace

| Variable | Default | Meaning |
|---|---|---|
| `MARKET_MCP_URL` | `https://market.near.ai/mcp` | Streamable HTTP MCP endpoint |
| `MARKET_API_TOKEN` | — | Buyer bearer token from the market’s OAuth consent |
| `MARKET_API_TOKEN_FILE` | — | Read the bearer token from a file |
| `ASH_MARKET_MODE` | `standard` | `standard` (`/mcp`) or legacy `pro`; both require draft/page approval |
| `ASH_ALLOW_IN_CALL_SPEND` | `false` | Legacy opt-in for `pro`; does not enable unbounded charges; see [../SECURITY.md](../SECURITY.md) |
| `ASH_HIRING_MODE` | `direct` | `direct` hire from a private draft, or `board` public job + bids |
| `ASH_MARKET_TIMEOUT_MS` | `60000` | MCP call timeout, 5s–120s |
| `ASH_MARKET_MAX_RETRIES` | `3` | Retries for idempotent/read calls, 0–5 |
| `ASH_MARKET_RATE_LIMIT` | `60` | Outbound MCP calls per minute |

### Standard mode (recommended)

On `https://market.near.ai/mcp`, `prepare_job` creates a draft and returns an approval page. **No money moves in the tool call.** You approve and fund escrow on the market page. `accept_result` likewise returns the page where you accept and release payment. Ash polls `get_job_status` and only records a released payment when the market reports the job completed.

Ash cannot click either page. In exchange, a stolen Ash token cannot spend your balance through these calls.

### Pro mode

`/mcp/pro` may advertise `create_job`, which charges inside the call without a binding price ceiling. Ash disables that operation because a price can change after local approval. Even with `ASH_MARKET_MODE=pro` and `ASH_ALLOW_IN_CALL_SPEND=true`, Ash uses `prepare_job` and requires approval of the final price on the market page. If the endpoint has no draft tool, hiring stops before any charge. Pro `award_bid` is also blocked because it can charge inside the call. Use the standard `/mcp` endpoint for direct hires and board awards.

### Buyer token

The market’s MCP endpoint is OAuth-protected. Ash accepts the resulting bearer token; it does not implement the browser consent screen itself. Put it in the environment or, preferably, an owner-only file:

```dotenv
MARKET_API_TOKEN_FILE=/home/you/.config/ash/market-token
```

If no token is configured, Ash still plans and manages local tasks, but every marketplace operation fails closed with a clear explanation.

### Agent names and prices

Never configured in Ash. Agents and prices are discovered live through `browse_agents` / `get_agent`, then filtered by payable rail, planned maximum, track record and budget.

## Telegram notifications

Optional, off by default. Create a bot with [@BotFather](https://t.me/BotFather), then set both values:

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | — | Your user/group chat id; message the bot and read `getUpdates` to find it |
| `TELEGRAM_TIMEOUT_MS` | `5000` | Delivery timeout, 1s–30s |

When either value is missing, notifications are disabled and Ash logs a warning instead of failing. Delivery failures never interrupt a task. Ash sends startup, task completion/failure/cancellation and unhandled-error messages; it never sends credentials. Test the setup with `ash notify-test` or `notify-test` inside the app.

## API, web UI and launcher

| Variable | Default | Meaning |
|---|---|---|
| `ASH_SERVER_HOST` | `127.0.0.1` | Bind address. Loopback is the safe default; a non-loopback value requires remote opt-in |
| `ASH_SERVER_PORT` | `5050` | Browser listener port locally; remote API/UI bind port. `0` selects an ephemeral port |
| `ASH_SERVER_TOKEN` | generated for loopback | Fixed bearer token and browser sign-in token. Required (at least 24 characters) for non-loopback hosts |
| `ASH_SERVER_ALLOW_REMOTE` | `false` | Explicitly allow a non-loopback bind. Use TLS or a trusted private network |
| `ASH_SERVER_PUBLIC_URL` | — | Public origin used for the browser UI, e.g. `https://ash.example.com` (no path). Helps when a reverse proxy rewrites `Host` |
| `ASH_SERVER_SECURE_COOKIES` | `auto` | `auto` sets `Secure` on HTTPS requests; `always` requires TLS termination; `never` is for a trusted local network only |
| `ASH_SERVER_UI` | `false` | Serve the browser command centre at `/` and its assets |
| `ASH_GO_BIN` | `go` on PATH | Go binary used by `npm run build:tui` |

The launcher writes `$ASH_DATA_DIR/server.json` with the URL, optional public URL and token (mode `0600`) and reuses a healthy backend. B or `ash frontend on` issues a single-use, five-minute code on activation. `ash frontend code` rotates it; codes are never persisted or placed in URLs.

### Local and remote examples

Loopback browser UI:

```dotenv
ASH_SERVER_TOKEN=replace-with-a-long-random-value
ASH_SERVER_UI=true
```

Deliberate remote mode behind TLS:

```dotenv
ASH_SERVER_HOST=0.0.0.0
ASH_SERVER_ALLOW_REMOTE=true
ASH_SERVER_TOKEN=replace-with-a-long-random-value
ASH_SERVER_PUBLIC_URL=https://ash.example.com
ASH_SERVER_SECURE_COOKIES=always
```

Safer proxy pattern (proxy runs on the same host; Ash stays on loopback):

```dotenv
ASH_SERVER_HOST=127.0.0.1
ASH_SERVER_PUBLIC_URL=https://ash.example.com
ASH_SERVER_SECURE_COOKIES=always
```

Run the TUI against an existing backend with `ASH_API_URL` and `ASH_API_TOKEN` set and `ash tui --remote`.

The browser UI exchanges the token once for an HttpOnly, SameSite=Strict cookie. Mutating browser requests also need `X-Ash-Client: web`; the bundled UI sends it. Login attempts are rate-limited. The API still accepts bearer tokens for scripts and the TUI. See [REMOTE.md](REMOTE.md).

## Application and policy

| Variable | Default | Meaning |
|---|---|---|
| `ASH_DEMO` | unset | Explicit `1` opts into simulation; refused in production. `npm run demo` also isolates configuration and data. The old `ASH_SIMULATE` flag alone is refused |
| `ASH_DATA_DIR` | `./.ash-data` | Private state directory; must not be `/` |
| `ASH_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ASH_COLOR_MODE` | `auto` | `auto`, `always`, `never` |
| `ASH_UNICODE_MODE` | `auto` | `auto`, `always`, `never` |
| `ASH_ANIMATION` | `true` | Matrix-rain boot animation where supported |
| `ASH_NO_SPLASH` | — | Set to `1` to suppress the boot animation |
| `ASH_MAX_PARALLEL_JOBS` | `3` | Installation ceiling, 1–8; a task may request less |
| `ASH_MAX_RETRIES` | `3` | General/model retry ceiling, 0–5 |
| `ASH_APPROVAL_TTL_MINUTES` | `30` | Human approvals expire after this window (5–1440) |
| `ASH_CONTINGENCY_RATIO` | `0.10` | Minimum plan reserve, 0–0.5 |
| `ASH_MAX_AGENT_CANDIDATES` | `6` | How many ranked agents Ash may try for one subtask |
| `ASH_MAX_DELIVERABLE_MB` | `10` | Cap for stored/fetched deliverable text, 1–50 |
| `ASH_VERIFY_COMMANDS` | empty | Exact shell commands allowed for `test_command` criteria |

`ASH_VERIFY_COMMANDS` is a semicolon-separated list, or newline-separated if it contains newlines. Each command is matched **exactly**, runs with `/bin/sh -c` on Unix or `cmd.exe /d /s /c` on Windows inside the task workspace, gets a minimal scrubbed environment, a hard timeout and capped output. A model can never add a command that is not on this list. Leave it empty unless you truly need executable verification.

## Currency and budgets

Ash supports `USD` and `USDC`, both with six decimal minor units internally. The market treats the rails as 1:1 but keeps separate balances: a USD hire draws the `usd` balance, while a USDC hire draws `credit_usd` first and then `usdc`. Ash models that documented rule in its pre-hire balance check; neither balance is ever treated as the task budget.

- The authorized budget comes from you for each task.
- The market account balance is fetched from `whoami` and shown separately.
- Both limits are checked before a hire. Neither is silently substituted for the other.
- A budget change requires a typed approval and updates the append-only ledger.

## Terminal behaviour

- `ASH_COLOR_MODE=never` and `NO_COLOR=1` disable ANSI colour.
- `ASH_UNICODE_MODE=never` uses ASCII borders and markers.
- Non-TTY output (pipes, CI) disables animation, colour auto-detection and interactive prompts; commands are read from stdin.
- The layout adapts down to 40 columns; below that, content is clipped rather than crashing.

## Precedence

1. Variables already present in the shell.
2. `ASH_ENV_FILE` (or `.env`) for variables not already set.
3. Built-in non-sensitive defaults.

Secrets are never printed by `settings`, `market`, logs or exported reports. `settings` only shows whether a token or key is configured.
