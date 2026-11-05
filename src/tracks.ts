export interface TrackInputSpec {
  key: string;
  label: string;
  help: string;
  required: boolean;
  validate?: (value: string) => string | null;
}

function oneOf(label: string, allowed: string[]) {
  const normalized = allowed.map((value) => value.toLowerCase());
  return (value: string): string | null =>
    normalized.includes(value.trim().toLowerCase()) ? null : `${label} must be one of: ${allowed.join(", ")}`;
}

function nearAccount(value: string): string | null {
  const account = value.trim();
  return account.length >= 2 && account.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(account)
    ? null
    : "Use a valid NEAR account (lowercase); never a private key";
}

function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password
      ? null
      : "Use an HTTPS URL without embedded credentials";
  } catch {
    return "Use a valid HTTPS URL";
  }
}

function positiveAmount(value: string): string | null {
  return /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value.trim()) && /[1-9]/.test(value)
    ? null
    : "Use a positive decimal amount with at most 6 decimals";
}

function count(value: string): string | null {
  if (!/^[0-9]+$/.test(value.trim())) return "Use a whole number";
  const number = Number(value);
  return number >= 1 && number <= 1_000 ? null : "Use a number between 1 and 1000";
}

function percentageSplit(value: string): string | null {
  const numbers = [...value.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*%/g)].map((match) => Number(match[1]));
  if (numbers.length === 0) return "Specify percentages totalling exactly 100%";
  const total = numbers.reduce((sum, number) => sum + number, 0);
  return Math.abs(total - 100) < 0.000001 ? null : "Percentages must total exactly 100%";
}

export type ScopeReadiness = "working" | "simulated" | "partial" | "planning";

export interface ProjectScope {
  id: string;
  name: string;
  theme: string;
  description: string;
  readiness: ScopeReadiness;
  readinessNote: string;
  buildOrder: string[];
  approvalGate: string | null;
  requiredInputs: TrackInputSpec[];
  constraints: string[];
}

/**
 * Ash is one project with six workstreams, not six separate applications. A
 * task may cover one or more workstreams; the planner receives their combined
 * build order, inputs, constraints and approval gates. Ash never claims a
 * workstream is complete without real evidence or a human approval at its gate.
 */
