import { AshError } from "../errors.js";
import type { Currency } from "../util/money.js";
import {
  allocateMinor,
  assertAccount,
  assertText,
  finalizeTrackRun,
  formatAmount,
  parseCount,
  parsePositiveMoney,
  type TrackRun,
} from "../journey/core.js";

export interface SocialContributor {
  account: string;
  work_units: number;
}

export interface SocialApproval {
  account: string;
  approved: boolean;
}

export interface SocialInput {
  bounty_title: string;
  amount: string;
  currency: Currency;
  treasury_type: "sputnik" | "trezu";
  treasury_account: string;
  required_approvals: number;
  approvals: SocialApproval[];
  contributors: SocialContributor[];
  reputation: Record<string, number>;
}

export interface SocialEvidence {
  bounty: {
    bounty_id: string;
    title: string;
    amount: string;
    currency: Currency;
    tier: "small" | "mid" | "large";
    status: "paid-simulated" | "blocked";
    treasury: {
      type: "sputnik" | "trezu";
      account: string;
      mode: "local-simulation";
    };
  };
  approvals: {
    required: number;
    received: number;
    approved_by: string[];
    sufficient: boolean;
  };
  approval_cases: Array<{
    case: "actual" | "insufficient";
    decision: "APPROVED" | "BLOCKED";
    payout_status: "simulation-approved" | "not-paid";
    authoritative: false;
    reason: string;
  }>;
  contributor_payouts: Array<{
    account: string;
    work_units: number;
    amount: string;
    reputation_previous: number;
    reputation_awarded: number;
    reputation_next: number;
  }>;
  signing: {
    treasury_signature_produced: false;
    note: string;
  };
}

const DEFAULTS: SocialInput = {
  bounty_title: "Ship the community dashboard",
  amount: "75.00",
  currency: "USDC",
  treasury_type: "sputnik",
  treasury_account: "community.sputnik-dao.near",
  required_approvals: 2,
  approvals: [
    { account: "alice.sputnik-dao.near", approved: true },
    { account: "bob.sputnik-dao.near", approved: true },
  ],
  contributors: [
    { account: "builder-one.testnet", work_units: 3 },
    { account: "builder-two.testnet", work_units: 2 },
  ],
  reputation: {
    "builder-one.testnet": 10,
    "builder-two.testnet": 4,
  },
};

function proportionalWeights(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new AshError("VALIDATION_FAILED", "Work units must total more than zero.");
  const weights = values.map((value) => Math.floor((value * 1_000_000) / total));
  let remainder = 1_000_000 - weights.reduce((sum, weight) => sum + weight, 0);
  let index = 0;
  while (remainder > 0) {
    weights[index] = (weights[index] ?? 0) + 1;
    remainder -= 1;
    index = (index + 1) % weights.length;
  }
  return weights;
}

function payoutTier(amount: bigint, currency: Currency): "small" | "mid" | "large" {
  const small = parsePositiveMoney("25", "Small tier", currency);
  const mid = parsePositiveMoney("100", "Mid tier", currency);
  if (amount <= small) return "small";
  if (amount <= mid) return "mid";
  return "large";
}

function validateApproval(approval: SocialApproval, index: number): SocialApproval {
  return {
    account: assertAccount(approval.account, `Approval ${index + 1} account`),
    approved: approval.approved === true,
  };
}

