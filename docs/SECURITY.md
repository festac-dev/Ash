# Security review — 4 November 2026

Ash is a **single trusted-operator application**, not a multi-tenant service. A browser
session has the operator's task authority. There is no user directory or role hierarchy.
Do not host unrelated customers behind one token or expose the raw backend publicly.
The existing engine threat model remains in [../SECURITY.md](../SECURITY.md).

## Frontend codes and sessions

The second B, or `ash frontend on`, shows a fresh random, grouped 16-hex-character
code (64 bits of CSPRNG entropy). The first B starts the frontend without a code. `ash frontend code` rotates it while the frontend is ON. Only SHA-256
of the normalized code and its expiry remain in server memory; comparison is constant
time. A successful redemption consumes it immediately. Default lifetime is five
minutes, configurable from one to ten. Issuing another code invalidates the prior one.

Codes are returned once to the requesting local, bearer-authenticated terminal. They
are never stored in `server.json`, files, URLs, browser history or application logs.
`--json` deliberately includes the requested code for trusted automation; do not route
that output into public logs. Code login uses a password/one-time-code input and POST.
The previous URL-fragment ticket mechanism and persistent ticket fields were removed.

Redemption creates a random opaque in-memory session in an HttpOnly, SameSite=Strict
cookie, expiring after 12 hours. HTTPS public origins force Secure cookies. Local
loopback HTTP permits non-Secure cookies for SSH-tunnel/local development; public
plain HTTP is refused unless the explicitly unsafe override is enabled. Sessions do
not survive a restart. `frontend off` and `frontend logout-all` revoke every session
and unused code; off also stops the dedicated browser listener or disables browser
routes when the standalone API shares the port. API/health remain available in that
standalone mode. On a fresh install, browser access is OFF unless `ASH_SERVER_UI=true`.

After eight login attempts from the same socket address in one minute, further attempts
receive 429, including a correct code. No client-supplied forwarding address bypasses
this limiter. Behind one reverse proxy this may temporarily throttle all sign-ins;
proxy rate limiting/IP policy can reduce denial-of-service risk. Audit events record
success/failure/lockout and expiry, never the supplied code or token.

## Trusted remote administration

Frontend administration requires both a valid bearer credential and a loopback peer
and Host, with no forwarded-for header. The CLI reads the protected server session file
in `ASH_DATA_DIR`; it never accepts a visible token flag. SSH to the host, request a
code there, and type it into your tunneled/HTTPS browser. Docker exec and the service
user under systemd use the same path. A remote browser cannot mint codes or toggle
the listener. The proxy examples deny those administration routes.

Public binding requires explicit opt-in, a long server token and an HTTPS public URL.
Ash itself serves HTTP behind the TLS terminator. Firewall direct access and trust
forwarded protocol headers only from your proxy. `ASH_ALLOW_INSECURE_PUBLIC_HTTP=true`
is for deliberately isolated tests and emits a warning; it is unsuitable for the internet.

## Retained and verified controls

- Same-origin checks, SameSite cookies and `X-Ash-Client: web` on authenticated browser mutations.
- CSP, frame denial, nosniff, no-referrer, restricted browser capabilities and no-store auth responses.
- Path validation, private file modes, atomic writes, advisory locks, receipt-chain verification.
- Integer minor-unit budget accounting, expiring scoped approvals and human marketplace funding/acceptance.
- Untrusted content handling, bounded downloads, public-address HTTPS validation and DNS pinning for SSRF.
- Redacted errors/logs; stack traces only with explicit debug. Public probes return only availability.

## Demo isolation

`npm run demo` does not read `.env` or inherit provider credentials. It creates a new
owner-only OS temporary directory and composes deterministic model/market adapters
behind the normal interfaces. Notifications and verification subprocesses are disabled
in the demo configuration. NODE_ENV=production refuses simulation. Mode markers prevent
mixing live and demo data. Local track fixtures cannot execute in live mode. Tests block
fetch and socket connect while the normal demo planner/approval/engine/receipt flow runs.
Local browser connections are expected; “offline” means no external service calls.

## Residual risks and external requirements

- This review does not establish multi-tenant isolation or formally prove absence of vulnerabilities.
- The operator account can read local bearer credentials and state. Use disk encryption and OS access controls.
- Terminal recording or copied JSON can leak a displayed code. Codes are short-lived and single-use; revoke access if observed.
- Models and third-party agents can be wrong or hostile. Keep human review and inspect deliverables before execution.
- Hash-linked receipts establish internal consistency, not independent blockchain finality or truthful model judgment.
- File-backed persistence requires one service instance and a local persistent filesystem. Back up while stopped.
- Provider credentials, TLS certificates, proxy/firewall configuration, live marketplace approval and hosted deployment remain external responsibilities.
- The six extra track modules are simulations; live NEAR Intents/TEE/contract/DAO evidence is not claimed.
- Logging is best-effort outside financial state writes. Monitor disk capacity and archive private audit logs.

Credential-pattern scanning of the current tree and reachable Git history found only
synthetic values in security-test fixtures during the latest review. That heuristic is not a guarantee that every
possible secret format was recognized. No history was rewritten. See VERIFICATION.md
for executed checks, dependency audit results and platform limitations.

## Deployment review follow-up

Failed frontend activation now retains the OFF access gate. Production startup checks
the UI entry assets before accepting an enabled frontend. Readiness has a two-second
response bound and retains one in-flight filesystem probe during a stall. The image
entrypoint, Compose and systemd disable OS core dumps; disable dumps in host CLI shells
that handle credentials as well. The lockfile now uses official-registry URLs with
unchanged integrity hashes. See DEPLOYMENT_REVIEW.md for the full second review and
its explicitly simulated versus externally unverified infrastructure boundaries.

## Terminal and workspace follow-up

Frontend remains OFF for start/demo unless normal configuration explicitly enables it.
B starts without issuing a secret, second B issues the code, third B revokes access.
All frontend mutations, including the cycle endpoint, retain loopback and bearer checks
and reject concurrent access changes. The text shell does not persist readline history;
only the direct access response bypasses code redaction for the requesting terminal.
Errors, task output and audit logs remain redacted. Keep terminal recordings private.
The public landing page never fetches private snapshots or SSE, even with a valid cookie.
Workspace routes load private data only after authentication; logout clears it.

## Full review follow-up

External deliverable downloads now share a hard 25-second deadline across DNS,
redirects and streamed response bodies. Timeout aborts active HTTP requests; redirect
bodies are closed immediately. An OS DNS lookup cannot be cancelled by Node, but late
answers are ignored and cannot start a connection after the deadline. DNS pinning,
public-address validation, byte limits and content-type checks remain in place.
Regression tests use real loopback streams and isolated DNS/transport substitution;
no external provider credentials or real deliverables are required.

See [REVIEW_FOLLOWUP.md](REVIEW_FOLLOWUP.md) for this review's full scope and results.