export const SCOPES: ProjectScope[] = [
  {
    id: "realworld",
    name: "Real-World Money",
    theme: "Crypto invoicing for freelancers who do not care about crypto",
    description:
      "A freelancer creates an invoice, shares a payment link, the client pays with an eligible asset through 1Click, and the freelancer receives USDC on NEAR without buying NEAR for gas.",
    readiness: "simulated",
    readinessNote:
      "A deterministic local invoice, payment link, reconciliation and accounting CSV run in `tracks run realworld`. No 1Click quote, wallet signature or destination settlement is claimed.",
    buildOrder: [
      "Write README first for a bookkeeper/freelancer audience",
      "Build server-validated invoice creation and the public payment page",
      "Build a clearly labelled local invoice simulation; NEAR Intents/1Click has no testnet",
      "After explicit funding approval, demonstrate a small mainnet paid invoice using the documented 1Click API, or report the blocker",
      "Verify destination settlement from authoritative provider evidence",
      "Add relayer sponsorship limited to the project's own contract/methods",
      "Add refunds, webhook verification, reconciliation, CSV exports and accounting docs",
    ],
    approvalGate:
      "Before deploying contracts, using mainnet, or spending real funds, present the architecture and testnet plan and wait for the human's explicit OK.",
    requiredInputs: [
      {
        key: "network",
        label: "Network",
        help: "Local simulation or NEAR contract testnet for development; Intents settlement requires separately approved mainnet funds",
        required: true,
        validate: oneOf("Network", ["local", "testnet", "mainnet"]),
      },
      { key: "settlement_asset", label: "Settlement asset", help: "e.g. USDC on NEAR", required: true },
      {
        key: "provider_api_base",
        label: "1Click API base",
        help: "Use the current official 1Click API base URL",
        required: false,
        validate: httpsUrl,
      },
      {
        key: "relayer_account",
        label: "Relayer account",
        help: "NEAR account that sponsors approved calls; never a private key",
        required: false,
        validate: nearAccount,
      },
      {
        key: "contract_account",
        label: "Application contract",
        help: "Project-owned NEAR contract account, if it already exists",
        required: false,
        validate: nearAccount,
      },
    ],
    constraints: [
      "Do not invent 1Click endpoints, routes, fees or settlement guarantees.",
      "Mark an invoice PAID only after authoritative destination-side settlement.",
      "Never put the relayer private key in the browser, model, logs or receipts.",
      "No mainnet funds in automated tests; a separate mainnet demonstration requires explicit funding approval.",
      "NEAR contract testnet results are not NEAR Intents settlement evidence.",
    ],
  },
  {
    id: "business",
    name: "Autonomous Business",
    theme: "The company of one. Or none.",
    description:
      "A one-agent research shop: customers pay through NEAR Intents, the agent buys inference from NEAR AI Cloud, and a configured share of each sale goes to contributors.",
    readiness: "simulated",
    readinessNote:
      "A deterministic local sale gate, inference budget, revenue split and contributor payout run in `tracks run business`. No live Intents settlement, AI Cloud purchase or treasury transfer is claimed.",
    buildOrder: [
      "Read official NEAR accounts/keys/Intents and NEAR AI Cloud/OutLayer documentation",
      "Present the architecture sketch, trust boundaries, failure cases and sequence diagram",
      "Wait for the human's explicit OK",
      "Build config.yaml validation, policy engine and kill switch",
      "Build the paid report lifecycle, inference reservation and revenue split",
      "Add the public read-only ledger and Ash receipt chain integration",
      "Run a local simulation; demonstrate real Intents settlement only on explicitly approved mainnet funds, or report the exact blocker",
    ],
    approvalGate:
      "STOP after the architecture sketch and data-source review. Do not deploy, create production accounts, move funds or implement the gated system before explicit human approval.",
    requiredInputs: [
      {
        key: "treasury_account",
        label: "Business treasury account",
        help: "NEAR account; never include a private key",
        required: true,
        validate: nearAccount,
      },
      {
        key: "daily_inference_limit",
        label: "Max inference spend per day",
        help: "Amount in a supported currency",
        required: true,
        validate: positiveAmount,
      },
      {
        key: "revenue_split",
        label: "Revenue split",
        help: "e.g. 70% treasury, 20% contributors, 10% reserve; must total 100%",
        required: true,
        validate: percentageSplit,
      },
      {
        key: "contributor_accounts",
        label: "Contributor accounts",
        help: "Comma-separated named accounts and percentages",
        required: false,
      },
      {
        key: "kill_switch",
        label: "Kill switch",
        help: "How the owner stops new work and outbound transfers",
        required: true,
      },
    ],
    constraints: [
      "Validate revenue splits exactly; use integer minor units.",
      "Do not spend on inference before payment verification and policy checks.",
      "Payouts are paid only after authoritative settlement evidence.",
      "Do not claim function-call keys can do more than NEAR's permission model allows.",
    ],
  },
  {
    id: "security",
    name: "AI Security & Defense",
    theme: "Trust, but verify.",
    description:
      "A counterparty-check service and signing-boundary wrapper that returns ALLOW, WARN or BLOCK before an agent pays or calls a contract.",
    readiness: "simulated",
    readinessNote:
      "Budget enforcement, typed approvals, tool allowlists, injection checks and receipt verification work. The local ALLOW/WARN/BLOCK and signing-refusal demo runs in `tracks run security`; no on-chain signer or live risk feed is connected.",
    buildOrder: [
      "Read official NEAR accounts/access-key/contract docs and verify security data sources",
      "Prepare the data-source table, scoring policy and attack-demo sequence",
      "Present the architecture and wait for explicit human OK",
      "Build the counterparty service, fail-safe policy and decision log",
      "Build the signing-boundary wrapper with function-call-key limits",
      "Build the testnet/local attack demo proving no signature was produced",
    ],
    approvalGate:
      "STOP after the data-source table and architecture/attack-demo review. Wait for explicit human OK before building the service, wrapper or attack demo.",
    requiredInputs: [
      { key: "target_chain", label: "Target chain", help: "e.g. NEAR testnet", required: true },
      {
        key: "fail_mode",
        label: "Unknown-signal policy",
        help: "WARN or BLOCK; BLOCK is the safe default",
        required: true,
        validate: oneOf("Unknown-signal policy", ["WARN", "BLOCK"]),
      },
      {
        key: "policy_thresholds",
        label: "Policy thresholds",
        help: "Risk thresholds and required evidence freshness",
        required: true,
      },
      {
        key: "contract_allowlist",
        label: "Approved contract allowlist",
        help: "Only the project's own contract/methods may be called",
        required: false,
      },
    ],
    constraints: [
      "Never store or expose a full-access key; use a scoped function-call key where sufficient.",
      "Never silently treat unknown/unavailable checks as ALLOW.",
      "The wrapper must sit at the signing/broadcast boundary, not only in the UI.",
      "Fixtures labelled malicious need defensible evidence; use testnet/local simulation only.",
    ],
  },
  {
    id: "privacy",
    name: "Privacy & Private AI",
    theme: "Private by design.",
    description:
      "A private expense auditor using a TEE-hosted NEAR AI Cloud model, fresh nonces and official attestation verification, with no server-side retention of financial content.",
    readiness: "simulated",
    readinessNote:
      "A deterministic local expense audit, redaction and no-raw-document-retention check runs in `tracks run privacy`. No NEAR AI Cloud TEE call, fresh-nonce attestation or provider verification is claimed; ordinary chat is still persisted.",
    buildOrder: [
      "Read the current NEAR AI Cloud API, model and attestation verification docs",
      "Use the installed near-ai-cloud agent skill if available; stop if it is not",
      "Discover a TEE-hosted model from the models endpoint",
      "Build and run a minimal completion + fresh-nonce + attestation-verification script",
      "Build the UI only after that script works",
      "Add fictional sample documents and prove cleanup on success/failure/cancel",
    ],
    approvalGate:
      "Before building the UI, show the real minimal-script output (with secrets redacted). If credentials or a TEE model are unavailable, report the exact blocker instead of faking verification.",
    requiredInputs: [
      {
        key: "model",
        label: "TEE-hosted model",
        help: "Must be confirmed by the provider's models endpoint, not by its name alone",
        required: true,
      },
      {
        key: "attestation_endpoint",
        label: "Attestation endpoint",
        help: "Official NEAR AI Cloud attestation mechanism",
        required: true,
        validate: httpsUrl,
      },
      {
        key: "retention_mode",
        label: "Retention mode",
        help: "Must be no-server-side-persistence",
        required: true,
        validate: oneOf("Retention mode", ["no-server-side-persistence"]),
      },
    ],
    constraints: [
      "Never show a Verified state unless official verification passed.",
      "Do not persist documents, extracted data, prompts or responses server-side.",
      "Do not fall back to a non-TEE model without explicit consent and disclosure.",
      "Attestation does not prove the model's conclusions or the document's authenticity.",
    ],
  },
  {
    id: "swarms",
    name: "AI Swarms",
    theme: "Many agents. One economy.",
    description:
      "A group-buying swarm for GPU hours: buyer agents pool demand, seller agents submit sealed bids, and a deterministic coordinator selects a winner and settles through NEAR Intents.",
    readiness: "simulated",
    readinessNote:
      "A deterministic 20-buyer/5-seller sealed-bid group purchase runs in `tracks run swarms`. No contracts, per-agent sub-accounts or live pooled settlement are deployed.",
    buildOrder: [
      "Read official NEAR sub-account/key/contract and NEAR Intents docs",
      "Define deterministic market rules and write RULES.md first",
      "Write the text sequence diagram and custody/settlement assumptions",
      "Present RULES.md and the sequence diagram; wait for explicit human OK",
      "Build the deterministic 20-buyer/5-seller simulation with replayable seeds",
      "Build commit/reveal and settlement only for verified provider capabilities",
      "Add the live market page with real evidence only",
    ],
    approvalGate:
      "STOP after RULES.md and the round sequence diagram. Do not write/deploy smart contracts, create live accounts or move funds before explicit human approval.",
    requiredInputs: [
      {
        key: "parent_account",
        label: "Parent NEAR account",
        help: "Sub-accounts derive from this; no private keys",
        required: true,
        validate: nearAccount,
      },
      { key: "buyer_count", label: "Buyer count", help: "Simulation default is 20", required: true, validate: count },
      { key: "seller_count", label: "Seller count", help: "Simulation default is 5", required: true, validate: count },
      {
        key: "gpu_product",
        label: "GPU product/spec",
        help: "Quantity, delivery window, quality and payment terms",
        required: true,
      },
    ],
    constraints: [
      "Sealed bids must not leak before reveal; never put unrevealed secrets in public state/logs.",
      "Winner selection, tie-breaks, fees and shares must be deterministic integer arithmetic.",
      "Do not assume NEAR Intents supports atomic group escrow/split payouts.",
      "Simulation data must be clearly labelled; no LLM calls required for the market simulation.",
    ],
  },
  {
    id: "social",
    name: "Social Money",
    theme: "Coordinate value together.",
    description:
      "A bounty board with earned reputation that routes payouts through an existing Sputnik DAO or Trezu treasury without rebuilding custody or multisig.",
    readiness: "simulated",
    readinessNote:
      "A deterministic Sputnik/Trezu-shaped bounty approval, payout and reputation flow runs in `tracks run social`. No DAO proposal, treasury transaction or council approval is executed.",
    buildOrder: [
      "Read Sputnik DAO contracts/source and Trezu documentation",
      "Map existing custody, proposal and approval flows",
      "Report which small/mid/large payout tiers are supported without contract changes",
      "Wait for explicit human OK before implementing or changing treasury integration",
      "Build the bounty lifecycle, evidence review and reputation events",
      "Add tier routing only inside the treasury's actual permissions",
      "Add public board and privacy-aware reputation history",
    ],
    approvalGate:
      "STOP after the documentation review and approval-flow comparison report. Wait for explicit human OK before implementing the bounty board or changing treasury integrations.",
    requiredInputs: [
      {
        key: "treasury_type",
        label: "Treasury type",
        help: "sputnik or trezu",
        required: true,
        validate: oneOf("Treasury type", ["sputnik", "trezu"]),
      },
      {
        key: "treasury_account",
        label: "Treasury account",
        help: "Existing community treasury; never include keys",
        required: true,
        validate: nearAccount,
      },
      {
        key: "reputation_policy",
        label: "Reputation policy",
        help: "How points are earned, corrected and used for routing",
        required: true,
      },
      {
        key: "payout_tiers",
        label: "Payout tiers",
        help: "Small/mid/large thresholds and approval routing",
        required: true,
      },
    ],
    constraints: [
      "Do not rebuild the multisig or create parallel custody.",
      "Reputation never grants direct treasury signing rights.",
      "Auto-approval is allowed only if the existing treasury supports a compatible policy flow.",
      "Never fabricate council approvals or on-chain payout evidence.",
    ],
  },
];

