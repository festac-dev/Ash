# Development

## Prerequisites

- Node.js 22.13+ and npm 10+.
- Go 1.25+ for the terminal client; CI/container builds pin Go 1.27.4.
- Linux with Bubblewrap and permitted user namespaces for executable-verification
  tests (`apt-get install bubblewrap` on Debian/Ubuntu). Unsupported platforms test
  refusal and do not fall back to a host shell.
- Playwright Chromium for browser tests, and nginx/OpenSSL for TLS tests.

## Install and run

```sh
git clone https://github.com/festac-dev/Ash.git
cd Ash
npm ci --ignore-scripts
npm run demo
```

The demo ignores existing credentials and state. To configure live providers, create
`.env` from `.env.example` only if `.env` does not already exist, then set the required
provider values. Never use production credentials in tests.

```sh
npm start
npm run dev -- shell
npm run demo -- --headless --json
```

## Build

```sh
npm run build
npm run build:server
npm run build:web
npm run build:tui
```

The full build skips the TUI if Go is unavailable; the Node shell remains usable.
`ASH_GO_BIN=/path/to/go npm run build:tui` selects a Go executable. Output goes to
`dist/`, including `ash-tui` (`ash-tui.exe` on Windows) and browser assets in `dist/web`.

## Tests

```sh
npm run format:check
npm run lint
npm run check
npm run test:tui
npm run build
npm run security
npm run validate:deploy
npm run test:production
npm run test:remote-tls
npm run test:deployments
npx playwright install chromium
npm run test:web
npm run test:web:tracks
```

`check` runs TypeScript checking and the Node suite. Tests use temporary directories,
local servers and controlled providers; live model/marketplace/payment calls are not
part of the normal suite. The production smoke starts the app from compiled files.
Hosting simulations test lifecycle and persistence without claiming a cloud deployment.
An actual container check requires a Docker daemon and a built `ash:ci` image:
`npm run test:container`.

Generated output stays outside documentation:

| Check | Output |
| --- | --- |
| Browser suite | `test-results/browser/results.json` and `test-results/browser/screenshots/` |
| Hosting simulation | `test-results/deployment/results.json` |
| Container runtime | `test-results/container/results.json` |

`test-results/` is ignored by Git and Docker. CI uploads these outputs as artifacts.
Retained screenshots in `docs/screenshots/` illustrate the README and are not rewritten
by tests. Automated browser checks supplement physical-device and manual accessibility testing.

Use `ASH_BROWSER_EXECUTABLE=/path/to/chromium` with `ASH_BROWSER_HEADED=1` to select
and display a browser. `ASH_NGINX_BIN=/path/to/nginx` selects the TLS-test proxy.

CI covers Linux, macOS and Windows. Linux runs the browser, TLS and sandbox checks;
macOS/Windows do not support the optional Bubblewrap execution path. A local Linux
pass does not establish results on another OS.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/engine`, `src/state`, `src/ledger`, `src/transactions` | Task lifecycle, persistence, budgets and receipts |
| `src/ai`, `src/market`, `src/providers`, `src/trackflows` | Runtime prompts, provider interfaces and workflows |
| `src/cli`, `src/launcher.ts` | Commands and process lifecycle |
| `src/server`, `src/security` | API, sessions, approvals and guards |
| `frontend`, `web` | React workspace and full controls |
| `tui` | Go terminal client |
| `scripts`, `tests`, `deploy` | Build/test tooling and deployment configuration |

## Adding functionality

Keep financial arithmetic and approvals in the backend. Add service methods and
validated API routes first, then the browser/TUI client operations and meaningful
behavioral tests. The frontend consumes state and events; it does not drive engine
internals. Update [API.md](API.md), [COMMANDS.md](COMMANDS.md) and the applicable guide.

Use `npm run format` and `gofmt` on edited files. Follow [CONTRIBUTING.md](../CONTRIBUTING.md)
for contribution requirements and [CONFIGURATION.md](CONFIGURATION.md) for settings.
