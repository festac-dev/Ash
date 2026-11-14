import { AshError } from "../errors.js";
import type { Currency, Minor } from "../util/money.js";
import { nowIso } from "../util/time.js";
import {
  allocateMinor,
  assertAccount,
  assertText,
  equalWeights,
  finalizeTrackRun,
  formatAmount,
  parseMoney,
  parsePositiveMoney,
  percentWeight,
  type AllocationLine,
  type TrackRun,
} from "../journey/core.js";

export interface RevenueSplitInput {
  label: string;
  percent: number;
}

export interface BusinessInput {
  treasury_account: string;
  currency: Currency;
  sale_amount: string;
  sale_paid: boolean;
  split: RevenueSplitInput[];
  contributor_accounts: string[];
  daily_inference_limit: string;
  inference_spend: string;
}

export interface BusinessEvidence {
  sale: {
    sale_id: string;
    status: "paid";
    currency: Currency;
    amount: string;
    verified_source: "local-simulation";
    authoritative: false;
  };
  policy: {
    allowed: true;
    inference_limit: string;
    inference_spend: string;
    inference_remaining: string;
    checks: string[];
  };
  allocations: Array<{
    bucket: string;
    percent: number;
    amount: string;
  }>;
  contributor_payouts: Array<{
    account: string;
    amount: string;
  }>;
  totals: {
    allocated: string;
    contributor_distributed: string;
  };
  report: {
    status: "delivered";
    delivered_at: string;
    verified: true;
  };
}

const DEFAULTS: BusinessInput = {
  treasury_account: "ash-treasury.testnet",
  currency: "USDC",
  sale_amount: "250.00",
  sale_paid: true,
  split: [
    { label: "treasury", percent: 70 },
    { label: "contributors", percent: 20 },
    { label: "reserve", percent: 10 },
  ],
  contributor_accounts: ["alice.ash.testnet", "bob.ash.testnet"],
  daily_inference_limit: "20.00",
  inference_spend: "6.50",
};

function splitWeights(split: RevenueSplitInput[]): Array<{ label: string; weight: number; percent: number }> {
  if (split.length === 0) throw new AshError("VALIDATION_FAILED", "Revenue split must have at least one bucket.");
  const seen = new Set<string>();
  const rows = split.map((part, index) => {
    const label = assertText(part.label, `Revenue split bucket ${index + 1}`, 80).toLowerCase();
    if (seen.has(label)) throw new AshError("VALIDATION_FAILED", `Revenue split bucket "${label}" is duplicated.`);
    seen.add(label);
    return { label, weight: percentWeight(part.percent, `Revenue split ${label}`), percent: part.percent };
  });
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (total !== 1_000_000) {
    throw new AshError("VALIDATION_FAILED", "Revenue split must total exactly 100%.");
  }
  return rows;
}

