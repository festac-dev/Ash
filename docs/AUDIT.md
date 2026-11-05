# Ash repository audit

## Terminal and workspace follow-up

| Category | Problem | Severity | Recommended fix |
| --- | --- | --- | --- |
| Demo lifecycle | Demo finishes its walkthrough and waits for the browser without opening a terminal client | High | Attach an interactive terminal to the same demo backend; keep headless automation available |
| Terminal fallback | Missing Go binaries fall back to a separate service instance | High | Provide a terminal client of the shared API so browser and terminal use the same task authority |
| Frontend control | B has a two-state toggle; the requested sequence is OFF → ON → code → OFF | Medium | Track the next action on the server, preserve OFF at startup and revoke access on the final step |
| Navigation | The public landing page doubles as the working dashboard | High | Separate public landing, authenticated workspace overview and existing task controls into distinct routes |

The latest requested behavior keeps the frontend OFF for both normal startup and demo.
The first B starts it, the second issues the code, and the third closes it.

Audit started 4 November 2026, before implementation.
Existing engine, integrations, React UI, Go TUI, tests, and Apache-2.0 license are retained.

## Scope and architecture

Inspected entry points (`src/index.ts`, launcher, standalone API, Go main), strict
TypeScript configuration, dependencies/lockfiles, API routing/authentication, task and
receipt stores, approval/budget enforcement, marketplace/model adapters, subprocess and
artifact guards, React authentication and globe lifecycle, terminal rendering/commands,
tests, CI, environment configuration, deployment files, documentation, and Git history.

Ash uses Node 22 / TypeScript, a file-backed transactional task store, React 19 / Vite /
Three.js, and Go / Bubble Tea. It has no SQL database or user/role directory. A bearer
token authorizes a single trusted operator; browser sessions carry the same authority.
The six local track modules use explicitly simulated inputs; live integration claims
must remain limited to implemented marketplace/model adapters.

| Category | Problem | Severity | Recommended Fix |
| --- | --- | --- | --- |
| Browser login | B reports an opener as successful after process start, even if the opener exits unsuccessfully; fallback exposes only an unsigned URL and assumes a fixed token exists | High | Await opener result, preserve a usable private fallback, exercise full browser handoff |
| Browser login | One-time links expire and rotate; authentication bootstrap has no recovery guidance and removes the fragment before success | Medium | Single-flight login exchange, actionable expired-link state, test replay rejection and session persistence |
| Browser listener | Listener binds IPv4 but advertises localhost; some mobile resolvers prefer IPv6 | Medium | Advertise the actual loopback address consistently |
| CLI output | `--quiet` still prints startup checks; headless commands inherit interactive presentation and strip flags indiscriminately | High | Parse flags centrally, suppress startup chatter, provide honest structured results |
| CLI commands | Global help intercepts every subcommand; missing completion, debug and consistent exit-code handling | Medium | Shared command catalog, contextual help, completion, explicit error codes |
| TUI UX | B/help/new-task shortcuts are hidden, footer is generic, dense navigation loses clarity at narrow widths | Medium | Visible contextual key hints, restrained hierarchy, responsive layouts, width regression checks |
| Globe | Phone view requires manual enable; play/step/reset controls conflict with requested automatic visualization | Medium | Automatically load adaptive scene; remove transport buttons; retain reduced-motion and visibility throttling |
| Operations | Render/Railway/Docker/Compose/systemd configurations absent | High | Consistent single-instance persistent-storage deployment configurations |
| Health | Existing `/api/health` requires authentication; no readiness endpoint for deployment probes | High | Minimal public liveness/readiness, storage checks, draining semantics |
| Errors/logging | Entrypoint prints raw unexpected error messages; no unified machine-readable failure contract | Medium | Redact at output boundary; debug-only stack traces; typed JSON errors |
| Security | Existing origin/header checks, expiring sessions, SSRF guard, approvals and receipt validation need regression verification | High | Preserve controls; test authentication, forbidden origins, one-use links, and integrity failures |
| Dependencies | Configured npm mirror does not implement vulnerability audits | High | Audit official registry; record actual results, never treat mirror failure as a clean audit |
| Data reliability | File-backed state and advisory locks require one process per data directory; no operational backup/recovery runbook | High | Document single replica, quiesced backup, restore and integrity verification |
| Quality gates | Strict TS/tests exist; lint/format/dependency checks are missing in CI | Medium | Add reproducible quality gates with minimal development dependencies |
| Tests | Current browser checks test manual globe controls and do not exercise B login in a real browser | High | Add end-to-end one-time authentication and automatic/mobile globe regressions |
| Documentation | README is long, references moved docs, and lacks a focused judge walkthrough/changelog/contribution guide | Medium | Concise landing README, verified screenshots, demo script, operational docs |
| Performance | Globe already lazy-loads and adapts DPR, but mobile auto-start needs measurement | Medium | Record browser measurements before/after; keep lazy loading and offscreen suspension |
| Hackathon | Public repo/demo post and NEAR integration evidence cannot be assumed | High | Read current official requirements; document supported tracks and outstanding submission steps |
| Repository hygiene | Generated browser reports need provenance; secrets/history need scanning | High | Keep source and generated artifacts separate; scan paths/history without printing secrets |
| Licensing | Apache-2.0 already exists | Informational | Preserve existing license and ownership |

## Verification environment

The shell runs Ubuntu in Termux PRoot on ARM64; native Termux checks will be reported
separately from PRoot checks. Go was absent from PATH at audit time. Chromium is cached.
No deployment account credentials were supplied. A local Docker executable does not
prove that a Docker daemon is available. Results and resolutions are recorded in
[VERIFICATION.md](VERIFICATION.md) and the final report as checks complete.

