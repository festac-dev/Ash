# Changelog

## Unreleased

- Bound external deliverable downloads across DNS, redirects and streaming; close abandoned sockets.
- Hide demo-only track actions in live workspaces and verify the browser/API boundary.
- Repair standalone browser checks, include all browser screenshots in CI evidence, and correct obsolete code-access documentation.

- Add a workspace-only feature tour and move deployment/session explanations out of product screens.
- Restore consistent ash typography, palette and layered 3D surfaces across overview and task controls.

- Keep start/demo terminal clients connected to the same backend, with an API text shell when Go is unavailable.
- Keep frontend OFF initially; B starts it, a second B displays the code, and a third B closes/revokes access.
- Separate the public landing, authenticated workspace overview and task controls; preserve console compatibility.
- Add regression coverage for terminal approval gates, browser route privacy, access sequencing and demo shutdown.

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
- Preserve the existing implementation, provider integrations and Apache-2.0 license.

## 1.0.0

Existing task execution, budgeting, approval, marketplace and receipt implementation.
Existing browser and TUI functionality was retained during these improvements.
