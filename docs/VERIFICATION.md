# Verification — 4 November 2026

Results below describe commands actually executed in the local workspace. They do not
claim that CI ran remotely, that paid provider workflows ran, or that a deployment was
launched. Historical screenshots/benchmarks in older review documents are not evidence
for the current application.

The later deployment review adds new fixes and verification. See
[DEPLOYMENT_REVIEW.md](DEPLOYMENT_REVIEW.md) and its machine-readable results for that
run. The original phase results below are retained as dated evidence.

## Latest full review

See [REVIEW_FOLLOWUP.md](REVIEW_FOLLOWUP.md) for the full rerun after the presentation
changes, including the new download deadline and live/demo boundary regressions.
The final result is 214 Node tests, 32 browser checks, Go/TLS/PTY checks, production
build and smoke, plus six hosting profiles with 54 grouped checks and eight
startup/activation failure cases passing. The actual Docker check failed at daemon
preflight; hosted deployment and live providers remain unverified. Earlier pass counts
below retain their original scope.

## Workspace presentation follow-up

Normal screens now use short labels and statuses; remote setup and session internals
remain in the README and operational docs. The workspace has a dismissible three-step
feature tour, with Help to reopen it. The landing has no onboarding dialog. Task controls
share the overview's locally bundled Manrope/Space Grotesk fonts and ash palette;
layered panels, automatic globe and reduced-motion support remain.

Executed on the current presentation changes:

- `npm run format:check` and `npm run lint`: passed after the final changes.
- `npm run build`: backend, browser and Go TUI built. `npm run build:web` was repeated
  after the final dialog/copy changes.
- `npm run typecheck`: passed.
- `node --import tsx --test --test-concurrency=2 tests/terminal-workspace.test.ts tests/frontend-access.test.ts tests/remote.test.ts tests/frontend.test.ts tests/cli-contract.test.ts tests/cli.test.ts tests/demo.test.ts`:
  **36 passed**, no failures/skips/cancellations (189.89 seconds), using native Termux Node.
- `ASH_GO_BIN=/tmp/ash-tools/go/bin/go node scripts/build-tui.mjs --test`: API/UI passed;
  the main package has no tests.

- `ESBUILD_BINARY_PATH="$PWD/node_modules/@esbuild/linux-arm64/bin/esbuild" ASH_BROWSER_ARGS='["--no-zygote"]' /usr/bin/node --import tsx scripts/test-web.mjs`:
  **31 browser checks passed**. Coverage includes guide completion/skip/reopening,
  blocked storage, single-dialog behavior, private route separation, code login,
  tasks/chat/events, six simulation tracks, both themes, mobile/touch, reduced motion,
  fallback rendering, controls drafts/settings/logout and keyboard table scrolling.
  Automated WCAG A/AA audits reported zero violations on the landing, overview,
  feature tour and task controls in both themes. Screenshots were visually reviewed.
- `node scripts/test-production.mjs`: passed with compiled files only, including the
  shared appearance asset, readiness, OFF default, code login, revocation and shutdown.

Evidence: [frontend-browser-results.json](frontend-browser-results.json) and
[screenshots](screenshots/). Chromium used **Canvas2D** here; hardware WebGL remains
unverified. The pre-existing lazy Three.js bundle-size warning remains visible.
No dependencies changed. Hosted deployments and external paid providers were not
rerun for this presentation-only follow-up; earlier deployment evidence below retains
its original scope.

The browser regression work found overlapping guide/sign-in dialogs on a `#guide`
navigation; rendering now permits only one at a time, with unique accessible heading
IDs. The expanded task-controls audit also found a scrollable table without keyboard
focus; all table regions now have accessible names, focus indicators and keyboard scrolling. Guide keyboard checks account for Chromium's native modal-to-browser-chrome focus
cycle. Theme checks open the saved theme directly, avoiding assertions during a manual
theme transition.

## Terminal and workspace follow-up

The latest changes keep the terminal available in both `npm start` and `npm run demo`.
Frontend starts OFF: first B starts it without a code, second B displays a fresh code,
and third B closes it and revokes browser access. The landing (`/`), private overview
(`/workspace`) and task controls (`/workspace/controls`, with `/console` alias) are separate.

