# Deployment and operations

All targets run **one** `node dist/server/main.js` process with persistent local storage,
Node 22, an explicitly configured model, and no demo mode in production. No SQL database
or migrations are required. Never share a volume across replicas or use an ephemeral
filesystem for paid work. Hosted deployment has not been claimed: see VERIFICATION.md.

## Shared configuration

Use `.env.example` as a reference; never overwrite your `.env`. Set these in the platform
secret manager or a `0600` environment file:

```dotenv
NODE_ENV=production
ASH_MODEL_PROVIDER=openai-compatible
ASH_MODEL_NAME=<your-provider-model>
ASH_MODEL_BASE_URL=https://api.openai.com/v1
ASH_MODEL_API_KEY=<secret>
MARKET_API_TOKEN=<buyer-token-if-hiring>
ASH_SERVER_TOKEN=<at-least-24-random-characters>
ASH_PUBLIC_URL=https://ash.example.com
ASH_SERVER_SECURE_COOKIES=always
ASH_SERVER_UI=true
ASH_DATA_DIR=/var/lib/ash
```

`ASH_SERVER_UI=true` explicitly starts browser access after a restart. Omit it for OFF
by default. Browser codes and sessions never survive a restart. `ASH_BIND_HOST` aliases
`ASH_SERVER_HOST`; `ASH_PUBLIC_URL` aliases `ASH_SERVER_PUBLIC_URL`. `PORT` is accepted
when `ASH_SERVER_PORT` is absent. Public binding additionally requires
`ASH_SERVER_ALLOW_REMOTE=true`. Do not enable `ASH_ALLOW_INSECURE_PUBLIC_HTTP` on an
internet host. The backend expects a trusted TLS terminator; firewall its raw port.

`GET /healthz` is minimal public liveness; `/readyz` tests writable, fsync-able storage
and returns 503 while draining. Neither exposes credentials, task data or process IDs.
Authenticated `/api/health` retains operational details. Readiness does not assert that
an optional model/market provider is reachable; use `ash doctor` and a reviewed task.

## Docker / VPS

Install Docker Engine and Compose. Set the shared configuration in `.env`, including
`ASH_PUBLIC_URL`. Then:

```sh
docker compose config --quiet
docker compose up -d --build
docker compose exec ash ash frontend code
docker compose logs --tail=50 ash
```

The image uses separate Go and Node build stages, a non-root Node user (UID 1000), a
health check, and no source secrets. Compose publishes only host loopback, persists
`/var/lib/ash`, drops capabilities, and uses a read-only root filesystem. Put Caddy or
nginx on the host in front of port 5050. For an existing bind mount, grant UID 1000
write access to the data directory; do not make it world writable.

## Render

Create a Blueprint from `render.yaml`. Fill the prompted model/market secrets and
`ASH_PUBLIC_URL` with your HTTPS Render/custom domain. The starter service has one
persistent disk mounted at `/var/lib/ash`; the free ephemeral tier is unsuitable for
ledger state. Render terminates TLS. From its service shell, run
`node dist/index.js frontend code`, then enter the code at the public URL. Check
`/readyz`, restart once, and verify task/receipt persistence before enabling paid work.

## Railway

Import the repository; `railway.json` selects the Dockerfile. Add **one volume** mounted
at `/var/lib/ash` and use one replica. Set shared variables, `ASH_BIND_HOST=0.0.0.0`,
`ASH_SERVER_ALLOW_REMOTE=true`, and your HTTPS generated domain as `ASH_PUBLIC_URL`.
Set `ASH_SERVER_PORT` to the port selected in Railway networking, or remove it and use
Railway's `PORT`. Use a service shell/SSH to run `node dist/index.js frontend code`.
Verify restart persistence and the configured `/readyz` health check.

## Private server / systemd

Install Node 22 and Go 1.25+; build with `npm ci --ignore-scripts && npm run build` in
`/opt/ash`. Create an unprivileged `ash` user. Install a `0600`, root-owned environment
file at `/etc/ash/ash.env` with the shared settings and `ASH_BIND_HOST=127.0.0.1`.
Install `deploy/ash.service` into `/etc/systemd/system/ash.service`, review it, then run
`systemctl daemon-reload && systemctl enable --now ash`. Set ExecStart's Node path if
your installation differs. `journalctl -u ash` shows structured operational logs.

