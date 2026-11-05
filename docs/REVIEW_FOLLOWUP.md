# Full review follow-up

Scope: current working tree after the workspace presentation changes. Existing edits,
configuration and data are preserved. Results in older reports are historical until
explicitly rerun here. No external deployment is inferred from a local simulation.

## Audit before fixes

| Category | Problem | Severity | Recommended fix |
| --- | --- | --- | --- |
| External downloads | Socket inactivity timeout and an after-the-fact duration check do not bound DNS or a slow streaming response; redirects also drain unbounded bodies | High | Enforce one total deadline through DNS, redirects and response bodies; abort active sockets and close redirect bodies |
| Browser test entry point | Standalone console check does not supply the screenshot callback now required by its shared checks | Medium | Update and execute the standalone entry point, including supported browser flags |
| Live workspace | Simulation-only track buttons appear in live mode even though the API refuses them | Medium | Show the six verification tracks only in demo mode and test the live browser/API boundary |
| Documentation | Architecture/API still describe URL or persisted tickets, and the security introduction describes the old first-B behavior | Medium | Align both documents with terminal-only codes and the three-step B sequence |
| CI evidence | Cleanup/upload globs only include frontend screenshots, omitting workspace/guide/controls captures | Medium | Include every current browser screenshot family in cleanup and upload |

## Review coverage

Authentication/code lifecycle, browser session/CSRF boundaries, local administration,
external fetch and artifact guards, task/receipt persistence, budget/approval gates,
real/demo provider separation, CLI and TUI lifecycle, frontend state/appearance,
accessibility, build assets, dependency integrity, CI and deployment configuration were
reviewed. Full tests, browser checks and infrastructure simulations completed below.

## Fixes and reproduced failures

- A loopback streaming fixture reproduced the missing total download deadline; DNS
  delay and redirect-chain cases also failed before the fix. All four new regressions
  pass after the fix. Normal content, truncation and content-type checks remain covered.
  Test timing uses enough margin for PRoot scheduling and waits for actual socket close.
- A real-mode browser session reproduced the unwanted `#tracks` section. The overview
  and navigation now render it only in demo mode; the API still refuses fixture execution
  in live mode. No backend security control was relaxed.
- The standalone console script now supplies its screenshot callback and supports the
  same explicit browser flags as the main suite. CI cleans and uploads frontend,
  workspace and controls screenshots.
- Architecture, API, remote-access and security text now agree on terminal-only codes,
  POST redemption, non-persistent codes and the three-step B sequence.

## Executed verification

- Fresh isolated `npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org`:
  332 packages installed. The existing dependency directory and `.env` were untouched.
- Full unit/integration suite: **214 passed**, zero failures/skips/cancellations,
  320.39 seconds; the earlier baseline was 210 passed before adding the four download tests.
- `npm run typecheck`, `npm run lint`, `npm run format:check`: passed. Lint/format were
  repeated after the live-workspace fix.
- Backend, web and Go TUI production build: passed. Web was rebuilt after the live-mode
  correction. The existing lazy Three.js chunk-size warning remains.
- Go API/UI tests and `go mod verify`: passed. `govulncheck@v1.9.0`: no vulnerabilities found.
- `npm run security`: official npm registry reported zero vulnerabilities.
- Heuristic credential scan: 241 non-ignored working files and 581 reachable history
  blobs examined; matches were synthetic values in security tests only. No credential
  values were printed. This is not an exhaustive proof of absence of secrets.
- Local Markdown link check: 90 links checked, no missing targets at that stage.
- Current hackathon website re-read; requirements and preparation guidance noted in
  [HACKATHON.md](HACKATHON.md). Nothing was submitted or published.

An intermediate demo/browser attempt hit Termux/PRoot libuv/futex errors. That run
is not counted as a pass; the affected stages are rerun serially below. DNS cancellation
is bounded at the application boundary; the operating system's in-progress lookup
itself cannot be cancelled by Node.