| Executed check | Result |
| --- | --- |
| `npm run format:check`, `npm run lint`, `npm run typecheck` | Passed for the application and tests |
| `npm run build` | Backend, prerendered landing/workspace, browser assets and Go TUI built |
| `npm test` | **210 passed**, zero failures/skips/cancellations; final run 302.62 seconds |
| `npm run test:tui` | Go API/UI packages passed; main package has no tests |
| Actual PTY runs of the start and demo launchers | Both opened the TUI; B worked three times directly inside the access dialog; displayed code redeemed, third B revoked the session, core API survived, Q exited cleanly |
| `npm run demo -- --headless --json` | Completed with `simulated:true`, four receipts, verified integrity and `frontend_running:false` |
| `npm run security` | Zero npm vulnerabilities reported |
| `npm run validate:deploy` | Render, Railway, Compose, Dockerfile and systemd invariants passed |
| `npm run test:production` | Production layout without source/build tools served separate pages; OFF default, code login, revocation and SIGTERM cleanup passed |
| `npm run test:remote-tls` | One real nginx TLS integration passed |
| `node --import tsx scripts/test-web.mjs` | **26 checks passed**; zero automated WCAG A/AA violations on landing and workspace in both themes |
| `npm run test:deployments` | Fresh production-only dependency installation; all six hosting profiles passed nine checks each, plus eight startup/activation failure cases |

New regressions cover direct text-shell code display/redemption, the three-step B state,
concurrent access changes, shared browser/terminal state, exact approval phrases,
start attachment without stopping an existing service, and demo interruption/EOF/quit.
Browser checks cover route separation, no private landing requests even with a cookie,
authentication/reload, accessible node details, chat/task creation, mobile/touch,
reduced motion, offscreen suspension, logout races and task-control deep links.

Intermediate checks found and corrected a redacted terminal code, a missing accessible
node list after the route split, an obsolete page-title assertion and an offscreen test
whose old viewport could no longer fully hide the shorter landing globe. The final
runs above passed with these corrections. A local Vite/esbuild binary mismatch was
resolved using its matching installed binary, without changing dependencies.

Application checks used native Termux Node 26.12.1; Chromium and actual TUI PTY checks
used Linux Node 22.23.3 on the same host. Go and nginx were selected with `ASH_GO_BIN`
and `ASH_NGINX_BIN`. Native tsx used the installed root esbuild binary via
`ESBUILD_BINARY_PATH`; Vite used its own matching binary. These are local mixed-runtime
workarounds. Browser measurements in [frontend-browser-results.json](frontend-browser-results.json)
identify **Canvas2D** on this host; hardware WebGL performance is not verified. The
existing lazy Three.js bundle size warning remains visible in the successful build.

Updated deployment evidence is in
[deployment-simulation-results.json](deployment-simulation-results.json). Actual Docker
container execution, cloud accounts, SSH authentication, live paid providers and payments
remain external checks. Infrastructure simulations do not establish hosted deployment.
The prior NEAR judging criteria added to README/DEMO are preparation guidance, not a
newly verified rubric or scoring weights for this event.

## Final clean installation check

A fresh isolated project copy was installed and tested on 4 November 2026. No existing
`.env`, application state or development dependency directory was copied into it.
All 13 verification stages completed successfully:

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org` | 327 packages installed successfully |
| `npm run format:check` | Passed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run security` | Zero npm vulnerabilities reported |
| `npm run validate:deploy` | Passed |
| `npm test` | 203 passed; no failures, cancellations or skipped tests; 399.06 seconds |
| `npm run test:tui` | API and UI packages passed; main package has no tests |
| `npm run build` | Backend, web assets and Go TUI built successfully |
| `npm run test:production` | Production startup, OFF default, code login, revocation and shutdown passed |
| `npm run demo -- --headless --json` | Completed with explicit simulation labeling, four receipts and verified integrity |
| `npm run test:remote-tls` | nginx TLS integration passed |
| Browser suite (`scripts/test-web.mjs`) | 23 checks passed; zero automated WCAG A/AA violations in either theme |

Application checks used native Termux Node 26.12.1 with freshly installed Android
dependencies. The browser suite used Linux Node 22 and Chromium with the matching
Android esbuild executable for the shared installation. This host-specific bridge is
not needed for a normal Linux installation. The existing Vite warning about the lazy
Three.js bundle remains; the build succeeded without suppressing it.

