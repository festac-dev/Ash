# Ash 1.1.0 delivery report

Latest full review: [REVIEW_FOLLOWUP.md](REVIEW_FOLLOWUP.md). It supersedes earlier
verification counts with a fresh audit, fixes and executed results.

The subsequent Docker/hosting simulation review is recorded in
[DEPLOYMENT_REVIEW.md](DEPLOYMENT_REVIEW.md), with additional fixes, test results and
explicit external deployment limits. The original A–K delivery report follows.

Existing working code and the Apache-2.0 license were retained.
This is a local, verified improvement; live provider spending and hosted
production deployment require the owner’s credentials and infrastructure.

## A. Repository audit

[The audit](AUDIT.md) records the requested category/problem/severity/fix table and
resolution evidence. High-priority findings were the broken frontend handoff, ambiguous
public access, demo/live state mixing, incomplete machine-readable CLI output, missing
operational configurations and absent quality gates. Final review also found and fixed
an in-flight login/session-revocation race.

## B. Implementation

- Start and demo retain a working terminal connected to the same backend as the browser,
  with a Node API text shell when Go is unavailable.
- Public landing, private overview and full task controls now have separate routes.
- B advances start (URL/port), code (fresh code/expiry), then close/revoke.
  Frontend starts OFF for normal/demo terminals; task execution stays independent.
- Added `frontend on|off|status|code|logout-all`, with JSON and non-TTY support against
  an existing local service, including the service-user and Docker exec workflows.
- Added an isolated `npm run demo` that exercises ordinary planning, approval, execution,
  simulated hiring, verification and exports, with intentional validation failures.
- Globe starts itself on desktop/mobile; playback controls are removed. Keyboard,
  drag, reduced-motion, accessible details and a Canvas2D fallback remain functional.
- Added reproducible quality gates, deployment configs, operational documentation,
  health/readiness checks and safer dependency versions.

## C. Architecture: before and after

| Before | After | Reason |
| --- | --- | --- |
| Demo waits for browser; fallback runs separate services | Shared terminal client attaches to the existing backend | Keep CLI and browser usable together |
| Landing doubles as dashboard | Public landing, private workspace and linked task controls | Clear navigation and no private data loaded by landing |
| Provider selection embedded in service setup | One model/market composition root | Swap simulation providers without duplicating the engine |
| Demo fixture tasks mixed with ordinary configuration | Private temporary demo driver and mode markers | Protect real credentials and state |
| Short-lived browser URL tickets and weak recovery | Hashed codes, local administration, explicit frontend owner | Reliable SSH/headless handoff and revocation |
| CLI help/output maintained in several places | Shared command catalog plus service-based JSON | Consistent help and scripting |
| GPU-only automatic scene could fail on constrained hosts | Capability probe and projection of the same network in Canvas2D | Preserve functional visualization without a GPU |
| No consistent hosting contract | One persistent instance, health/readiness, shared configuration | Keep Render, Railway, Docker and systemd aligned |

Existing engine, financial rules, schemas, file repositories, React clients and Go TUI
were preserved. No SQL database, queue, multi-replica architecture or production
mock replacement was introduced.

## D. Security

[Security review and threat model](SECURITY.md): 64-bit CSPRNG codes, hash-only memory
storage, constant-time checks, one-use/expiry, eight attempts per minute, private code
output, HttpOnly/SameSite cookies, Secure on HTTPS, CSRF/origin controls, session
revocation including in-flight login, loopback administration and public HTTP refusal.
Financial approval, SSRF/download, atomic persistence and receipt-integrity controls
remain covered by tests. Current-tree/reachable-history credential scanning was
heuristic and did not find high-confidence credentials; history was not rewritten.

Remaining risks: one trusted operator, OS-user access to bearer credentials, terminal
recording, proxy-wide login throttling, filesystem/disk failures and untrusted external
agents/models. TLS, firewall, credentials and real provider reconciliation are external.

