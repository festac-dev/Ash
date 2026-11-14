# Changelog

## Unreleased

- Add mainnet invoice, revenue, agent-earnings, pool and DAO-bounty workflows.
- Add operator-only NEAR signing with exact approvals, recipient limits, durable budget reservations and a stop flag.
- Add marketplace device OAuth with private token storage and refresh.
- Bind attachment review and cached acceptance to actual artifact hashes; hand completed artifacts to dependent workers and supersede stale approvals.
- Isolate executable verification with Linux Bubblewrap; preserve model truncation metadata without identical retries.
- Add nonrecording browser payment previews and responsive workspace navigation, themes and renderer fallback.

## 1.1.0 — 2026-11-04

- Add production-dependency hosting simulations and a Docker runtime CI check, including
  restart, backup/restore, storage faults, TLS and code access.
- Bound stalled readiness responses, validate production UI assets, preserve OFF state
  after activation errors, and report current frontend state in doctor.
- Normalize registry URLs without changing locked versions/hashes and disable service core dumps.
- Add explicit frontend ON/OFF/status/code administration, hashed single-use codes,
  session revocation (including concurrent sign-in), local-only administration and documented VPS access.
- Add isolated, production-blocked offline demo through the normal service/engine flow.
- Add contextual CLI help, shell completion, structured inspection output and quieter
  headless operation; improve TUI action discovery and browser-access dialog.
- Start the globe automatically, remove transport controls and provide a functional
  canvas fallback for GPU failure.
- Add public liveness/readiness probes, persistent deployment configurations, security
  and quality checks, a compiled-files-only production smoke test, and operational/submission documentation.

## 1.0.0

Existing task execution, budgeting, approval, marketplace and receipt implementation.