Documentation whitespace and local links were checked after removing local workflow
notes. The preceding six-profile hosting simulation remains documented in
[DEPLOYMENT_REVIEW.md](DEPLOYMENT_REVIEW.md). Actual Docker execution, cloud deployment
and live provider/payment workflows remain external verification requirements.

## Environment

Ubuntu under Termux PRoot, Linux ARM64, Node **22.23.3**. Native Termux Node **26.12.1**
reports `process.platform === "android"`. Go **1.27.3** was installed temporarily from a
checksum-verified distribution because Go was initially absent from PATH. nginx
**1.28.3** was extracted into a temporary tooling directory without installing a system
service. Chromium uses the cached Playwright headless browser. WebGL initialization is
unreliable on this host; final visualization checks use the functional Canvas2D path.

## Executed checks

| Check / command | Result |
| --- | --- |
| Repository inspection | Existing implementation reviewed and retained |
| `npm ci --ignore-scripts --registry=https://registry.npmjs.org --no-audit --no-fund` | Clean dependency installation completed; subsequent dependency fixes installed and lockfile retained |
| `npm run format:check` | Passed across configured source, tests, browser assets and scripts |
| `npm run lint` | Passed |
| `npm run typecheck` | Strict application and test TypeScript checking passed |
| `npm test` | **201 passed**, 0 failures/skips/cancellations; final run 291.65 seconds |
| `npx tsx --test tests/frontend-access.test.ts` | **5 passed**, including code hashing/expiry/replay, public bind policy, OFF/session revocation, delayed-audit race and non-TTY code issuance |
| `npx tsx --test tests/cli-contract.test.ts` | **2 passed**, including all advertised help entries/completions, clean JSON, error exit codes and server start/status/stop JSON |
| `npx tsx --test tests/launcher-build.test.ts` | Passed: failed builds retried; build configuration changes detected; progress stays on stderr |
| `npm run test:remote-tls` with `ASH_NGINX_BIN=/tmp/ash-tools/nginx/usr/sbin/nginx` | **1 passed** against actual nginx: TLS, one-time code and replay refusal, Secure/HttpOnly/SameSite cookies, CSRF, SSE, logout and proxy admin denial |
| `go test ./...` in `tui` | Passed API and UI packages; main package has no tests |
| `go mod verify` in `tui` | All modules verified |
| `go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...` | **No vulnerabilities found** after x/sys upgrade |
| Native Termux Node `--version`, `frontend --help` | Passed; built CLI reports Ash 1.1.0 and TUI available |
| Native Termux `node --import tsx --test tests/money.test.ts tests/security.test.ts tests/transactions.test.ts` | **43 passed**, no skips/failures; used `ESBUILD_BINARY_PATH` for the existing PRoot-installed binary |
| Actual Go TUI PTY smoke | Passed: B OFF→ON displayed a random code and SSH command, B ON→OFF stopped access, clean quit; code captured only in memory |
| `npm run build` with `ASH_GO_BIN=/tmp/ash-tools/go/bin/go` | Backend, prerendered React/browser assets and Go TUI built successfully |
| `npm run validate:deploy` | Render, Railway, Compose, Dockerfile and systemd invariants passed; YAML/JSON parsed |
| `systemd-analyze verify deploy/ash.service` | Exit 0 |
| Current-tree/reachable-history credential scan | No high-confidence credential patterns found; heuristic scope, no history rewrite |
| `git diff --check` and local Markdown target check | Passed after reports were written |

Final aggregate results are recorded above; browser, demo and production-layout evidence
is detailed below. The final `npm run security` audit reported **0 vulnerabilities**.
The log files under `/tmp/ash-*` are local run evidence, not required production files. Final format, lint, typecheck and deployment-invariant checks all passed
after the implementation changes. The credential scan inspected 502 reachable Git
objects and the current public tree, with no high-confidence matches.

## Failures found and corrected

- The first aggregate suite had **199 passes / 1 failure**: the launcher build test
  expected status text on stdout after it moved to stderr. The regression now asserts
  stderr while still checking build retry and configuration invalidation.
- Browser track sign-in still looked for the old “Access token” label. It now requests
  an actual one-time code and submits it through the current accessible form label.