export function runBusiness(overrides: Partial<BusinessInput> = {}): TrackRun<BusinessEvidence> {
  const input: BusinessInput = { ...DEFAULTS, ...overrides };
  const treasury = assertAccount(input.treasury_account, "Treasury account");
  if (!input.sale_paid) {
    throw new AshError("APPROVAL_REQUIRED", "The sale is not verified as paid; revenue allocation is blocked.");
  }
  const saleAmount = parsePositiveMoney(input.sale_amount, "Sale amount", input.currency);
  const inferenceLimit = parsePositiveMoney(input.daily_inference_limit, "Daily inference limit", input.currency);
  const inferenceSpend = parseMoney(input.inference_spend, "Inference spend", input.currency);
  if (inferenceSpend > inferenceLimit) {
    throw new AshError("BUDGET_EXCEEDED", "Inference spend exceeds the daily limit; new work is blocked.");
  }
  const split = splitWeights(input.split);
  const allocations = allocateMinor(
    saleAmount,
    split.map((row) => ({ label: row.label, weight: row.weight })),
  );
  const byBucket = new Map(allocations.map((line) => [line.label, line.amount]));
  const contributorPool = byBucket.get("contributors") ?? 0n;
  const contributorAccounts = input.contributor_accounts.map((account, index) =>
    assertAccount(account, `Contributor account ${index + 1}`),
  );
  const contributorLines =
    contributorPool > 0n && contributorAccounts.length > 0
      ? distribute(contributorPool, contributorAccounts, input.currency)
      : [];
  const contributorDistributed = contributorLines.reduce((sum, line) => sum + line.minor, 0n);
  if (contributorDistributed !== contributorPool) {
    throw new AshError("BUDGET_INVARIANT", "Contributor distribution did not match the contributor pool.");
  }
  const allocatedTotal = allocations.reduce((sum, line) => sum + line.amount, 0n);
  const remaining = inferenceLimit - inferenceSpend;

  const evidence: BusinessEvidence = {
    sale: {
      sale_id: `sale_${input.currency.toLowerCase()}_${saleAmount.toString()}`,
      status: "paid",
      currency: input.currency,
      amount: formatAmount(saleAmount, input.currency),
      verified_source: "local-simulation",
      authoritative: false,
    },
    policy: {
      allowed: true,
      inference_limit: formatAmount(inferenceLimit, input.currency),
      inference_spend: formatAmount(inferenceSpend, input.currency),
      inference_remaining: formatAmount(remaining, input.currency),
      checks: [
        "sale verified as paid before allocation",
        "inference spend is within the configured daily limit",
        "revenue split totals exactly 100%",
        "integer minor units used for every payout",
      ],
    },
    allocations: allocations.map((line) => {
      const row = split.find((item) => item.label === line.label);
      return {
        bucket: line.label,
        percent: row?.percent ?? 0,
        amount: formatAmount(line.amount, input.currency),
      };
    }),
    contributor_payouts: contributorLines.map((line) => ({
      account: line.account,
      amount: formatAmount(line.minor, input.currency),
    })),
    totals: {
      allocated: formatAmount(allocatedTotal, input.currency),
      contributor_distributed: formatAmount(contributorDistributed, input.currency),
    },
    report: {
      status: "delivered",
      delivered_at: nowIso(),
      verified: true,
    },
  };

  const checks = [
    {
      id: "sale-verified",
      passed: evidence.sale.status === "paid",
      detail: "Allocation only starts from a verified sale.",
    },
    {
      id: "split-total",
      passed: split.reduce((sum, row) => sum + row.weight, 0) === 1_000_000,
      detail: "Revenue buckets total exactly 100%.",
    },
    {
      id: "allocation-total",
      passed: allocatedTotal === saleAmount,
      detail: `${formatAmount(allocatedTotal, input.currency)} allocated from ${formatAmount(saleAmount, input.currency)}.`,
    },
    {
      id: "inference-limit",
      passed: inferenceSpend <= inferenceLimit,
      detail: `${formatAmount(remaining, input.currency)} remains in the daily inference budget.`,
    },
    {
      id: "contributor-distribution",
      passed: contributorDistributed === contributorPool,
      detail: `${formatAmount(contributorDistributed, input.currency)} distributed to ${contributorLines.length} contributor account(s).`,
    },
    {
      id: "simulation-only",
      passed: true,
      detail: "Treasury and contributor payouts are local simulation records, not on-chain transfers.",
    },
  ];

  return finalizeTrackRun<BusinessEvidence>({
    track_id: "business",
    title: "Autonomous business revenue and inference policy",
    summary: `Verified a ${formatAmount(saleAmount, input.currency)} sale, enforced the inference limit, and allocated the full amount across treasury, contributors and reserve.`,
    integrationNote: `Treasury ${treasury} is recorded as the policy destination. No treasury key is held and no transfer is signed; NEAR AI Cloud purchasing is not configured.`,
    checks,
    evidence,
  });
}

function distribute(total: Minor, accounts: string[], currency: Currency): Array<{ account: string; minor: Minor }> {
  const weights = equalWeights(accounts.length);
  const lines: AllocationLine[] = allocateMinor(
    total,
    accounts.map((account, index) => ({ label: account, weight: weights[index] ?? 0 })),
  );
  return lines.map((line) => ({ account: line.label, minor: line.amount }));
}