export interface ProjectTemplate {
  id: "ash";
  name: string;
  theme: string;
  description: string;
  scopes: ProjectScope[];
  buildOrder: string[];
  approvalGate: string;
  requiredInputs: TrackInputSpec[];
  constraints: string[];
}

export const PROJECT_ID = "ash";

function prefixedKey(scope: ProjectScope, key: string): string {
  return `${scope.id}.${key}`;
}

/** The six workstreams as a single project profile, with every gate preserved. */
export const PROJECT: ProjectTemplate = {
  id: PROJECT_ID,
  name: "Ash",
  theme: "One project. Six workstreams. One auditable money system.",
  description:
    "Ash is a single task execution and settlement system. Its hackathon scope covers real-world money, autonomous business, AI security, private AI, AI swarms and social money as connected workstreams of one project.",
  scopes: SCOPES,
  buildOrder: SCOPES.flatMap((scope) => scope.buildOrder.map((step) => `${scope.name} (${scope.id}): ${step}`)),
  approvalGate: SCOPES.map(
    (scope) => `[${scope.id}] ${scope.approvalGate ?? "none beyond the normal plan/approval policy"}`,
  ).join(" "),
  requiredInputs: SCOPES.flatMap((scope) =>
    scope.requiredInputs
      .filter((spec) => spec.required)
      .map((spec) => ({ ...spec, key: prefixedKey(scope, spec.key), label: `${scope.name}: ${spec.label}` })),
  ),
  constraints: SCOPES.flatMap((scope) =>
    scope.constraints.map((constraint) => `${scope.name} (${scope.id}): ${constraint}`),
  ),
};

