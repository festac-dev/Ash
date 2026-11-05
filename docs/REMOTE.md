# Remote access

Frontend access is OFF by default. Enable it with **B** in the host terminal or
`ash frontend on`. B follows three steps: start and show URL/port, generate code, then
close and revoke access. `ash frontend on` starts and issues a code in one command. No code is
sent in a URL. `ash frontend status` is read-only; `ash frontend code` issues a new code
without toggling the frontend; `ash frontend off` revokes sessions and unused codes.
All four commands and `logout-all` support `--json`.

For the safest VPS setup:

1. SSH into the VPS and run `ash frontend on`.
2. On your own computer, run the printed tunnel command, for example
   `ssh -L 5050:localhost:5050 user@vps`.
3. Open `http://localhost:5050/workspace`, select Enter access code, and enter the code from the host terminal.
4. Keep the tunnel open. To reconnect after expiry, obtain another code over SSH with
   `ash frontend code`. A restart or frontend deactivation revokes every session.

For public access, put Caddy/nginx with TLS in front of Ash, configure the exact
`ASH_PUBLIC_URL=https://...`, and keep the raw API port behind a firewall. `ASH_BIND_HOST`
defaults to loopback. Public binding requires `ASH_SERVER_ALLOW_REMOTE=true` and a long
server token, and plain HTTP is refused unless deliberately overridden with
`ASH_ALLOW_INSECURE_PUBLIC_HTTP=true`. That unsafe override is not for internet use.

The CLI reads the owner-only `ASH_DATA_DIR/server.json` bearer credential. Use a local
service shell, `docker compose exec ash ash frontend code`, or the systemd service
user. Browser cookies cannot request new codes, and public/proxied requests cannot
call the frontend admin routes. Do not copy the bearer token into shell arguments.

Default code lifetime: five minutes (`ASH_CODE_TTL_MINUTES=1..10`). Eight failed sign-ins
in one minute cause a one-minute lockout window. Codes are grouped random values;
spaces/hyphens and case are normalized. A used/expired code must be replaced. Do not
publish codes or capture them in service logs. JSON code output is for trusted callers.

Full target-specific setup, TLS examples, persistence, health checks and backup guidance:
[DEPLOYMENT.md](DEPLOYMENT.md). Threat model and residual risks: [SECURITY.md](SECURITY.md).
