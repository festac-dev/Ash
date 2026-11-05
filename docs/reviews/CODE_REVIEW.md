# ASH code review — 3 November 2026

This review covers the existing ASH application, its six selected NEAR hackathon scopes, the terminal client and browser frontend. It preserves the pre-existing work in the checkout. The working-tree diff also contains earlier frontend and terminal changes; it should not all be attributed to this review.

## Coverage

All 166 files in the review inventory were examined: 132 source, test, script and configuration files; 18 documents; 12 visual assets; and four generated dependency/report files. Source and tests were read in sections across the review sessions. The inventory records the final content hashes and review method in [code-review-coverage.json](code-review-coverage.json).

Generated npm/Go dependency metadata was checked structurally, against package declarations, available security advisories and Go module checksums. SVGs were parsed for external/executable content and PNGs decoded and visually inspected. This is not a claim to have manually audited every byte of third-party code in `node_modules`, compiled output, or image compression. Git internals, private `.env` values, runtime task data and generated build output are excluded. The two review-report files are additional deliverables outside the original inventory.

## Corrections

| Area | Confirmed failure and correction | Regression evidence |
| --- | --- | --- |
| Human verification | A human rejection could pass without a human criterion. Rejection always fails; a human pass cannot override failed deterministic checks. Subjective review remains available when the provider is unavailable. | `tests/verifier.test.ts` |
| Dependencies | Pending subtasks could start before prerequisites. Scheduling now uses readiness and respects the parallel limit. | `tests/engine.test.ts` |
| Spending boundary | An in-call hire could spend before the final quote check. Pro operations require a supported vendor-side price ceiling and matching approval. Unsupported unbounded calls are refused. | Engine and MCP tests |
| Funding recovery | Pause/cancel or failed accounting could discard returned job evidence. The job and observed amount/currency are persisted first. Missing, invalid or mismatched funding evidence pauses with `RECONCILIATION_REQUIRED` and blocks resumed work. | Engine funding, restart and pause tests |
| Missing/expired approvals | Missing approval records and expired approved records could advance operations. Decisions now fail closed at the operation boundary; fresh requests preserve existing attempts and escrow. | Security, engine and server tests |
| Receipt interruption | A crash between receipt and head writes could permanently block the chain. A durable pending-append journal allows recovery only when the recorded chain and witness match. | Receipt interruption/tampering tests |
| Task resume | Resuming another task could switch the active task while the engine stayed bound to the old one. Task controls serialize startup and preserve the running task. | Server concurrency tests |
| Accounting | Duplicate or cross-job settlement could corrupt balances. Escrow commitments, releases and refunds are isolated by job and serialized; stale task budget snapshots recover from the ledger. | Ledger, state and engine tests |
| Approval races | Budget decisions and plan renewal could overwrite newer changes or progress. Scope checks and locked updates prevent stale approval replay, cancellation resurrection and replacement of started plans. | State, CLI and server tests |
| Files and locks | Symlink escapes, `.git` paths, prototype-named data and old live locks were unsafe. Artifact resolution checks path components, canonicalization preserves data keys, and locks cannot evict live owners. | Utility and security tests |
| Deliverables | Stored text could change after verification; truncated/files-only evidence could be overtrusted. Stored hashes are checked, incomplete evidence needs human review, and MCP pages must preserve identity and canonical base64. | State, verifier and MCP tests |
| Marketplace retries | Parallel connection attempts, ambiguous public posts and unsupported retry idempotency could duplicate effects. Connections coalesce; uncertain posts pause; message retries require advertised idempotency support. | MCP and engine tests |
| Planner policy | Configured reserves, disabled hiring and workstream gates could be omitted. Plan installation validates these policies; low-budget/disabled-hiring demos produce explicit local planning work. | Planner and track tests |
| Resource bounds | Provider responses and log reads could grow without bounds. Model bodies are capped at 8 MiB, log tails use bounded backwards reads, invalid retry/rate limits are rejected, and logger write failure does not poison later writes. | Model and utility tests |
| Server lifecycle | Startup races and shutdown could leave confusing sessions or listeners. Startup is locked; health checks verify identity/mode; unresponsive live owners retain their session; shutdown waits for owned processes. | Launcher, frontend and TLS tests |
| API/SSE | Cross-port loopback origins were too permissive; stream lifetime and buffering were insufficiently bounded. Origins include protocol/port, streams are capped and slow clients closed; cookie sessions are rechecked on events and heartbeats. | Server, remote and TLS tests |
| Terminal requests | Delayed responses and dialogs could target the wrong task, duplicate actions, or spin on a closed stream. Dialogs bind the original task, pending submissions are guarded, stale auxiliary responses are discarded, and closed streams stop rescheduling. | Go UI/API tests |
| Terminal startup | Backend secrets were inherited by the terminal subprocess. It now receives an OS/terminal environment allowlist and the intended API credentials. `ash shell` explicitly selects the legacy shell; `npm start` keeps the TUI default. | Launcher and CLI tests |
| Browser state | Late snapshots could restore old/logged-out state; unsent forms could reset; local deadlines could be rejected. Requests are sequenced, logout invalidates cached views, dirty forms survive ordinary refresh, and dates are sent as UTC. | Browser integration checks |
| Globe performance and evidence | Hidden-tab work, stale selected nodes and duplicate refreshes wasted work or confused state. Rendering/polling pause when hidden, camera easing uses elapsed time, clicks are distinguished from dragging, and backend evidence remains separate from ambient animation. | Globe adapter and browser checks |
| Dependency security | npm audit identified [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) in Zod. Updated to 4.6.7, migrated record schemas to explicit string keys, retained portable Rollup and Android/Linux esbuild support. | Typecheck, schema/receipt tests, oversized-input regression and dependency audit |
| Documentation | Setup commands, ports, browser architecture, process ownership, origin rules, receipt hashing order and Intents testnet claims were stale. Guides now match the implementation; the earlier architecture audit is labelled historical. | Documentation/source cross-check |

