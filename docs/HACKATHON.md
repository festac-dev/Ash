# Hackathon readiness

Sources read on 4 November 2026:
- https://nearhackathon.com/
- https://nearhackathon.com/HACKATHON.md

The site lists 13 build tracks, a 1–14 November development period and results by
18 November. Its detailed rules accept code from the 19 October announcement; previous
code must be disclosed as baseline. Re-read these sources before submitting.

Ash best demonstrates AI Security & Defense (scoped approvals/budgets/receipt evidence),
Agent Economy (existing buyer-side agent-market integration), Autonomous Business and
AI Swarms (planning, hiring, dependencies). The six additional modules are runnable
local simulations, not proof of every corresponding live NEAR integration. No numerical
judging rubric was published in the fetched rules; reproducibility, actual feature
verification and a human jury are described. Do not invent scores or guaranteed eligibility.

| Requirement | Status |
| --- | --- |
| Public repository | Owner must publish/verify visibility; nothing was pushed |
| Reproducible local demo | `npm install && npm run demo`; smoke/regression evidence in VERIFICATION.md |
| Clear simulation boundary | Terminal/UI labels, simulated JSON, isolated providers and production guard |
| Live NEAR evidence | Existing MCP integration retained; new paid live transactions were not attempted |
| Demo post | Owner must post a video on X with NEAR HACKATHON, @NEARProtocol and #NEARHackathon |
| Local-only demo | Allowed, but needs a video; screenshots alone are insufficient |
| Repository + post links | Required in the final submission |
| Team identity, email, size and payout NEAR account | Owner input required; never invented |
| Contact consent and exact submission payload | Owner must confirm before any submission |
| One submission per project | Do not submit twice; use organizer request-changes for corrections |
| Other project disclosure | If the owner enters another project, name it in each README |
| Deadline | 14 November 2026, 23:59 UTC |
| License | Existing Apache-2.0 retained |

The replaced “one-command demo path” requirement is now the dedicated demo/simulation
phase: normal services and output, isolated deterministic providers, zero external
services and explicit labeling. Simulation is allowed only through that mode. Real
mode must never fake or mock results. No code was pushed, no post was published and no
hackathon submission was sent.


## Preparation using previous NEAR judging criteria

The owner identified technical implementation, design, impact, originality and
sustainability as criteria used in previous NEAR hackathons. Use these as a preparation
guide; they are not a verified rubric or weighting for this event.

| Preparation criterion | Evidence to show in Ash | Limits to state clearly |
| --- | --- | --- |
| Technical implementation | One backend for CLI/browser; planner, typed approvals, budget enforcement, execution, receipt verification; isolated demo and executed regression tests | The offline demo uses simulated model/market providers; live paid integrations need separate verification |
| Design | Separate public landing and private workspace, responsive task controls, automatic globe, accessible node list, clear B sequence and code sign-in | Automated accessibility checks cover tested screens; they do not replace a full human accessibility review |
| Impact | Show a rejected budget or approval, then inspect the resulting task and receipts; explain how an operator can review spending and delivery | No user-adoption, cost-saving or revenue claims have been measured |
| Originality | Demonstrate the connection between operator intent, explicit approvals, marketplace assignments and inspectable evidence in one workflow | Disclose the existing Ash baseline, dependencies and AI-assisted development; do not claim every module is a new live NEAR integration |
| Sustainability | Show persistent state, restore/restart evidence, deployment instructions and per-task budgets; explain how an operator maintains the service | One process per data directory; hosting, provider pricing, credentials, reconciliation and long-term support remain operator responsibilities |

Prepare the submission around this evidence. Use the simulation badge in the video and
explain which integrations would need live credentials. Do not invent judge scores,
traction, deployed contracts or operating-cost measurements.

## Full review site check

Re-read [nearhackathon.com](https://nearhackathon.com) during the November 2026 review.
The current FAQ explicitly identifies technical implementation, design, impact,
originality and sustainability from previous NEAR hackathons as preparation guidance;
it also says automated screening checks that the project runs and matches the README.
The published submission deadline remains **14 November 2026, 23:59 UTC**. A public
repository and an X demo post mentioning NEAR HACKATHON, @NEARProtocol and
#NEARHackathon are required. Scoring weights, eligibility decisions, acceptance of a
simulation-only submission and any prize outcome are not established by this review.