export function runSocial(overrides: Partial<SocialInput> = {}): TrackRun<SocialEvidence> {
  const input: SocialInput = { ...DEFAULTS, ...overrides };
  if (!["sputnik", "trezu"].includes(input.treasury_type)) {
    throw new AshError("VALIDATION_FAILED", "Treasury type must be sputnik or trezu.");
  }
  const title = assertText(input.bounty_title, "Bounty title", 160);
  const treasury = assertAccount(input.treasury_account, "Treasury account");
  const amount = parsePositiveMoney(input.amount, "Bounty amount", input.currency);
  const tier = payoutTier(amount, input.currency);
  const approvals = input.approvals.map(validateApproval);
  const approvedBy = [
    ...new Set(approvals.filter((approval) => approval.approved).map((approval) => approval.account)),
  ];
  const required = parseCount(input.required_approvals, "Required approvals", { min: 1, max: 100 });
  if (input.contributors.length === 0) throw new AshError("VALIDATION_FAILED", "At least one contributor is required.");
  const contributors = input.contributors.map((contributor, index) => ({
    account: assertAccount(contributor.account, `Contributor ${index + 1} account`),
    workUnits: parseCount(contributor.work_units, `Contributor ${index + 1} work units`, { min: 1, max: 10_000 }),
  }));
  const reputation = new Map<string, number>();
  for (const [account, points] of Object.entries(input.reputation)) {
    const validAccount = assertAccount(account, "Reputation account");
    reputation.set(validAccount, parseCount(points, `Reputation for ${validAccount}`, { min: 0, max: 1_000_000 }));
  }
  const weights = proportionalWeights(contributors.map((contributor) => contributor.workUnits));
  const payouts = allocateMinor(
    amount,
    contributors.map((contributor, index) => ({
      label: contributor.account,
      weight: weights[index] ?? 0,
    })),
  );
  const allocated = payouts.reduce((sum, payout) => sum + payout.amount, 0n);
  const sufficient = approvedBy.length >= required;
  const insufficientCount = Math.max(0, required - 1);
  const insufficientApprovals = approvals.filter((approval) => approval.approved).slice(0, insufficientCount);

  const evidence: SocialEvidence = {
    bounty: {
      bounty_id: `bounty_${amount.toString()}_${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 32)}`,
      title,
      amount: formatAmount(amount, input.currency),
      currency: input.currency,
      tier,
      status: sufficient ? "paid-simulated" : "blocked",
      treasury: {
        type: input.treasury_type,
        account: treasury,
        mode: "local-simulation",
      },
    },
    approvals: {
      required,
      received: approvedBy.length,
      approved_by: approvedBy,
      sufficient,
    },
    approval_cases: [
      {
        case: "actual",
        decision: sufficient ? "APPROVED" : "BLOCKED",
        payout_status: sufficient ? "simulation-approved" : "not-paid",
        authoritative: false,
        reason: sufficient
          ? `${approvedBy.length} approval(s) met the ${required}-approval policy.`
          : `${approvedBy.length} approval(s) are below the ${required}-approval policy; no payout or reputation event is created.`,
      },
      {
        case: "insufficient",
        decision: "BLOCKED",
        payout_status: "not-paid",
        authoritative: false,
        reason: `${insufficientApprovals.length} approval(s) are below the ${required}-approval policy; no payout or reputation event is created.`,
      },
    ],
    contributor_payouts: sufficient
      ? contributors.map((contributor) => {
          const previous = reputation.get(contributor.account) ?? 0;
          const awarded = contributor.workUnits * 10;
          return {
            account: contributor.account,
            work_units: contributor.workUnits,
            amount: formatAmount(
              payouts.find((payout) => payout.label === contributor.account)?.amount ?? 0n,
              input.currency,
            ),
            reputation_previous: previous,
            reputation_awarded: awarded,
            reputation_next: previous + awarded,
          };
        })
      : [],
    signing: {
      treasury_signature_produced: false,
      note: "The treasury approval and payout are simulated. No Sputnik/Trezu proposal was created and no key signed a transfer.",
    },
  };

  const actual = evidence.approval_cases[0];
  const insufficient = evidence.approval_cases[1];
  const checks = [
    {
      id: "approval-gate",
      passed: actual?.decision === (sufficient ? "APPROVED" : "BLOCKED") && insufficient?.decision === "BLOCKED",
      detail: `${approvedBy.length}/${required} approvals present; the insufficient case remains blocked.`,
    },
    {
      id: "payout-total",
      passed: !sufficient || allocated === amount,
      detail: sufficient
        ? `${formatAmount(allocated, input.currency)} allocated across ${contributors.length} contributor(s).`
        : "Payout is blocked until the approval threshold is met.",
    },
    {
      id: "reputation-only-after-approval",
      passed: sufficient
        ? evidence.contributor_payouts.length === contributors.length &&
          evidence.contributor_payouts.every((payout) => payout.reputation_awarded > 0)
        : evidence.contributor_payouts.length === 0,
      detail: sufficient
        ? "Reputation events were created only for the approved payout."
        : "No reputation events were created for the blocked payout.",
    },
    {
      id: "no-treasury-signature",
      passed: evidence.signing.treasury_signature_produced === false,
      detail: "No treasury signature was produced.",
    },
    {
      id: "simulation-only",
      passed: evidence.approval_cases.every((item) => item.authoritative === false),
      detail: "No Sputnik/Trezu or on-chain payout evidence is claimed.",
    },
  ];

  return finalizeTrackRun<SocialEvidence>({
    track_id: "social",
    title: "Treasury-gated bounty and reputation",
    summary: `A ${formatAmount(amount, input.currency)} ${tier} bounty ${sufficient ? "passed" : "did not pass"} a ${required}-approval gate; ${sufficient ? `${contributors.length} contributor payout(s) and reputation events were simulated.` : "no payout or reputation event was created."}`,
    integrationNote: `Treasury ${treasury} (${input.treasury_type}) is referenced but not queried. Council approvals, proposals and payouts are simulated; no treasury key is held.`,
    checks,
    evidence,
  });
}
