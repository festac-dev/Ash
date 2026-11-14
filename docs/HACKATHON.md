# NEAR Hackathon

Official sources: [event site](https://nearhackathon.com/) and
[rules](https://nearhackathon.com/HACKATHON.md), checked 14 November 2026.

Ash's selected tracks are `business`, `swarms`, `security`, `agents`, `realworld`
and `social`. [TRACKS.md](TRACKS.md) maps each to its implementation and evidence.
Named ecosystem protocols are optional hints under Q-011. Testnet projects are
allowed under Q-010; NEAR Intents itself is mainnet-only.

## Scope and baseline

The existing operator workspace, planning/hiring engine, approvals and receipts are
were present in source snapshot `0b0df8452bfc6f7146d2a6d3907a1d990e7c3d08`.
This repository begins with the cleaned snapshot and does not import the earlier history.
The extension adds mainnet commerce workflows, constrained signing, artifact
verification and dependency handoffs, and the updated terminal/browser workspace.

The rules count development from 19 October 2026. Identify reused code and publish
the eligible extension on a dedicated branch or with baseline/submission tags and
a linked diff. The baseline identifies the extension boundary, not the original
creation date of every reused feature. Dependencies are listed in the package
manifests; the project includes AI-assisted development and retains Apache-2.0.

## Demo and evidence

```sh
npm ci --ignore-scripts
npm run demo -- --headless --json
```

This runs the normal planner, approvals, engine and receipt flow using isolated
simulation providers. It needs no provider credentials and spends nothing.
[The public demo video](https://x.com/i_am_festac/status/2118371914884211011) shows the
local simulation. Use the current repository URL, https://github.com/festac-dev/Ash;
the video's old `Ash-ai` outro URL is obsolete.

A [final native self-transfer](evidence/native-transfer.json) demonstrates exact
approval, signing, finality and replay protection. It does not prove a live sale,
marketplace hire, invoice, pool payout or DAO bounty. Those workflows have local
regression tests but remain unverified live. Track fit is not an eligibility or prize decision.

## Submission requirements

- Deadline: **14 November 2026, 23:59 UTC**.
- Publish the current code and extension diff in the repository judges will open.
- A local-only app needs an X video post, explicitly stating it was built at
  NEAR HACKATHON and including `@NEARProtocol` and `#NEARHackathon`. The existing post
  has the video and tags; include the explicit event statement and current repo URL.
- Submit once per project with all fitting tracks. Corrections to a saved submission
  use the organizer's request-changes process.
- Supply the actual team/contact details, chosen payout account and contact consent.
  Disclose other submitted projects and any pre-event code as the rules require.