export function getScope(id: string | null | undefined): ProjectScope | null {
  if (!id) return null;
  return SCOPES.find((scope) => scope.id === id.trim().toLowerCase()) ?? null;
}

export function isProjectId(id: string | null | undefined): boolean {
  const normalized = id?.trim().toLowerCase();
  return normalized === PROJECT_ID || normalized === "all" || normalized === "project";
}

/** Selected scopes for a task. New tasks use the single project profile. */
export function resolveScopes(
  trackId: string | null | undefined,
  projectScopes: string[] | null | undefined,
): ProjectScope[] {
  if (!trackId) return [];
  if (isProjectId(trackId)) {
    const ids = projectScopes && projectScopes.length > 0 ? projectScopes : SCOPES.map((scope) => scope.id);
    return ids.map((id) => getScope(id)).filter((scope): scope is ProjectScope => scope !== null);
  }
  const scope = getScope(trackId);
  return scope ? [scope] : [];
}

export function projectLabel(trackId: string | null | undefined, projectScopes: string[] | null | undefined): string {
  const scopes = resolveScopes(trackId, projectScopes);
  if (!trackId) return "custom";
  if (isProjectId(trackId)) {
    if (scopes.length === SCOPES.length) return `${PROJECT.name} · all workstreams`;
    return `${PROJECT.name} · ${scopes.map((scope) => scope.name).join(", ") || "no workstreams"}`;
  }
  return scopes[0]?.name ?? trackId;
}