- GPU initialization errors occurred on this host despite a working fallback. A
  capability probe now selects Canvas2D before loading Three.js when WebGL is unavailable.
- Adding real server-lifecycle subprocesses exceeded the old 90-second aggregate CLI
  test budget under concurrent browser/build load. The bound is now 180 seconds; the
  focused rerun passed in approximately 50 seconds. Assertions were retained.
- Earlier processes interrupted by PRoot/libuv errors are not counted as passes.
- Dependency scans found a minimatch advisory and Windows x/sys GO-2026-5024. Dependencies
  were upgraded and the scans rerun. No security controls were disabled for tests.

## Verification boundaries

- Docker client exists, but its daemon is unreachable and the Compose plugin is absent.
  Container build/runtime, UID/volume behavior and container health checks need a Docker
  host or the configured CI job. The compiled-files-only smoke is not a container run.
- Render/Railway accounts, DNS/certificates and private-server systemd runtime were not
  available. Configurations and local TLS behavior are verified; cloud rollout is not.
- Live model/market credentials, human marketplace payment/acceptance pages, actual
  NEAR transactions, TEE/Intents/DAO features and paid services were not exercised.
- macOS and Windows jobs are configured in CI, but neither OS ran in this session.
- Native Termux coverage is the listed smoke/subset, not every feature on every terminal.
- Automated axe audits do not replace a human accessibility review. Hardware-GPU frame
  rates and real-device/network performance need separate measurement.
- Snapshot/backup instructions were reviewed against file-backed storage; no real user
  data was restored or destructively migrated.

## Final workflow and performance evidence

- `npm run test:web`: **23 browser checks passed**. This includes the real code form,
  single-use replay failure, cookie session after reload, task draft/approval boundaries,
  chat, SSE refresh, mobile dragging, reduced motion, visibility suspension, forced GPU
  fallback, track-module failure/retry, and legacy console refresh/logout regressions.
  Both dark and light themes had **zero automated WCAG A/AA violations**. See
  [machine-readable browser results](frontend-browser-results.json) and screenshots.
- Final observed renderer: **Canvas2D**, **1,000 particles**, DPR **1**, sampled **60 FPS**.
  Its recorded 1,002 draw operations are Canvas drawing calls, not GPU draw calls.
  Earlier inherited WebGL software-rendering figures are not comparable. No hardware-GPU
  speedup is claimed, and this short local sample is not a sustained device benchmark.
- Current build: initial JS **275.04 KB / 85.38 KB gzip**; lazy Three.js chunk
  **940.12 KB / 252.73 KB gzip**. The large-chunk warning remains visible. The earlier
  approximately 268 KB initial bundle predates the fallback; no bundle-size reduction
  is claimed for this phase.
- `npm run test:production`: passed using a temporary directory containing only compiled
  files/package metadata and linked dependencies, with `NODE_ENV=production`. Checked
  readiness, OFF default, source-free frontend asset resolution, non-TTY code login,
  OFF/session revocation and SIGTERM/session-file cleanup. An uncontacted loopback
  Ollama endpoint satisfied the live configuration schema; no inference or spending
  was attempted. This does not replace running the production-pruned Docker image.
- `npm run --silent demo -- --headless --json`, launched with only PATH in the environment:
  passed, **4 simulated receipts**, integrity true, negative-budget and wrong-approval
  cases rejected. No code is emitted for the already-stopped headless listener.
- `NODE_ENV=production npm run --silent demo -- --headless --json`: refused with **exit 2**.
- Missing real-mode configuration: `node dist/index.js new --json` returned **exit 2**,
  `CONFIG_INVALID`, and the `npm run demo` guidance with an explicitly absent env file.

The production-layout smoke verifies POSIX SIGTERM handling and runs in CI on Linux/macOS.
Windows still runs the Node/Go suites and builds; its service termination semantics were
not exercised locally. The README hero was recaptured from the current page with focus
cleared and without entering credentials.

Final container configuration review removed the image-level ASH_SERVER_PORT default
so Railway PORT can take effect. The deployment validator passed again, as did executed
configuration assertions for PORT=8090, an explicit ASH_SERVER_PORT=5050 override, and
the absent-variable default of 5050. No container runtime success is implied.
