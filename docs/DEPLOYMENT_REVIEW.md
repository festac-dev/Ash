# Deployment simulation and second review

Latest rerun: [REVIEW_FOLLOWUP.md](REVIEW_FOLLOWUP.md#completed-hosting-and-failure-checks).
All six profiles passed nine grouped checks each, plus eight startup/activation failure
cases, completing at **2026-11-04T20:37:39.986Z**. Docker runtime testing again stopped
at the unavailable-daemon preflight. Earlier results below retain their historical scope.

Scope: repeat the production, security and deployment review after the initial
application improvements, preserving the existing implementation.

These are **simulations of hosting infrastructure**, not deployments to cloud accounts.
The tests run the actual compiled production server, CLI, authentication, persistence
and proxy paths in isolated temporary directories. Provider inference and payments are
not simulated inside live mode. The separate application demo retains its explicit
simulation boundary and production refusal.

## Audit before changes

| Category | Problem | Severity | Recommended fix |
| --- | --- | --- | --- |
| Deployment verification | Previous production smoke linked the full development dependency tree | High | Verify an independently installed production-only runtime dependency tree |
| Platform coverage | One generic startup test did not exercise each target's port/UI/proxy configuration | High | Parse the checked-in manifests and exercise a local platform matrix |
| Recovery | Hosted restart, storage disappearance and backup restoration were documented but not executed | High | Exercise real process restart, isolated storage faults and restore in the matrix |
| Container CI | CI built an image but did not run it | High | Load and run the image, test health, non-root identity, read-only root, volume persistence, code access and stop |
| Startup assets | An explicitly enabled production UI could accept startup without its compiled assets | Medium | Fail startup or frontend activation with a clear error if required assets are absent |
| Readiness | A filesystem call that never resolves can leave the readiness response waiting indefinitely | Medium | Bound response time while retaining one in-flight storage probe |
| Authentication/CLI | Code hashing, expiry, revocation, CSRF and local administration need full rerun against hosted-like TLS | High | Reuse real application routes and subprocess CLI, with codes confined to memory |
| Execution/financial state | Changes must not bypass existing budget, approval, receipt and provider controls | High | Rerun full unit/integration, Go, browser, offline demo and security checks |
| External infrastructure | No Docker daemon; no hosted account access | Informational | Label local simulations; make real Docker runtime checks reproducible in CI and report unavailable evidence |

No hosted or container success is inferred from a simulation. The results below
separate executed application checks from unavailable infrastructure.

## Additional findings during execution

- An activation failure after a configured frontend was stopped left `running=false`
  but `suppressed=false`. This was reproduced against the prior compiled implementation.
  Activation now restores the prior access gate on error, with a regression test.
- `doctor` reported the configured boot flag as the current frontend state, and remote
  status could use the original session URL after a toggle. It now queries current
  frontend status and reports `web.start_on_boot` separately.
- Native npm rejected 189 mirror tarball URLs in the lockfile. Those URLs now use the
  official registry; every package version and integrity hash was retained. Security
  settings were not disabled to allow the mirror.
- PRoot/libuv/futex failures interrupted an early matrix after two profiles. Those
  partial results are not counted as a complete run. Native Termux Node was selected,
  abandoned headless browser processes were cleared, and the matching Vite esbuild
  binary was used for the shared PRoot dependency installation.
- OS core limits could allow sensitive process memory to enter crash files. Docker's
  exec-based entrypoint, Compose and systemd now disable core dumps. Trusted CLI shell
  guidance documents the remaining operator responsibility.
- CI clears previous verification reports and generated browser screenshots before
  testing, so a failure before a test starts cannot upload an earlier run's evidence.
  Browser artifacts include only the browser suite's screenshots, not historical CLI captures.
- An earlier matrix failed during private-server setup/cleanup; its cleanup exception
  masked the original failure. The harness now preserves the first failure and closes
  proxies even when runtime creation or stopping fails. Interrupted foreground runs
  were not counted; the final matrix was run as a detached process with durable exit logs.

## Meaning of the simulation

Application code runs with NODE_ENV=production and actual authentication/persistence.
Test tasks are clearly named deployment-check drafts; no provider results or paid work
are invented. Only infrastructure is simulated: temporary storage paths, loopback
TLS/HTTP proxies and process supervision replace cloud services. Production demo-mode
refusal remains intact. Real SSH authentication, Docker namespaces/cgroups/read-only
mounts, platform edge routing, domain certificates and account deployment require the
corresponding external environment. The Docker-specific command exercises those
container controls when a daemon is available.

## Executed regression and quality checks

| Command | Result |
| --- | --- |
| `npm test` | 203 passed, no failures/cancellations/skips; 347.97 seconds |
| Focused CLI, launcher, access, readiness, remote and demo suite | 32 passed; one CLI wizard timed out under concurrent host load |
| `node --import tsx --test --test-name-pattern='CLI wizard' tests/cli.test.ts` | Isolated rerun passed in 32.20 seconds, with original assertions and timeout unchanged |
| `npm run format:check` | Passed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run security` | Official npm registry: zero reported vulnerabilities |
| `npm run build` | Backend, React/Vite assets and Go TUI passed; latest launcher correction also compiled by `npm run build:server` |
| `npm run test:remote-tls` | One integration test passed against actual nginx, including TLS/code login, cookie policy, CSRF, SSE and revocation |
| `go test ./...` in `tui` | API/UI packages passed from Go's test cache; main package has no tests |
| `go mod verify` | All modules verified |
| `go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...` | No vulnerabilities reported |
| `npm run validate:deploy` | Parsed YAML/JSON and deployment invariants passed |
| `npm run test:deployments` | Passed: six profiles, 48 grouped checks, eight startup/activation failures and the TCP-guard self-test; final run 16 minutes 46 seconds on the shared host |
| `npm run test:container` | Failed clearly at daemon preflight: no reachable Docker daemon; no container runtime pass claimed |
| `npm run test:production` | Passed source-free startup, OFF default, assets, non-TTY code login, revocation and SIGTERM cleanup |
| `npm run demo -- --headless --json` | Passed: `simulated: true`, completed task, four receipts, integrity true, invalid-budget and wrong-approval cases rejected |
| `node --import tsx scripts/test-web.mjs` (`npm run test:web` entry point) | 23 browser checks passed under Linux Node/Chromium; zero automated WCAG A/AA violations in both themes |
| `systemd-analyze verify deploy/ash.service` | Exit 0; systemd service was not launched |
| Entrypoint `ulimit -c` check | Child process core limit is zero |
| Lockfile comparison against the prior version | All package versions/integrity hashes unchanged; 189 registry URL replacements |
| Final credential-pattern scan | No high-confidence matches across 222 non-ignored working-tree files and 558 reachable history blobs; heuristic coverage |
| Local Markdown link scan | No missing local targets |
| `git diff --check` and CI YAML parse | Passed; CI removes previous evidence before checking |

The focused suite was run with `node --import tsx --test --test-concurrency=2` over
`cli-contract`, `cli`, `launcher`, `launcher-build`, `frontend-access`, `health`,
`remote` and `demo` test files. It includes the latest `doctor` status correction;
the timed-out wizard was rerun alone rather than changing its deadline.

Node commands used native Termux Node 26.12.1 / Android ARM64 after PRoot runtime
interruptions. The shared dependencies had been installed under Linux, so tsx checks
used `ESBUILD_BINARY_PATH=$PWD/node_modules/@esbuild/linux-arm64/bin/esbuild`, while
Vite used its own matching binary under `node_modules/vite/node_modules/@esbuild/`.
This is a local cross-environment workaround, not a required application setting.
Go used `/tmp/ash-tools/go/bin/go`; TLS used
`ASH_NGINX_BIN=/tmp/ash-tools/nginx/usr/sbin/nginx`. CI retains Node 22 on supported
desktop/server runners. Native Android does not reproduce Linux container isolation.

The final browser run used Linux Node 22 with `ASH_BROWSER_ARGS='["--no-zygote"]'`.
It refreshed the browser report and screenshots. The sampled Canvas2D scene reported
55 FPS, 1,000 particles and pixel ratio 1. This is one local sample, not a claim of
performance improvement or hardware-WebGL coverage. The existing lazy Three.js chunk
remains about 940 kB uncompressed / 251 kB gzip and still produces Vite's size warning.

## Reports and reproduction

All six local profiles completed their eight grouped lifecycle/security/recovery
checks: Docker Compose, Render, Railway dynamic PORT, Railway frontend OFF at boot,
private server TLS and private server SSH forwarding. These are 48 grouped checks,
not 48 additional unit tests. The JSON report records the final startup-failure
checks and overall result: **passed**, completed at `2026-11-04T16:42:43.557Z`.

- [Hosting simulation results](deployment-simulation-results.json) record the runtime,
  timestamps, scenario checks and whether the complete matrix passed.
- [Actual container results](container-runtime-results.json) record the failed local
  Docker preflight. No daemon was reachable; no container success is claimed.
- `npm run build && npm run test:deployments` repeats the local hosting matrix using
  an independent production-only dependency installation.
- `docker build -t ash:ci . && npm run test:container` repeats the actual image check
  on a Docker-capable machine. CI now builds, loads, runs and records the image check.

The Docker check requires an already-built image and refuses implicit image pulls.

The harness checks its TCP guard against positional, object and normalized socket
arguments, permits only the local application's port, and rejects provider connections.
Codes/cookies remain in memory; failures report safe stage/primitive assertion details
instead of dumping child output. Temporary resources are cleaned up even after a failed
runtime construction or stop; an earlier test failure is preserved if cleanup also fails.

## Remaining external verification

Render/Railway account provisioning, edge routing, persistent-disk ownership, private
server firewall and systemd enforcement, SSH authentication, public certificates and
real Docker namespaces/cgroups/mount enforcement need their actual environments.
No cloud was deployed, no remote CI execution was verified, and no live model/marketplace/payment call
was attempted. Before enabling paid work, run a reviewed live task and reconcile its
provider result and financial state. The existing single-instance storage constraint
remains; none of these checks establish multi-replica or multi-tenant safety.


## Workspace-route follow-up — 4 November 2026

The hosting simulation was executed again after the terminal/workspace changes.
All six profiles passed nine checks each, plus eight startup/activation failure cases.
This includes serving `/`, `/workspace` and `/workspace/controls` through each local
proxy profile. A fresh production-only dependency installation and the outbound-provider
network guard were used. Updated machine-readable evidence is in
[deployment-simulation-results.json](deployment-simulation-results.json).

The separate production-layout smoke also verified the compiled workspace assets,
frontend OFF by default, non-TTY code login, revocation and clean SIGTERM shutdown.
These results still do not constitute a Docker daemon run or a hosted deployment.