/** Inputs for the unified project use `scope.key` to avoid collisions. */
export function scopeInputKey(scope: ProjectScope, key: string): string {
  return prefixedKey(scope, key);
}

export function validateScopeInputs(
  scope: ProjectScope,
  inputs: Record<string, string>,
  options: { prefix?: boolean } = {},
): string[] {
  const errors: string[] = [];
  for (const spec of scope.requiredInputs) {
    const key = options.prefix ? prefixedKey(scope, spec.key) : spec.key;
    const value = inputs[key]?.trim() ?? "";
    if (!value) {
      if (spec.required) errors.push(`${spec.label} is required`);
      continue;
    }
    const error = spec.validate?.(value);
    if (error) errors.push(`${spec.label}: ${error}`);
  }
  return errors;
}

export function validateProjectInputs(scopes: ProjectScope[], inputs: Record<string, string>): string[] {
  return scopes.flatMap((scope) =>
    validateScopeInputs(scope, inputs, { prefix: true }).map((error) => `${scope.name}: ${error}`),
  );
}

export function trackPromptBlock(
  scope: ProjectScope,
  inputs: Record<string, string>,
  options: { prefix?: boolean } = {},
): string {
  const provided = Object.entries(inputs)
    .filter(([key, value]) => value.trim() && (!options.prefix || key.startsWith(`${scope.id}.`)))
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
  return [
    `WORKSTREAM: ${scope.name} (${scope.id})`,
    `WORKSTREAM THEME: ${scope.theme}`,
    `WORKSTREAM DESCRIPTION: ${scope.description}`,
    "MANDATORY BUILD ORDER:",
    ...scope.buildOrder.map((step, index) => `${index + 1}. ${step}`),
    `APPROVAL GATE: ${scope.approvalGate ?? "none beyond the normal plan/approval policy"}`,
    "PROJECT INPUTS SUPPLIED BY THE HUMAN:",
    provided || "- none",
    "WORKSTREAM CONSTRAINTS:",
    ...scope.constraints.map((constraint) => `- ${constraint}`),
  ].join("\n");
}

export function projectPromptBlock(scopes: ProjectScope[], inputs: Record<string, string>): string {
  if (scopes.length === 0) return "PROJECT: Ash — custom scope (no workstream template selected)";
  const provided = Object.entries(inputs)
    .filter(([, value]) => value.trim())
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
  return [
    `PROJECT: ${PROJECT.name} (${PROJECT.id})`,
    `PROJECT THEME: ${PROJECT.theme}`,
    `PROJECT DESCRIPTION: ${PROJECT.description}`,
    `WORKSTREAMS IN SCOPE: ${scopes.map((scope) => `${scope.name} (${scope.id})`).join(", ")}`,
    "MANDATORY BUILD ORDER:",
    ...scopes.flatMap((scope) => scope.buildOrder.map((step, index) => `[${scope.id}] ${index + 1}. ${step}`)),
    "APPROVAL GATES (one per workstream; every gate must be honored):",
    ...scopes.map((scope) => `[${scope.id}] ${scope.approvalGate ?? "none beyond the normal plan/approval policy"}`),
    "PROJECT INPUTS SUPPLIED BY THE HUMAN:",
    provided || "- none",
    "WORKSTREAM CONSTRAINTS:",
    ...scopes.flatMap((scope) => scope.constraints.map((constraint) => `[${scope.id}] ${constraint}`)),
  ].join("\n");
}