## Validation

| Check | Observed result |
| --- | --- |
| `npm run check`, Linux Node 22.23.3 | TypeScript passed; **184/184 Node tests passed**. The final server fixture rerun also passed **12/12** on Linux. |
| Native Android Node 26.12.1 | Full runs each passed **183/184**; one exposed an undersized launcher test timeout, another a garbage-collected SSE test connection. Both fixtures were corrected. Final targeted Android reruns passed **3/3 launcher** and **12/12 server** tests, covering the failed cases. A final complete rerun was interrupted by proot; an uninterrupted final Android full-suite pass is not claimed. |
| `npm run build` | Backend, Vite/prerender/compression and Go TUI passed. Vite warns about the lazy 940 KB Three.js chunk (253 KB gzip). |
| Go 1.27.3 | Both API and UI test packages passed; `go vet ./...` passed; `go mod verify` reported all modules verified. |
| Windows AMD64 cross-build | Passed with cgo disabled. Windows runtime remains untested here. |
| `npm run test:remote-tls` | **1/1 passed**, using local nginx/OpenSSL: TLS verification, secure cookies, authentication, CSRF, logout and unbuffered SSE. |
| Real PTY / `npm start` | Passed clickable New task/Cancel/Send, chat persistence, M/R navigation, `/task` editing, resize, B start/stop, browser port release, surviving core API and clean exit. CLI startup did not rebuild the browser. |
| Browser checks | **12 globe/frontend checks and 3 legacy console checks passed in separate completed batches**. Dark/light automated WCAG A/AA audits found zero violations. A combined rerun was interrupted by proot. |
| `npm audit --registry=https://registry.npmjs.org` | **0 known vulnerabilities** after the Zod update. The configured mirror does not implement the audit endpoint. |
| Optional Go race build | **Incomplete:** exceeded the 180-second limit while building; no race-detector pass is claimed. |
| Syntax/whitespace | JavaScript syntax checks and `git diff --check` passed. |

The focused console command is `node --import tsx scripts/test-console.mjs`. `npm run test:web` runs both browser groups. Linux CI now installs Chromium and runs those browser regressions after building; this edited CI workflow was not itself executed here. Test timeouts leave product timeouts unchanged. The SSE limit test holds readers open so client garbage collection cannot silently close the connections being counted.

The latest software-rendered browser sample measured **6.6 FPS**, **6 draw calls**, **1,300 particles** and pixel ratio **1** under host load. These are constrained-environment observations, not a hardware-GPU performance claim. Screenshots and detailed checks are in [frontend-browser-results.json](../frontend-browser-results.json) and [screenshots/](../screenshots/). Earlier Lighthouse measurements remain labelled as historical.

Intermediate review rounds also passed 81, 46, 23, 23, 43 and 61 targeted tests. Earlier failures included test-fixture preconditions (executing task state and minor-unit budget scale), the two platform-sensitive test fixtures above, and real receipt recovery/clock issues corrected before regression tests passed. Failed or interrupted checks are not counted as passes.

## Hackathon evidence and remaining limits

- The six scopes are planning templates, not six completed provider products. [TRACKS.md](../TRACKS.md) maps working foundations to the evidence still needed. NEAR Intents has no testnet; this review did not spend funds or deploy anything.
- Workstream gate presence is structurally validated for new/installed plans. Semantic placement before the correct milestone still needs plan review. Existing stored plans are not silently rewritten.
- Ordinary chat is persisted. It is not the separate attested, no-retention privacy workflow described by the privacy scope.
- Live marketplace settlement, real provider credentials, treasury council authorization and chain finality remain untested. Marketplace reports are not independent blockchain proofs. Receipt chains are locally witnessed, not externally signed/anchored.
- Unexpected externally funded escrow cannot be undone by a budget check. Its evidence is retained for marketplace reconciliation. There is no automatic reconciliation approval or refund tool.
- File locking assumes a local filesystem and one OS host. An interruption inside dead-lock reclamation can leave a recovery marker requiring operator inspection; it fails closed. Do not share a data directory across hosts or delete a live owner's locks.
- The simulated market supports a single writing backend per data directory. Its cache is not a distributed multi-writer store; use separate simulation data directories for independent runs.
- Symlink checks protect against untrusted artifact paths, not an attacker with the same OS account racing filesystem operations. Such an attacker can also read the API session token. OS account isolation remains necessary.
- Windows cross-compilation and CI configuration do not establish actual Windows Terminal/PowerShell runtime behavior. Mouse support also depends on the terminal emulator.
- Browser frame-rate measurements use software rendering inside Termux Ubuntu. Hardware-GPU 60 FPS remains unmeasured. The earlier mobile Lighthouse result was 61 performance and 100 accessibility/best practices/SEO; 90+ performance is not claimed. The lazy Three.js chunk still triggers Vite's size warning.
- The environment interrupted some long-lived Ubuntu/proot processes with libuv/futex errors when execution sessions ended. Completed reruns are distinguished from those aborted attempts. Automated accessibility checks do not replace a manual WCAG audit.