- `node --import tsx scripts/test-console.mjs`: six standalone controls checks passed.
- `npm run test:web`: **32 checks passed**, including the new live-mode UI/API regression;
  zero automated WCAG A/AA violations on the audited dark/light pages. The 13 screenshots
  were regenerated. This host used Canvas2D (sampled 60 FPS, 1,000 particles, DPR 1),
  not hardware WebGL; no performance improvement is inferred from that sample.
- `npm run test:production`: compiled-files-only startup, readiness, separate routes,
  shared appearance assets, code login, revocation and graceful shutdown passed.
- `npm run test:remote-tls`: real nginx TLS integration passed (cookie policy, CSRF,
  code replay refusal, SSE, logout and proxy administration denial).
- Actual PTY runs of both start and demo passed: B starts without a code, second B
  displays a code that successfully redeems, third B revokes the session while the
  core API survives, and Q exits cleanly. Codes stayed in memory.
- `npm run demo -- --headless --json`: completed, four receipts, integrity true,
  explicit `simulated:true`, two expected rejected inputs, frontend OFF.
- `npm run validate:deploy` and `systemd-analyze verify deploy/ash.service`: passed.
- Parsed CI YAML; cleanup and upload globs cover all 13 current browser screenshots.

The first serial rerun of demo, standalone controls and full browser checks passed
following the host-runtime interruption. No application security settings, assertions
or test deadlines were disabled to obtain these results.

## Completed hosting and failure checks

`npm run test:deployments` completed successfully at **2026-11-04T20:37:39.986Z**.
It installed locked production-only dependencies into an isolated runtime and exercised
the actual compiled application with temporary data and local transport proxies.

| Hosting profile | Result |
| --- | --- |
| Docker Compose | Nine grouped lifecycle, security and recovery checks passed |
| Render | Nine checks passed |
| Railway dynamic PORT | Nine checks passed |
| Railway frontend OFF at boot | Nine checks passed |
| Private server TLS | Nine checks passed |
| Private server SSH forwarding | Nine checks passed |

All **54 grouped checks** passed. They cover separate page routes, private code issuance
without a TTY, login/replay/cookie policy, CSRF, proxy administration denial, persisted
drafts, SSE, graceful shutdown, restart revocation, storage outage/readiness, private
file permissions, backup restoration, crash recovery and credential-free service logs.

All **eight startup/activation failure cases** passed: missing model configuration,
production demo refusal, public plain HTTP refusal, invalid storage mount, occupied
port, missing entry HTML, missing entry script and failed activation retaining OFF.
The provider-network guard also passed its self-test. No model inference, marketplace
calls or payments were made. Evidence: [deployment-simulation-results.json](deployment-simulation-results.json).

`npm run test:container` returned **exit 1 at Docker daemon preflight**: no reachable
daemon. It did not build or run a container. The failure is retained in
[container-runtime-results.json](container-runtime-results.json).

## Final review outcome and limits

The five findings in this review were addressed and their relevant checks passed.
Application verification is complete for this local environment; external release
verification remains:

- Run the actual Docker image on a Docker-capable host or the configured CI job.
- Verify Render/Railway accounts, volumes, edge routing and deployment; verify private
  server systemd/firewall enforcement, SSH authentication and public certificates.
  The SSH profile models forwarding with a local proxy, not an authenticated SSH session.
- Exercise a reviewed live provider task and reconcile its real result and financial
  state before enabling paid work. Local simulation is not evidence of a live NEAR transaction.
- Check hardware WebGL and physical mobile devices. This host exercised Canvas2D;
  the existing lazy Three.js bundle-size warning remains.
- Publish the required repository/video and complete the hackathon submission.

No hosted deployment or remote CI result is claimed. Existing local work and `.env`
were preserved. The local runtime selection and Termux/PRoot limitations are recorded
in [VERIFICATION.md](VERIFICATION.md).

