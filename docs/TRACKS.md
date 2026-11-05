# ASH and the six NEAR Hackathon tracks

Reviewed 3 November 2026 against the [live hackathon site](https://nearhackathon.com/), [official rules](https://nearhackathon.com/HACKATHON.md), and the six linked example prompts. ASH's existing scope definitions are in [src/tracks.ts](../src/tracks.ts).

The event has 13 tracks; ASH currently selects six. Organizers allow one project to enter multiple tracks. Their example apps and named integrations are suggestions, not mandatory designs (rules Q-011). ASH can demonstrate the six through one coherent product and shared execution workflow.

| Track | What it covers | ASH's role | Evidence still needed for the complete workstream |
| --- | --- | --- | --- |
| [Real-World Money](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/08-realworld.md) (`realworld`) | Invoices, payroll, remittances and usable stablecoin payments | Turn paid work into invoices, settlement records and accounting exports | A complete invoice/payment/reconciliation flow with authoritative destination settlement evidence; the current internal task ledger is not an invoice payment integration |
| [Autonomous Business](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/04-business.md) (`business`) | Agents operating sales, procurement, treasury and revenue sharing within human constraints | Receive a paid job, budget it, hire agents, buy services and deliver verified work | A sale-to-delivery-to-payout loop, including inference costs and revenue allocation; orchestration and budgeting provide part of this foundation |
| [AI Security & Defense](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/06-security.md) (`security`) | Policies, spending limits, restricted wallets and scam prevention | Enforce approvals, budgets and verification at execution boundaries | A counterparty decision service and an attack demo proving a blocked operation cannot reach the signer; the existing approval/injection/accounting tests provide local evidence |
| [Privacy & Private AI](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/03-privacy.md) (`privacy`) | Confidential inference/computation and financial privacy | Process sensitive work through verified private inference | Fresh-nonce attestation verified against the provider's official mechanism and demonstrated content cleanup. Ordinary chat is persisted today and must not be described as a private no-retention path |
| [AI Swarms](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/05-swarms.md) (`swarms`) | Multi-agent coordination, bidding, group buying and settlement | Coordinate specialists, prerequisites, assignments and shared task budgets | A reproducible coordination-market round with explicit allocation/payment rules. Existing subtask orchestration does not demonstrate sealed bids, pooled purchases or per-agent on-chain accounts |
| [Social Money](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/12-social.md) (`social`) | Community budgets, bounties, rewards and reputation | Let a community fund verified work through its existing treasury | A treasury-approved bounty payout and reputation history tied to completed work. ASH's local approvals are not Sputnik DAO/Trezu council approvals |

## One product journey

A community commissions work and allocates a budget. ASH checks policy, plans dependencies and coordinates agents. Sensitive processing uses a separately verified private path. Results pass acceptance checks before settlement. Receipts explain the financial outcome, and completed contributions update reputation through the treasury's actual approval rules.

This is the target product story, not a claim that every integration already runs. The terminal is the working control surface; the browser displays activity and evidence from the same backend. Neither the globe nor six track badges establish integration evidence.

## Corrections to carry into implementation

- **NEAR Intents has no testnet.** Official rules Q-007 explicitly say there is no Intents testnet and recommend dry quotes and separate development accounts for tiny mainnet transactions. This conflicts with the testnet wording in some example prompts and ASH's existing `realworld`/`business` build orders. Treat these as planning corrections: local/NEAR-testnet tests can prove application logic; an actual Intents settlement needs a supported mainnet route and explicit authorization before real spending. No funding or deployment was performed during this review.
- **The examples are optional.** The six templates currently describe an invoice app, research shop, counterparty checker, private expense auditor, GPU buying swarm and bounty board. Those are possible demonstrations, not a requirement to ship six unrelated apps. Track eligibility comes from working behavior relevant to each track.
- **Privacy requires a separate data lifecycle.** Persisted chat history and audit receipts must not contain private input documents/prompts/responses from a no-retention workflow. A receipt can reference allowed verification metadata without exposing the content.
- **Authority stays with the real treasury and signer.** Reputation, browser controls and AI recommendations cannot supply council approvals or broaden a key's permissions. Function-call keys cannot transfer native NEAR or perform arbitrary account actions.

## Submission facts

The current deadline is **14 November 2026, 23:59 UTC** (15 November, 00:59 in Lagos). One public repository and a public demo post are required. For a local-only application, Q-012 requires a video; screenshots alone are insufficient when judges cannot open the demo. State reproducible commands and observed results, and distinguish simulation, local tests, provider verification and real settlement. Recheck the live rules before submission because they can change.