## Resolution record

| Finding | Resolution and evidence |
| --- | --- |
| B activation/code loss | State-aware toggle, private code dialog and local-only frontend commands; Go regression, API tests and actual PTY checks |
| URL/persisted tickets | Removed; random hashed single-use codes are redeemed by POST, with expiry and lockout |
| Revocation race discovered during final review | Create the browser session before awaiting its audit write; a controlled concurrent OFF/login regression verifies revocation |
| Public exposure | Loopback default, OFF default, explicit HTTPS/public binding policy, local-only administration, proxy route denial and TLS integration test |
| CLI output and command help | Shared help catalog/completion, typed exit codes, clean JSON for inspection/frontend/server lifecycle; build progress moved to stderr |
| TUI discoverability | Visible key hints, clearer navigation, B code/tunnel dialog, preserved chat input handling and narrow-terminal tests |
| Automatic globe / GPU loss | Automatic desktop/mobile animation, accessible manual exploration, reduced motion and real Canvas2D network fallback; browser interaction checks |
| Demo contamination | Isolated temporary configuration, provider composition, explicit simulation labels, production guard, mode markers and zero-outbound-call test |
| Dependencies | npm dependencies audited on official registry; minimatch override updated; Go x/sys upgraded from 0.36.0 to 0.44.0 for GO-2026-5024; Go toolchain scan rerun |
| Quality gates | Strict typing retained, formatter/linter added, tests and builds in CI on three OSes, Linux TLS/browser checks, demo smoke and container build job |
| Deployment blockers | Render/Railway/Docker/Compose/systemd/proxy configs added, health/readiness and shutdown reviewed; runtime cloud/container verification remains external |
| File-backed persistence | No schema rewrite; transactions, locks and receipt recovery retained and tested; one-instance limit and quiesced backup/restore documented |
| Documentation | Current README, demo walkthrough, architecture/API/security/deployment guides, contribution guide and changelog; historical performance claims marked as historical |
| Performance | Lazy GPU bundle preserved; measured browser results distinguish Canvas2D from WebGL. Large Three.js chunk and hardware-GPU performance remain limitations |
| Repository/public safety | Existing implementation retained; generated build/dependency data ignored; heuristic credential scanning |
| Submission | Official rules reviewed; owner must publish repository/video, provide identity/account details and submit links |

See [VERIFICATION.md](VERIFICATION.md) for actual commands/results and [FINAL_REPORT.md](FINAL_REPORT.md)
for the final scope, limitations and review steps. A configured deployment is not an executed deployment.

## Deployment review follow-up

The subsequent review requested Docker and hosted deployment simulations. Its audit,
reproductions, commands and external limits are recorded in
[DEPLOYMENT_REVIEW.md](DEPLOYMENT_REVIEW.md).

| Category | Problem | Severity | Resolution |
| --- | --- | --- | --- |
| Startup | Enabled production UI could start with missing compiled entry assets | Medium | Validate entry HTML, referenced assets and console files before startup/activation |
| Access control | Failed activation after OFF restored an inconsistent browser gate | High | Preserve the previous OFF gate on failure; add direct and subprocess regressions |
| CLI | `doctor` confused boot configuration with current frontend state | Medium | Query the running service; expose `start_on_boot` separately |
| Readiness | Stalled storage could leave a probe response pending indefinitely | Medium | Two-second response bound with one underlying storage probe |
| Credential handling | OS core dumps could capture credentials in memory | High | Disable dumps in the container entrypoint, Compose and systemd; document CLI-shell limits |
| Dependency install | Mirror tarballs were rejected by native npm | Medium | Official registry URLs; all 189 URL changes retain versions and integrity hashes |
| QA/operations | No per-target runtime/recovery matrix or container runtime CI | High | Production-only installation, six local hosting profiles, startup failures, restore tests and actual-image CI command |
| Infrastructure evidence | Local Docker daemon and hosting accounts unavailable | Informational | Explicit failed Docker preflight; no claim of external deployment success |


## Terminal and workspace resolution

| Category | Resolution | Evidence |
| --- | --- | --- |
| Terminal lifecycle | Start and demo attach a TUI or API text shell to one backend | Subprocess regressions and actual PTY runs in both modes |
| Frontend sequence | Server-owned OFF → ON without code → code → OFF; overlapping actions rejected | API/Go regressions and actual displayed-code redemption followed by session revocation |
| Code visibility | Direct terminal access responses display the code; generic output and logs remain redacted | Text-shell code redemption regression and audit-log checks |
| Navigation/privacy | Separate landing, private overview and full task controls; console alias retained | Chromium route, private-request, reload, logout and deep-link checks |
| Accessibility | Restored task-node list, responsive navigation and both workspace themes | 26 browser checks; no automated WCAG A/AA violations in landing/workspace dark/light themes |
| Shutdown | Interrupted demo stops its flow and owned backend; detached services survive client exit | Signal, EOF, quit and shared-service regressions |

## Full review after presentation updates

The subsequent full review found and fixed a missing total deadline on external
streaming downloads, a standalone browser-test callback regression, demo-only actions
visible in live mode, incomplete CI screenshot evidence and obsolete code-access docs.
See [REVIEW_FOLLOWUP.md](REVIEW_FOLLOWUP.md) for reproductions, severity, actual checks
and the remaining external verification boundaries. The original audit above is
retained as historical evidence.
