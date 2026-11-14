# Browser, deployment and signing security

Ash serves one trusted operator. A browser session has the operator's task authority;
there is no multi-tenant isolation or role hierarchy. The engine's threat model,
financial invariants and incident response are in [../SECURITY.md](../SECURITY.md).

## Frontend codes and sessions

Browser access starts OFF unless explicitly configured. Codes contain 64 random bits;
only their SHA-256 digest and expiry remain in memory. A code works once and expires
after five minutes by default, configurable from one to ten. Issuing a new code
invalidates the previous one.

Codes are returned to the requesting local terminal, including explicit JSON output.
They are not saved in session files, URLs or application logs. Keep terminal recordings
and redirected code output private.

Sign-in creates an opaque in-memory session with an HttpOnly, SameSite=Strict cookie
and a 12-hour expiry. HTTPS public origins force Secure cookies. Sessions do not
survive restart. `frontend off` and `frontend logout-all` revoke sessions and codes.
The standalone API may remain available when its browser routes are disabled.

After eight login attempts from one socket address in a minute, further attempts
receive HTTP 429. Forwarded client addresses cannot bypass this limiter. A shared
reverse proxy can therefore throttle all sign-ins temporarily.

## Trusted remote administration

Frontend administration requires a bearer credential, loopback peer and Host, and
no forwarded-for header. The CLI reads its private server session file. Browser
cookies cannot mint codes or toggle the listener. Use SSH or the service/container
terminal to administer access.

Public binding requires explicit opt-in, a sufficiently long token and an HTTPS
public origin. Use a TLS reverse proxy and firewall direct backend access. The
insecure HTTP override is intended only for isolated testing.

Browser mutations require same-origin checks and `X-Ash-Client: web`. Responses use
CSP, frame denial, nosniff, no-referrer and restricted browser capabilities. See
[REMOTE.md](REMOTE.md) and [CLIENT_SERVER_SECURITY.md](CLIENT_SERVER_SECURITY.md).

## Local operation and privacy

Task state, receipts and approvals live in the private local data directory. Hosted
model providers receive prompts, and marketplace operations send the required task
information to Agent Market. A local Ollama endpoint can keep inference local.
NEAR account and transaction data remain public blockchain information.

Filesystem permissions and redaction do not provide disk encryption, provider
no-retention guarantees or TEE attestation. The operator controls OS permissions,
backups, disk encryption and credentials. Back up file-backed state while stopped.

The demo ignores `.env` and configured data paths, uses temporary state and simulated
providers, and disables notifications and verification subprocesses. Production mode
refuses simulation; mode markers prevent mixing live and demo state.

## Artifact review and executable verification

Attachments have explicit file identities and are checked against their recorded
hashes. Binary, unsupported or incomplete evidence requires human inspection.
Version-2 verification fingerprints bind the delivery manifest and actual bytes.
Cached use and acceptance re-read the evidence; changed files retire the old authority
and require review. Superseded approvals remain in history but cannot authorize actions.

Text inspection is limited to 2 MiB per file; bounded streaming integrity checks
handle files up to 50 MiB. Executable criteria require exact operator-configured
commands and Linux Bubblewrap with working user namespaces. The sandbox exposes a
read-only workspace/runtime, private scratch space and no host network. It has no
host-shell fallback. Flagged/incomplete deliveries defer commands until review.
Wall-clock and output limits do not impose memory or process quotas; configure
service/container resource limits when executing untrusted checks.
See [executable verification configuration](CONFIGURATION.md#executable-verification).

## Optional NEAR operator signer

Signing defaults OFF and is available only through the operator CLI. It reads an
ed25519 key from an owner-only local JSON file, verifies the account key, and permits
native NEAR or `wrap.near.ft_transfer` within the recipient allowlist. Keys never enter
model prompts, browser responses or receipts.

New sends require an exact expiring approval covering recipient, amount, reference,
funding source and gas allowance. Task-linked sends also require an active reviewed
plan and a cumulative task allowance. `mainnet disable` writes a stop flag checked
again before signing; `enable` cannot override disabled configuration.

Value and conservative gas are reserved durably before broadcast. Uncertain outcomes
retain their reservations; retries reconcile the original hash. An observed fee
overrun blocks new sends. The default cumulative limit is 0.01 NEAR. This is local
policy, not an on-chain gas-price cap; deleting spending records resets accounting.
Protect the full-access key and include the records in quiesced backups.

The installed NEAR SDK retains low-severity secp256k1/elliptic advisories. Ash permits
only ed25519 signing keys. Run `npm run security` to check the installed dependency
versions; CI keeps the audit enabled at the moderate threshold.