Obtain a code locally, without putting the bearer token in shell history:

```sh
cd /opt/ash
sudo -u ash env ASH_DATA_DIR=/var/lib/ash node dist/index.js frontend code
```

Use `deploy/Caddyfile.example` for automatic TLS or `deploy/nginx.conf.example` with
existing certificates. Allow SSH and TCP 80/443 in the firewall; keep 5050 private.
Do not trust forwarded headers from arbitrary public clients. Rotate server tokens
via the environment file and restart. `ash frontend logout-all` revokes browser
access immediately while retaining bearer access for the host operator.

## SSH-only access

With the default loopback configuration, SSH to the host and run `ash frontend on`.
It prints a URL, a one-time code, and a tunnel command with the actual port. On your
computer run, for example, `ssh -L 5050:localhost:5050 user@vps`, keep SSH open, visit
`http://localhost:5050/workspace`, and enter the code. For a new code run `ash frontend code` in
the host terminal. Codes expire after five minutes (`ASH_CODE_TTL_MINUTES=1..10`).
Never paste a code into a shell command or URL. `ash frontend off` revokes sessions
and codes; in standalone mode the authenticated API/health listener remains available.

## Backup and recovery

1. Pause execution and stop Ash; do not snapshot files during settlement or writes.
2. Copy the entire data directory (tasks, ledgers, transactions, mode marker, artifacts,
   approvals and audit log) to encrypted restricted storage. Exclude `server.json`,
   `server-launch.lock` and stale process locks from restoration. Codes are never files.
3. Test a restore into a separate directory on the same filesystem type; keep providers
   disconnected until `ash verify --json` succeeds and balances are reconciled.
4. Start one instance. Review pending/expired approvals, funded marketplace jobs and
   escrow before resuming. A receipt chain proves local integrity, not chain finality.

Keep daily backups plus one before upgrades. Do not repair corruption by editing a
chain head or deleting receipts. Preserve damaged files and reconcile provider records.
No automatic destructive migration is provided.

## Reproduce the deployment review locally

After `npm run build`, run `npm run test:deployments`. This is a **hosting simulation**,
not a cloud deployment. It installs locked production-only dependencies in a private
temporary runtime, parses the checked-in platform configurations, and starts real Ash
processes behind local TLS or HTTP forwarding. It uses real task drafts, authentication,
SSE, filesystem faults, restarts and backup restoration; it never calls a model,
marketplace or payment service. Codes stay in memory and are checked against service
logs. Existing `.env` and data directories are not used.

The profiles cover Docker/Compose, Render, Railway's dynamic PORT, Railway with the UI
initially OFF, a private TLS server and SSH-style forwarding. Fixed ports/data paths
are remapped to isolated local resources. Results go to
`docs/deployment-simulation-results.json`, explicitly labeled as simulated hosting.
The runner writes a fresh unsuccessful result before starting so an interrupted run
cannot reuse an old pass. OpenSSL, npm and a POSIX environment are required; dependency
installation needs registry access or a populated cache.

For an actual Docker runtime check, on a machine with Docker Engine:

```sh
docker build -t ash:ci .
npm run test:container
```

This creates only uniquely named test containers/volumes and removes them afterward.
It checks health, non-root identity, a read-only root, production-only dependencies,
TLS/code login, code/session revocation and named-volume persistence after restart.
Set `ASH_TEST_IMAGE` to test another already-built image. A missing Docker daemon makes
this command fail; it does not report a simulation as a container pass. CI now loads
and runs the built image. Results go to `docs/container-runtime-results.json`.

The image entrypoint disables core dumps and uses `exec` to preserve signal handling.
Compose also sets the core limit to zero, and the systemd unit uses `LimitCORE=0`.
For a trusted host shell that issues codes, run `ulimit -c 0` before the CLI if core
dumps are enabled by your OS. Avoid Node diagnostic/heap dumps and terminal recording
while handling live credentials. These controls do not prevent an authorized OS
administrator from inspecting process memory.

Production startup validates the enabled UI's entry HTML and referenced entry assets.
A failed frontend activation stays OFF. Storage readiness responds within two seconds
if a probe stalls, and starts no additional filesystem probes while one is pending.
An unrecoverable kernel/filesystem stall may still require an operator restart.
