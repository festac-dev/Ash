# Ash: the six selected NEAR Hackathon tracks

Track mapping checked 14 November 2026 against [nearhackathon.com](https://nearhackathon.com/)
and the [official rules](https://nearhackathon.com/HACKATHON.md). The submission IDs
are `business`, `swarms`, `security`, `agents`, `realworld` and `social`. The existing
`privacy` workstream remains available; it is not a replacement for Agent Economy.

| Track | Implemented behavior | Live operation |
| --- | --- | --- |
| Autonomous Business | Existing task planning, procurement and delivery; immutable revenue split from a verified sale, using exact integer allocation | `revenue-allocate`, `revenue-settle`; each contributor requires an exact final payout proof |
| AI Swarms | Existing bounded multi-agent task execution; committed-bid validation, deterministic selection, verified pool funding and reservations | `swarm-allocate`, `swarm-settle`; verifies funding, selects the winner and records its exact payout |
| AI Security & Defense | Typed expiring approvals, per-task budgets, guarded tools and deliverables, ledger checks; exact approval, gas and task limits plus a disk stop flag for CLI signing | `transfer-plan`, `request`, `approve`, `send`, `disable`; unauthorized or over-budget sends are refused |
| Agent Economy | Existing live Agent Market discovery, hiring and bounded bid negotiation; verified earnings/spending, token balance and spendable limit | `agent-balance`; existing task execution handles hiring/delivery, and `mainnet verify` records hire/API token payments |
| Real-World Money | Validated invoice and accounting export; live invoice creation starts UNPAID and exact final token settlement changes it to PAID | `invoice-create`, `invoice-settle` |
| Social Money | Existing community bounty checks; live Sputnik approval/payout binding with one durable reputation event per proposal | `bounty-settle`; requires Approved proposal, matching DAO token-transfer terms and its final approval-execution transaction |

The named ecosystem tools in the track examples are suggestions (rules Q-011). Ash
uses its existing Agent Market/model adapters, native NEP-141 token payments, the
1Click quote API and compatible Sputnik treasury views. It does not need to implement
every example application or every named protocol to cover a track.

## Live operations

Build with `npm ci --ignore-scripts && npm run build`. Keep `ASH_DEMO=0` for live
operations; the CLI refuses live/demo data-directory mixing. No AI model is required
for the following commands. Configure an AI model and marketplace credentials only
for actual planning/hiring through the existing engine.

```sh
npm start -- mainnet check --json
npm start -- mainnet check yourname.near --json
npm start -- mainnet keys yourname.near --json
npm start -- mainnet quote quote.json --json
npm start -- mainnet verify payment.json --json
npm start -- mainnet workflow invoice-create invoice.json --json
npm start -- mainnet workflow invoice-settle settlement.json --json
npm start -- mainnet workflow revenue-allocate revenue.json --json
npm start -- mainnet workflow revenue-settle revenue-payouts.json --json
npm start -- mainnet workflow agent-balance agent.json --json
npm start -- mainnet workflow swarm-allocate round.json --json
npm start -- mainnet workflow swarm-settle swarm-payout.json --json
npm start -- mainnet workflow bounty-settle bounty.json --json
npm start -- mainnet workflow transfer-plan transfer.json --json
npm start -- mainnet payments --json
npm start -- mainnet evidence --json
```

Files below contain public accounts and exact amounts, never signing keys. `yourname.near`
is an example; replace it with an account you own. Select token contracts/asset IDs
from `mainnet check`. Atomic amounts use the token's precision: one USDC with six
places is `1000000`; one wrapped NEAR with 24 places is `1000000000000000000000000`.

Create an invoice with `invoice-create`:

```json
{
  "reference": "invoice-1",
  "client": "Northwind Studio",
  "recipient_account": "yourname.near",
  "token_account": "<NEAR token contract from the live asset catalogue>",
  "amount_atomic": "1000000"
}
```

It returns UNPAID. Once a wallet payment has completed, `invoice-settle` takes:

```json
{
  "reference": "invoice-1",
  "transfer": {
    "tx_hash": "<final NEAR transaction hash>",
    "signer_account": "<account that signed the transaction>",
    "sender_account": "<account that transferred the tokens>",
    "recipient_account": "yourname.near",
    "token_account": "<the invoice's NEAR token contract>",
    "amount_atomic": "1000000"
  }
}
```

The amount, token and recipient must match the immutable invoice. The verifier checks
`FINAL`, successful receipt outcomes, and NEP-141 transfer events emitted by the actual
token contract. It rejects refunded/moved-again tokens, wrong identities, optimistic
execution, duplicate outcomes and duplicate credits. A successful transaction alone
is insufficient. `mainnet verify` uses the same `transfer` object plus `purpose` and
`reference`; supported purposes are `invoice`, `sale`, `hire`, `api`, `swarm`, `bounty`
and `revenue-share`.

Other workflow payloads:

| Operation | Input fields |
| --- | --- |
| `revenue-allocate` | `sale_reference`, `treasury_account`, `split: [{account, percent}]`; percentages total 100 and recipients are distinct |
| `revenue-settle` | `sale_reference`, `transfers: [transfer]`; one exact final proof for each positive allocation |
| `agent-balance` | `agent_account`, `token_account`, `spending_limit_atomic`; spendable amount is bounded by net verified transfers, current balance and limit |
| `obligation-reserve` | `reference`, `task_id`, `agent_account`, `token_account`, `amount_atomic`; reserves verified earnings for an existing open task |
| `obligation-release` | `reference`; explicitly releases an obligation, without making a payment |
| `swarm-allocate` | `round_reference`, `pool_account`, `token_account`, `quantity`, `max_unit_price_atomic`, `funding_references`, `bids: [{seller, unit_price_atomic, capacity, nonce, commitment}]` |
| `swarm-settle` | `round_reference`, `transfer`; exact pool-to-winner payout releases the pending balance reservation; consumed contributions remain unavailable for reuse |
| `bounty-settle` | `reference`, `dao_account`, `proposal_id`, `transfer`; supports Sputnik's token Transfer proposal and `act_proposal` VoteApprove execution |
| `transfer-plan` | `sender_account`, `recipient_account`, `token_account`, `amount_atomic`, `spending_limit_atomic`, `allowed_recipients`, `killed` |

Swarm commitments are SHA-256 of JSON encoding
`[round_reference, seller, unit_price_atomic, capacity, nonce]`. Collect commitments
before revealing nonces. Ash validates the supplied commitment hash; it does not
implement a separate timed commit/reveal protocol or prove when bids were submitted.
Never publish unrevealed bids. The coordinator runs under the
existing trusted operator account. Pool custody stays with its owner. Pending
allocations reserve funding and do not claim atomic escrow or execute payments.

A dry quote takes `origin_asset`, `destination_asset`, `amount_atomic`, `refund_to`,
`recipient`, and optional `slippage_bps` (0–100). Ash always sends `dry: true` and refuses
fundable responses. There is no NEAR Intents testnet (Q-007). A dry quote creates no
deposit address and does not settle an invoice. Cross-chain payment must be approved
and performed in a wallet/Intents application before its NEAR destination event can
be verified here.

The `transfer-plan` result is an unsigned NEP-141 `ft_transfer` request with one
 yoctoNEAR attached deposit and a 30 Tgas maximum. Ash reads the recipient account,
sender token balance and recipient token storage first. This plan retains wallet approval; function-call keys cannot attach this deposit or perform arbitrary native transfers.
Browser/API endpoints cannot sign or broadcast. The opt-in operator CLI signer below
can submit native/wrapped NEAR transfers. Neither path funds 1Click quotes or deploys contracts.

## Operator signing and spending

Configure public settings in a local ignored `.env`:

```dotenv
ASH_DEMO=0
ASH_NEAR_ACCOUNT=yourname.near
ASH_NEAR_SIGNING_ENABLED=true
ASH_NEAR_SIGNING_KEY_FILE=/absolute/path/to/private/near-key.json
ASH_NEAR_MAX_TOTAL_NEAR=0.01
ASH_NEAR_ALLOWED_RECIPIENTS=yourname.near,recipient.near
```

The key file is JSON with `account_id` and `private_key` (an `ed25519:` NEAR key),
permissions `600`, outside public Git files. Prefixed and raw base58 64-byte NEAR
private-key exports are supported; public keys cannot sign. Ash derives the public key
and checks it against the account, so a separate public-key field is unnecessary. Use a separate low-balance operator account.
The signer checks that its public key is actually installed as a full-access mainnet key.
The browser and model never receive the key and cannot call the signer. Disable new
sends immediately with `mainnet disable`; `mainnet enable` removes the stop flag only
when configuration also allows signing.

```sh
npm start -- mainnet spending --json
npm start -- mainnet request transfer.json --json
npm start -- mainnet approve decision.json --json
npm start -- mainnet send transfer.json --json
npm start -- mainnet reconcile payment-1 --json
```

`transfer.json` contains `reference`, `kind` (`native` or `wrapped-near`),
`recipient_account`, `amount_atomic`, `max_gas_near`, and optional payment `purpose`
(default `revenue-share`). Request returns an approval ID and its exact confirmation
phrase. Put those into `decision.json` as `{"approval_id":"apr_...","phrase":"APPROVE apr_..."}`.
After approving, add that `approval_id` to the unchanged transfer file before `send`.
Changing approved terms requires a new approval. `max_gas_near` is the allowed
conservative gas reservation, inside the cumulative limit, not an extra budget.

Optional `funding_source: "earnings"` requires verified wrapped-NEAR earnings after
recorded spending and outstanding reservations. It does not spend unrelated wallet
funds. For task-linked sends, include `task_id` and `task_limit_near`; a stopped task
or an unreviewed plan blocks signing. The separate NEAR task limit includes value
and gas reservations and does not replace the global cap.

For example, `1000000000000000000` is `0.000001 NEAR`. Wrapped NEAR
sends call only `wrap.near.ft_transfer` with a one-yoctoNEAR deposit and 10 Tgas;
the recipient must already have token storage. Other tokens require external wallet
approval and the existing exact transfer verifier.

The total limit defaults to **0.01 NEAR**, while signing defaults OFF. A private,
locked spending ledger reserves native/wrapped value plus three times the freshly
quoted gas cost and receipt overhead before broadcast. Full reservations remain
charged after finality, including uncertain/failed sends. Each reference binds exact
terms; replay checks the original transaction instead of creating another one.
Gas is verified after finality, and an observed fee beyond its reservation blocks
further spending. NEAR does not expose a transaction-level maximum gas price, so the
local gas allowance is conservative rather than an on-chain fee cap. Keep the signing
account balance within the intended total exposure. Protect and back up the spending
store; resetting it resets local cumulative accounting.

A timeout reports the original transaction hash and leaves its reservation intact.
Use `reconcile` before deciding what to do next. Never assume a timeout means no
payment was sent. Native self-transfers can test signing/finality without transferring
value away, but still consume gas and require a funded account.

## Browser and API

The live browser's **NEAR mainnet** section provides account checks, dry quotes and
completed-transfer verification without changing the existing demo workspace. The
additional workflows share the authenticated API:

- `GET /api/mainnet/check?account=...`
- `GET /api/mainnet/keys?account=...`
- `GET /api/mainnet/dao-proposal?account=...&id=...`
- `GET /api/mainnet/payments`
- `GET /api/mainnet/evidence`
- `POST /api/mainnet/quote`
- `POST /api/mainnet/verify`
- `POST /api/mainnet/workflows/<operation>` with the same JSON inputs as the CLI

Cookie mutations still require `X-Ash-Client: web`. All mainnet endpoints require
operator authentication and refuse demo mode. Records live under
`$ASH_DATA_DIR/mainnet/`, use private file modes, atomic writes and distinct lock files,
and should be included in the normal quiesced data-directory backup.

`mainnet evidence` rechecks finality and matching workflow state for all six selected
tracks. It returns scoped `LIVE_VERIFIED` or `UNVERIFIED` results and the missing
evidence. Implementation metadata, arbitrary payment labels and local fixtures
cannot establish live success. Marketplace evidence also requires a fresh settled
job, the reviewed deliverable hash and a valid live task receipt chain. These checks
do not determine judging scores, eligibility or every possible ecosystem integration.

## Reproducible offline checks

The recorded demo remains `npm run demo`. For automation:

```sh
npm run demo -- --headless --json
ASH_DEMO=1 npm start -- tracks verify --json
```

The track journey runs the six selected tracks plus optional privacy. Demo fixtures
remain explicitly labelled. The live workflow tests use mocked provider responses to
exercise complete state transitions and failure cases without spending funds; this
is separate from executing a wallet payment. See [DEVELOPMENT.md](DEVELOPMENT.md#tests) for the test commands.

## Current live evidence

The [recorded native self-transfer](evidence/native-transfer.json) reached FINAL and
reconciled without another broadcast. It demonstrates approved signing/finality for
Security. Sale/contributor payouts, pool settlement, marketplace delivery, paid
invoices and DAO bounties remain unverified live. Passing local modules does not
establish these live results or a judging outcome.

[HACKATHON.md](HACKATHON.md) covers the official rules, baseline and submission links.