## Sidebar, first-login guide, terminal controls and orbit follow-up

This section covers the subsequent targeted UI fixes. The verification counts above
belong to the earlier review. Existing routes, APIs, fonts, palette and provider
implementations are retained.

| Finding | Fix |
| --- | --- |
| Task controls opened a separate page and lost workspace navigation | Mount the existing controls inside the shared shell; hash navigation preserves history and deep links |
| Sidebar had no persistent desktop collapse or accessible mobile drawer | Add a saved icon rail and a mobile drawer with active labels, focus containment, keyboard controls and reduced-motion transitions |
| Guide opened before code validation | Initialize it from confirmed session state; keep the sign-in form separate and persist dismissal |
| Terminal navigation measured shorter labels than those actually rendered | Measure rendered widths, separate buttons and keep overflow actions reachable through More |
| Empty-state and browser-access actions lacked mouse targets | Register targets at the displayed controls; retain the existing keyboard actions |
| CLI output mixed diagnostic noise with interactive output | Use aligned status fields, concise progress/error messages and neutral status styling; honor NO_COLOR and redirected output |
| Orbit closing seam contained a duplicate endpoint | Close the loop once, increase circle sampling, enable edge antialiasing and close the Canvas2D path |

Browser verification also reproduced a drawer focus failure: animating visibility
left the opening links temporarily unfocusable. Opening now makes them visible
immediately; only the closing transition delays visibility. The existing slide
transition is retained. The backdrop is excluded from the tab order, Help closes
the drawer before opening its dialog, and Skip to content preserves the selected
section instead of replacing its URL hash.

README, DEMO.md and the frontend/TUI guides now describe authenticated onboarding,
persistent navigation and clickable terminal controls.

### Verification of the targeted fixes

- `npm run format:check`, `npm run lint`, `npm run typecheck`: passed. The final
  test-only edits also passed targeted Prettier/ESLint checks.
- `npm run build`: backend, browser and Go TUI passed; `npm run build:web` rebuilt
  the final navigation fixes. The existing lazy Three.js chunk warning remains.
- `GOMAXPROCS=2 /tmp/ash-tools/go/bin/go test -p 1 ./...` in `tui`: passed,
  including clicks on rendered button positions at 28–120 columns, Send,
  empty-state task creation, overflow actions and browser access.
- Native Node focused regressions: 14 passed, zero failures/skips/cancellations.
- `node --import tsx scripts/test-console.mjs`: seven grouped controls checks
  passed after correcting the reproduced navigation/focus issues.
- `node --import tsx scripts/test-web.mjs`: 33 grouped checks passed; 14 screenshots
  refreshed, with zero automated WCAG A/AA violations on audited pages. The final
  suite also waits for the drawer animation to finish before capturing it.
- Actual 80×30 PTY runs of both `start` and `demo`: B started the frontend; mouse
  events clicked Get code and Stop web, the displayed code redeemed successfully,
  stopping revoked the session, the core API survived, and Q exited cleanly.
  Codes stayed in memory. The initial PTY harness expected shortcut prefixes that
  are intentionally omitted below 90 columns; correcting its readiness selector
  required no application change.

The browser commands used `ASH_BROWSER_ARGS='["--no-zygote"]'` on Linux Node 22
inside Termux/PRoot; tsx used the installed Linux ARM64 esbuild binary explicitly.
This host rendered the globe through Canvas2D. Ring geometry was verified
numerically; hardware WebGL appearance and physical-device touch still need a
device check. No hardware-GPU performance improvement is claimed.

- Final full `npm test`: **216 passed**, zero failures, skips or cancellations,
  332.02 seconds. It ran on native Termux Node 26 with
  `PATH=/data/data/com.termux/files/usr/bin:$PATH` and
  `ESBUILD_BINARY_PATH=$PWD/node_modules/@esbuild/linux-arm64/bin/esbuild`.
  The earlier serial run had 215 passes and one test-fixture failure: the old
  positive color test inherited `NO_COLOR=1`. Its setup now isolates and restores
  that environment; the negative NO_COLOR/non-TTY test still passes. No application
  behavior or assertion was weakened. The entire suite was rerun after this fix.
