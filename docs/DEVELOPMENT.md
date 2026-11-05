# Development

## Prerequisites

- Node.js 22.13+ and npm 10+.
- Go 1.25+ for the Bubble Tea client.
- A terminal with ANSI colour for the full experience; ASCII/no-colour terminals are supported by the legacy shell, and the TUI degrades with a narrower layout.

The Go module pins Bubble Tea 1.3.10, Lip Gloss 1.1.0 and Bubbles 0.21.0. Go may download a newer toolchain automatically when the module requires it.

## Install

```bash
git clone <repository>
cd Ash-ai
npm install
cp .env.example .env
```

For simulation:

```dotenv
ASH_DEMO=1
ASH_MODEL_PROVIDER=demo
```

## Build

```bash
npm run build          # TypeScript backend + web UI + TUI when Go is available
npm run build:server   # TypeScript backend only
npm run build:web      # Vite frontend, prerender, compression and legacy controls
npm run build:tui      # TUI only; fails if Go is missing
```

`npm run build` skips the TUI with a clear warning when Go is not installed. `ASH_GO_BIN=/path/to/go npm run build:tui` selects a specific Go binary.

The TUI output is `dist/ash-tui` (`ash-tui.exe` on Windows). `build:web` produces separate landing and workspace HTML in `dist/web`, plus full controls at `/workspace/controls` (`/console` alias). See [FRONTEND.md](FRONTEND.md) for browser development and performance measurements.

## Run

```bash
npm start              # ash launcher -> Go TUI + managed backend
npm run dev -- shell            # legacy readline shell through tsx
ASH_SERVER_TOKEN="$(openssl rand -base64 32)" npm start -- web   # browser UI
```

Headless/backend:

```bash
node dist/index.js server start
node dist/index.js server status --json
node dist/index.js server stop
node dist/index.js web [--open]
node dist/index.js doctor --json
node dist/index.js logs 60
```

Run the TUI against an existing backend:

```bash
ASH_API_URL=http://127.0.0.1:PORT ASH_API_TOKEN=... ./dist/ash-tui
```

Do not put the token in a URL or shell history in normal use; the launcher supplies it through the environment.

## Tests

```bash
npm run typecheck
npm test                 # Node engine, CLI, API, remote auth and notification tests
npm run test:tui         # Go API/client and TUI model tests
npm run build
npm run test:web         # browser/globe and legacy console checks; Chromium required
node --import tsx scripts/test-console.mjs  # focused legacy console checks
```

The API tests start a real local server with the simulation adapter, create tasks, plan, execute and verify receipts. `tests/remote.test.ts` covers opt-in remote binding, browser cookie login, CSRF enforcement, logout and one-time tickets. The Go tests use `httptest` and pure model updates; they do not call a live marketplace.

## Project layout

```
src/
├── index.ts              entry point and process-level failures
├── launcher.ts           ash, tui, server, doctor, logs
├── cli/                  existing readline shell, theme, wizard, dashboard
├── server/
│   ├── main.ts           standalone API process
│   ├── server.ts         HTTP routes, browser assets, auth, SSE, shutdown
│   ├── auth.ts           browser sessions, one-time tickets, login limiter
│   ├── service.ts        API operations over the existing engine
│   └── event-bus.ts      in-process event fan-out
├── notify.ts             optional Telegram notifier
└── ...                   existing planner, engine, ledger, market, receipts

frontend/                 React/Vite browser frontend at /
web/                      legacy HTML/CSS/JS controls at /console

tui/
├── main.go
├── go.mod / go.sum
└── internal/
    ├── api/              HTTP + SSE client and JSON contract
    └── ui/               Bubble Tea model, forms, views, styles, tests

scripts/build-tui.mjs     Go build/test helper
scripts/build-web.mjs     Vite, prerender, compression, legacy controls
docs/                     architecture, API, remote, security, TUI and development guides
```

## Adding an API operation

1. Add a method to `AshService` that calls the existing domain module.
2. Add a route in `src/server/server.ts`, validate the body, and return JSON.
3. Add the method to `tui/internal/api/client.go`.
4. Add or update a screen/modal in `tui/internal/ui`.
5. Test the backend route in `tests/server.test.ts` and the UI state in a Go test.
6. Update `docs/API.md` and the TUI guide.

Never put financial arithmetic or approval bypass logic in the Go client. The backend must remain authoritative.

## Adding a TUI screen

1. Add a `screen` constant and a label in `model.go`.
2. Add navigation keys and a `view...` method in `views.go`.
3. Add action hitboxes and footer hints.
4. Load data with a `tea.Cmd` rather than in `View`/`Update`.
5. Test screen navigation with `model_test.go`.

## Environment

See [CONFIGURATION.md](CONFIGURATION.md) and [../.env.example](../.env.example). New launcher variables:

| Variable | Purpose |
|---|---|
| `ASH_SERVER_HOST` | Bind host; default `127.0.0.1` |
| `ASH_SERVER_PORT` | Browser/direct-server port, default `5050`; `0` selects an ephemeral port |
| `ASH_SERVER_TOKEN` | Fixed bearer/browser token; required for non-loopback hosts |
| `ASH_SERVER_ALLOW_REMOTE` | Opt in to a non-loopback bind (default `false`) |
| `ASH_SERVER_PUBLIC_URL` | Public UI origin behind a proxy |
| `ASH_SERVER_SECURE_COOKIES` | `auto`, `always` or `never` |
| `ASH_SERVER_UI` | Serve the browser UI (default `false`; explicit opt-in after restart) |
| `ASH_GO_BIN` | Go binary used by the TUI build script |

## Manual smoke test

1. `ASH_DEMO=1 ASH_MODEL_PROVIDER=demo npm start`
2. Press `N`, enter a task and budget, choose a strategy.
3. Press `Ctrl+S`; review the plan modal.
4. Open `Security`, approve the plan with the exact phrase.
5. Press `E`; watch live events and the dependency tree.
6. Open `Transactions`; inspect a receipt.
7. Press `Q`; confirm the backend process is gone (`node dist/index.js server status`).

Browser smoke test:

```bash
ASH_DEMO=1 ASH_MODEL_PROVIDER=demo \
  ASH_SERVER_TOKEN="$(openssl rand -base64 32)" \
  npm start -- web
```

Open the printed URL, sign in with the token and create a task. Use `/console` for the full planning, approval, execution and receipt controls. Check that a mutation without `X-Ash-Client: web` is rejected when using a cookie (the bundled UI sends it).