## E. CLI product audit

Contextual help/examples, version, bash/zsh/fish completion, quiet/verbose/debug/no-color,
JSON inspection and frontend/server operations, clearer errors and exit codes, progress
feedback, TUI navigation/key hints and the B access dialog were implemented or retained.
Build messages go to stderr. Codes never enter URLs, status history or application logs.
Credentials use environment or owner-only files; subprocesses use argument arrays.

Typed financial/cancellation confirmations remain mandatory. Unsupported JSON mutations
fail explicitly. Completion suggests top-level commands/options; it is not a dynamic
completion engine. Not every terminal emulator or live interactive provider workflow
was available; platform evidence and boundaries are in VERIFICATION.md.

## F. Tests and QA

**214 Node tests and 32 browser checks passed** in the latest full review, alongside Go tests, actual start/demo TUI runs, real nginx TLS,
the offline demo, production-layout smoke and all six local deployment profiles
(54 grouped checks) plus eight startup/activation failure cases. npm and Go scans
reported no vulnerabilities. [Executed commands and results](VERIFICATION.md) are the source of truth. Failed and
interrupted intermediate runs are distinguished from final passing runs. Coverage
includes engine execution, authorizations, budgets, persistence/recovery, frontend
codes/revocation, CLI contracts, demo isolation, real nginx TLS, browser interaction,
accessibility and Go TUI behavior. Tests use temporary data and no production credentials.

## G. Deployment

| Target | Local status | External work |
| --- | --- | --- |
| Render | Blueprint and persistent-disk/health configuration supplied and checked | Create service, secrets/domain, deploy, verify restart persistence |
| Railway | Docker configuration, restart/health policy and volume instructions supplied | Add volume/secrets/domain and deploy |
| Docker/VPS | Multi-stage non-root image and hardened Compose configuration supplied | Docker daemon unavailable here; build/run on a Docker host or CI |
| Private server | systemd unit checked; nginx TLS behavior tested; Caddy/nginx examples supplied | Install under service user, obtain certificates, configure firewall and start service |

No hosted deployment succeeded or was claimed. All targets require one writer per
persistent data directory. [Operations](DEPLOYMENT.md) covers backups, recovery, storage,
shutdown, probes, SSH tunnels and service-local code issuance.

## H. Hackathon

[Official rules/readiness review](HACKATHON.md) and [2–3 minute walkthrough](../DEMO.md)
are provided. Simulation is allowed only through the clearly labeled demo mode. Real
mode never substitutes fixture results. Six local modules are not live NEAR evidence.
The owner must publish/verify the public repository, record a real demo video, post it
on X with the required tags, supply identity/payout details and submit by the published
deadline. No external post or submission was sent.

## I. Review and release readiness

Use [VERIFICATION.md](VERIFICATION.md) and [DEPLOYMENT_REVIEW.md](DEPLOYMENT_REVIEW.md)
to review the executed checks and remaining infrastructure limits. Publication and
deployment remain with the maintainer.

## J. Owner attention

Configure and test live model/market credentials without bypassing approvals. Run the
container and cloud configurations with persistent storage, TLS and restart recovery.
Review historical eligibility, license ownership and public artifacts; publish the demo
video and complete submission. Hardware-GPU/mobile-device performance and cloud-specific
networking still need environment-specific verification.

## K. Delivery checklist

- [x] Repository audited
- [x] Architecture improved
- [x] Code quality improved
- [x] Security reviewed and hardened
- [x] CLI polished and audited
- [x] Tests implemented
- [x] CI/CD configured (remote runner execution remains external)
- [x] Database reviewed (file-backed persistence; no SQL database)
- [x] UI/UX improved
- [x] Performance reviewed (hardware GPU and broader device benchmarks remain)
- [x] Documentation and DEMO.md completed
- [x] Deployment configured for all targets (hosted/container runtime checks remain external)
- [x] Repository hygiene improved
- [x] Production build verified