- `npm run test:production`: passed compiled-files-only startup, readiness, OFF
  default, landing/workspace assets, non-TTY code issuance/redemption, revocation
  and SIGTERM cleanup. This is a local runtime check, not a Docker or hosted deployment.
- `npm run typecheck` passed again after the final test-fixture edit.
- `git diff --check`: passed. Existing configuration and unrelated local edits
  were preserved; no new dependency was needed for this follow-up.

## Footer, responsive layout and CLI clarity follow-up

Ran the installed OpenCode 1.19.3 TUI in an isolated 100×32 terminal, inspected its
home screen and command palette, and exited cleanly. Its spacing, compact hints and
separation of actions from status informed this pass; Ash keeps its existing stack,
commands and visual identity.

Reproduced layout defects before editing:

- On a 1440×2400 viewport, the landing footer ended at approximately 1395px,
  leaving more than 1000px beneath it. The landing shell now fills the viewport
  with normal flex layout; the footer follows long content without overlaying it.
- The mobile wordmark overlapped the demo badge; the 320px workspace also overflowed
  horizontally. The header now protects the brand's width, uses a labeled Disconnect
  icon on narrow screens, and keeps only the Ash mark at 360px and below.
- The mobile drawer started 10px below the header and ended around 566px on an 844px
  screen. It now fills the available dynamic viewport and scrolls on short screens.

CLI cleanup removed repeated navigation shortcut prefixes, backend implementation
explanations and instructional empty-state text. The footer now uses compact,
contextual hints. Agent search gained a mouse target that focuses the existing input.
Financial confirmation phrases, simulation labels and error feedback remain intact.

Verification for this follow-up:

- Format check, lint, type check and the full backend/web/TUI build passed.
- Full browser suite: **35 grouped checks passed**, with 14 refreshed screenshots
  and zero automated WCAG A/AA violations on audited pages.
- New layout checks cover 11 viewport profiles from 320×568 through 2560×1440,
  including 1440×2400, tablet and short landscape layouts, both landing themes,
  and device pixel ratio 2. They check footer placement without content overlap,
  header spacing, drawer height and access to the last navigation item.
  Measurements wait for asynchronous canvas resize updates before inspecting layout.
- Go API/UI tests passed, including footer placement on all nine screens across
  28–160 columns and a click test for agent search.
- Actual start/demo PTYs passed resizing to 32×18, 160×60 and back to 80×30,
  code issuance and frontend stopping by mouse, code redemption, session revocation,
  core API survival and clean exit.
- Compiled-runtime production smoke passed readiness, page assets, non-TTY code
  issuance/login, revocation and SIGTERM cleanup.
- `git diff --check` passed. No dependencies or environment files were changed.

Screen coverage is automated Chromium viewport testing, not certification of every
physical device or browser. This host used Canvas2D; hardware WebGL remains unverified.

## Feature-card edge clipping — 2026-11-05

The three landing feature panels had no horizontal padding and only a top border.
At 320px, the first panel's right edge and its “01” label both ended at x=296px;
the new content-inset regression failed on that layout before the CSS change.

The cards now have complete rounded borders, horizontal padding, safe grid sizing
and wrapping. Stacked mobile cards have a small gap. Text, icons, colors, fonts,
backgrounds and the existing depth/hover behavior are preserved.

Format check, lint, type check and the production web build passed. The full browser
suite passed **36 grouped checks**, including card content bounds across 11 viewport
profiles in both themes, hover behavior, footer placement, navigation, authentication,
workspace workflows and automated accessibility audits. All 14 existing screenshots
were refreshed. `git diff --check` passed. This was a frontend CSS and regression-test
change; no CLI, API, configuration or dependency changes were needed.
