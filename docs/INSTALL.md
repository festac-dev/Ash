# Installing Ash

Ash has a Node.js backend, a browser workspace and an optional Go terminal client.
Task state is stored in local files.

## Requirements

- Node.js 22.13+ and npm 10+.
- Go 1.25+ for the full-screen terminal; the API-connected command shell works without Go.
- A terminal at least 40 columns wide; 80×24 or larger is recommended.
- A model provider and marketplace buyer credentials for live planning and hiring.

## Install and try the demo

```sh
git clone https://github.com/festac-dev/Ash.git
cd Ash
npm ci --ignore-scripts
npm run demo
```

The demo ignores `.env` and existing data paths. It uses simulated providers and
private temporary state, then opens the terminal. No credentials are needed.
Use `npm run demo -- --headless --json` for the automated walkthrough or
`npm run demo -- --shell` for the API-connected command shell.

## Configure live operation

Copy `.env.example` to `.env` if that file does not already exist, then configure
your model and marketplace access using the sections below. Keep `ASH_DEMO=0` for
live operation. Build and start:

```sh
npm run build
npm start
```

Without Go, the full build skips the TUI and startup uses the command shell. To
select that shell explicitly, use `npm start -- --shell`. To add the full-screen
terminal later, install Go from <https://go.dev/dl/> or set `ASH_GO_BIN`, then run
`npm run build:tui`.

Browser access starts off. In the terminal press **B** to start it and **B** again
for a one-time code. Open the printed `/workspace` URL and enter the code. In the
command shell, type `B` and Enter. The next B closes browser access.

For a standalone browser session:

```sh
npm start -- web
```

Enter the printed one-time code in the browser. `ASH_SERVER_TOKEN` is the host/API
bearer credential; it is not the browser sign-in code. `npm start -- web --open`
also opens the browser. [Remote access](REMOTE.md) covers tunnels and HTTPS.

## Live marketplace configuration

Ash supports buyer consent through device login:

```sh
npm start -- market login
npm start -- market auth-status --json
npm start -- market --json
```

Open the displayed verification URL on the official marketplace and enter the
terminal code. Access and refresh tokens are stored privately under
`$ASH_DATA_DIR/secrets/market-oauth.json`. `market logout` clears the saved consent.
Login does not fund a hire or approve a payment.

If you already have a buyer bearer token, configure `MARKET_API_TOKEN` or an
owner-only file:

```dotenv
ASH_DEMO=0
MARKET_MCP_URL=https://market.near.ai/mcp
MARKET_API_TOKEN_FILE=/absolute/path/to/market-token
ASH_MARKET_MODE=standard
```

Funding and final acceptance require the marketplace's human-facing pages.

## Model configuration

For an OpenAI-compatible Chat Completions endpoint, set the provider, model and
base URL, including its API version path. Supply a credential when required:

```dotenv
ASH_MODEL_PROVIDER=openai-compatible
ASH_MODEL_BASE_URL=https://api.openai.com/v1
ASH_MODEL_NAME=gpt-4.1-mini
ASH_MODEL_API_KEY_FILE=/absolute/path/to/model-key
```

For a local Ollama server:

```dotenv
ASH_MODEL_PROVIDER=ollama
ASH_MODEL_NAME=llama3.1
ASH_MODEL_BASE_URL=http://127.0.0.1:11434/v1
```

Without a configured model, saved tasks and receipts remain inspectable; planning
requires a model or an imported reviewed plan. See [configuration](CONFIGURATION.md)
and [task commands](COMMANDS.md).

## Android Termux

Install Node, Git and Go in Termux:

```sh
pkg update
pkg install nodejs-lts git golang
```

Then follow the clone/install steps above. Check `node --version` and `go version`
against the requirements. If the installed Go is too old, use the command shell
or select a current toolchain with `ASH_GO_BIN`.

Keep live state in Termux's private home directory:

```dotenv
ASH_DATA_DIR=/data/data/com.termux/files/home/.ash-data
```

For limited Unicode rendering, set `ASH_UNICODE_MODE=never`. Use
`npm run demo -- --shell` for the simulation or `npm start -- --shell` after
configuring live providers.

## Storage and upgrades

`ASH_DATA_DIR` defaults to `.ash-data`. It contains tasks, deliverables, approvals,
receipts, exports, logs and saved credentials. Demo state uses its own temporary
directory. Keep live and simulated state separate and do not commit credentials
or runtime state.

Before upgrading, stop Ash and back up the complete live data directory.
[Backup and recovery](DEPLOYMENT.md#backup-and-recovery) describes the procedure.
After updating code, run `npm ci --ignore-scripts`, `npm run build` and the relevant
checks in [DEVELOPMENT.md](DEVELOPMENT.md).

Removing the repository uninstalls the application. Delete the data directory
only if you intend to permanently remove task history and saved credentials.
