# Installing Ash

Ash is a Node.js backend with a Go/Bubble Tea terminal client. There is no database server; a React browser frontend is available and the backend persists JSON state and the optional TUI is the full-screen client. The original readline shell remains available.

## Requirements

- **Node.js 22.13 or newer**. See [verified platforms](VERIFICATION.md).
- **Go 1.25 or newer** for the Bubble Tea TUI. The legacy shell works without Go.
- npm 10 or newer.
- A terminal at least 40 columns wide. 80×24 or larger is recommended.
- Optional: a model provider key, and a NEAR Agent Market buyer token for live hiring.

## Linux

```bash
git clone <your-repository-url> ash
cd ash
npm install
cp .env.example .env
npm run build          # backend, browser frontend and optional Go TUI
npm start              # starts the managed backend and opens the TUI
```

If Go is not installed, the build skips the TUI and `npm start` opens the shared API text shell. Install Go from <https://go.dev/dl/> or set `ASH_GO_BIN` to its binary, then:

```bash
npm run build:tui
npm start
```

You can use the browser interface without Go. After `npm run build`, set a sign-in token and start the web UI:

```bash
export ASH_SERVER_TOKEN="$(openssl rand -base64 32)"
npm start -- web
# Open the printed URL and sign in with ASH_SERVER_TOKEN.
```

`npm start -- web --open` opens the local browser and prints a one-time sign-in code. See [REMOTE.md](REMOTE.md) for the optional remote bind and TLS setup.

For a first simulation run, set in `.env`:

```dotenv
ASH_DEMO=1
ASH_MODEL_PROVIDER=demo
ASH_DATA_DIR=.ash-data
```

The TUI starts with a dashboard. Click New task or press `N`, then use Plan task or `Ctrl+S`, `A` for approvals, `E` to execute, `T` for receipts, and `?` for help. `npm run dev -- shell` still starts the legacy readline shell.

## Android Termux

Termux runs Ash without a graphical desktop. The legacy shell is the most reliable path; the Go TUI can be built there if Go is installed.

```bash
pkg update
pkg install nodejs-lts git golang
```

Go in Termux may be older than 1.25; if `npm run build:tui` fails, use the legacy shell (`npm run dev -- shell`) or install a current Go toolchain and set `ASH_GO_BIN`.

```bash
git clone <your-repository-url> ash
cd ash
npm install
cp .env.example .env
```

Set a data directory inside your home directory. External/shared storage often does not support the permission bits Ash prefers:

```dotenv
ASH_DATA_DIR=/data/data/com.termux/files/home/.ash-data
ASH_DEMO=1
ASH_MODEL_PROVIDER=demo
```

If your keyboard or terminal does not render Unicode box drawing well:

```dotenv
ASH_UNICODE_MODE=never
ASH_COLOR_MODE=auto
```

Then:

```bash
npm run build
node dist/index.js
```

`npm start`/`ash` uses the TUI when it is built and falls back to the shared API text shell otherwise. `npm run dev -- shell` remains available.

Termux note: `npm run dev -- shell` uses `tsx` and works, but the compiled build starts faster and uses less memory.

## First run checklist

1. Start Ash with `npm start` (TUI), `npm run dev -- shell` (legacy shell) or `npm start -- web` (browser UI). The client connects to the local API. The boot/legacy panel checks:
   - core engine,
   - security and approval gate,
   - transaction ledger integrity,
   - marketplace connection,
   - AI model availability,
   - execution engine.
2. In the TUI press `N`; in the legacy shell type a task. Ash treats a long unrecognised line as a new task description.
3. Choose the Ash project workstreams for the task (legacy wizard): press Enter for all six, enter a comma-separated list such as `realworld,security`, or enter `custom` to skip project inputs.
4. Enter a maximum budget and currency, for example `150 USDC` or `$150`.
5. Accept or skip the optional fields.
6. Review the generated plan.
7. Approve it with the typed phrase, then execute.

In simulation mode, agents, balances and payments are clearly labelled fakes. No network request is made to a marketplace and no real funds can move.

## Live marketplace configuration

The market’s `/mcp` endpoint is OAuth-protected. Obtain a buyer bearer token through the market’s consent flow and put it in `.env`:

```dotenv
ASH_SIMULATE=false
MARKET_MCP_URL=https://market.near.ai/mcp
MARKET_API_TOKEN=...
ASH_MARKET_MODE=standard
```

For a server or unattended machine, prefer a file that only your user can read:

```dotenv
MARKET_API_TOKEN_FILE=/home/you/.config/ash/market-token
```

Do not commit `.env` or token files. They are ignored by git, but double-check with:

```bash
git status --ignored
```

## Model configuration

Any OpenAI-compatible Chat Completions endpoint works. The base URL must include the API version path.

```dotenv
ASH_MODEL_PROVIDER=openai-compatible
ASH_MODEL_BASE_URL=https://api.openai.com/v1
ASH_MODEL_NAME=gpt-4.1-mini
ASH_MODEL_API_KEY=...
```

For a local Ollama server:

```dotenv
ASH_MODEL_PROVIDER=ollama
ASH_MODEL_NAME=llama3.1
ASH_MODEL_BASE_URL=http://127.0.0.1:11434/v1
```

If no model is configured, Ash still starts and shows the ledger, commands and settings, but planning is blocked with a clear error. It does not pretend to reason. You can import a reviewed plan with `plan import <file.json>` if you cannot run a model.

## Optional Telegram notifications

To send startup and task-status messages to Telegram, create a bot with @BotFather and set both values in `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Message the bot once, then read the chat id from Telegram's `getUpdates` response. Verify with `npm start -- notify-test` or `ash notify-test`. Notifications are optional, best-effort and never block execution.

## Optional remote access

Remote binding is off by default. For a browser interface on another device, keep Ash on loopback behind an SSH tunnel or TLS reverse proxy, or explicitly opt in:

```dotenv
ASH_SERVER_HOST=0.0.0.0
ASH_SERVER_ALLOW_REMOTE=true
ASH_SERVER_TOKEN=<long random value>
ASH_SERVER_PUBLIC_URL=https://ash.example.com
ASH_SERVER_SECURE_COOKIES=always
```

Then run `ash web`. Never expose a plain-HTTP backend to the internet. Full details, proxy examples and troubleshooting are in [REMOTE.md](REMOTE.md).

## Data directory and permissions

Ash creates:

```
$ASH_DATA_DIR/
├── tasks/          # per-task state, ledger, approvals, deliverables
├── workspaces/     # local DIY artifacts, confined to the task
├── transactions/   # receipt chain (created on first receipt)
├── reports/        # exported reports
├── logs/           # ash.log and audit.log
└── cache/          # marketplace cache and simulated market state
```

On Linux and Termux, Ash tries to create directories as `0700` and files as `0600`. Do not place the data directory on a shared drive; use a private path.

## Upgrades

```bash
git pull
npm install
npm run build
npm test
```

Task and receipt schemas are versioned. Ash refuses to read unsupported or corrupt records instead of silently repairing them. Back up `transactions/` before upgrading a production installation.

## Uninstall

Ash is self-contained. Remove the repository and, if you want to delete task history permanently, remove your data directory. There is no global service or database to uninstall.
