import { AshError } from "../errors.js";
import type { Currency } from "../util/money.js";
import {
  assertAccount,
  finalizeTrackRun,
  formatAmount,
  parseCount,
  parsePositiveMoney,
  type TrackRun,
} from "../journey/core.js";

export interface SecuritySignals {
  verified: boolean | null;
  account_age_days: number | null;
  allowlisted: boolean;
  contract_allowlisted: boolean;
  sanctions_hit: boolean;
  report_count: number;
}

export interface SecuritySubject {
  counterparty: string;
  amount: string;
  currency: Currency;
  signals: SecuritySignals;
}

export interface SecurityPolicy {
  min_account_age_days: number;
  high_value_threshold: string;
  fail_mode: "BLOCK" | "WARN";
  contract_allowlist: string[];
}

export interface SecurityInput {
  allowed_case: SecuritySubject;
  attack_case: SecuritySubject;
  policy: SecurityPolicy;
}

export type SecurityDecision = "ALLOW" | "WARN" | "BLOCK";

export interface SecurityEvaluation {
  case: "allowed" | "attack";
  counterparty: string;
  amount: string;
  currency: Currency;
  decision: SecurityDecision;
  risk_score: number;
  reasons: string[];
  signing: {
    signature_produced: false;
    note: string;
  };
}

export interface SecurityEvidence {
  policy: SecurityPolicy;
  decisions: SecurityEvaluation[];
  decision_log: Array<{
    at: string;
    counterparty: string;
    decision: SecurityDecision;
    signature_produced: false;
  }>;
}

const DEFAULTS: SecurityInput = {
  allowed_case: {
    counterparty: "trusted-vendor.testnet",
    amount: "25.00",
    currency: "USDC",
    signals: {
      verified: true,
      account_age_days: 400,
      allowlisted: true,
      contract_allowlisted: true,
      sanctions_hit: false,
      report_count: 0,
    },
  },
  attack_case: {
    counterparty: "unknown-new.testnet",
    amount: "500.00",
    currency: "USDC",
    signals: {
      verified: null,
      account_age_days: 2,
      allowlisted: false,
      contract_allowlisted: false,
      sanctions_hit: false,
      report_count: 2,
    },
  },
  policy: {
    min_account_age_days: 30,
    high_value_threshold: "100.00",
    fail_mode: "BLOCK",
    contract_allowlist: ["ash-payments.testnet"],
  },
};

function validateSignals(signals: SecuritySignals, label: string): SecuritySignals {
  const accountAge = signals.account_age_days;
  if (accountAge !== null && (!Number.isInteger(accountAge) || accountAge < 0 || accountAge > 100_000)) {
    throw new AshError("VALIDATION_FAILED", `${label} account age must be a non-negative whole number or unknown.`);
  }
  if (typeof signals.verified !== "boolean" && signals.verified !== null) {
    throw new AshError("VALIDATION_FAILED", `${label} verification must be true, false or unknown.`);
  }
  for (const [key, value] of Object.entries({
    allowlisted: signals.allowlisted,
    contract_allowlisted: signals.contract_allowlisted,
    sanctions_hit: signals.sanctions_hit,
  })) {
    if (typeof value !== "boolean") {
      throw new AshError("VALIDATION_FAILED", `${label} ${key} must be true or false.`);
    }
  }
  const reportCount = parseCount(signals.report_count, `${label} report count`, { min: 0, max: 1_000 });
  return { ...signals, report_count: reportCount };
}

function evaluate(
  subject: SecuritySubject,
  policy: SecurityPolicy,
  testCase: "allowed" | "attack",
): SecurityEvaluation {
  const counterparty = assertAccount(subject.counterparty, `${testCase} counterparty`);
  const amount = parsePositiveMoney(subject.amount, `${testCase} amount`, subject.currency);
  const threshold = parsePositiveMoney(policy.high_value_threshold, "High-value threshold", subject.currency);
  const signals = validateSignals(subject.signals, testCase);
  const minAge = parseCount(policy.min_account_age_days, "Minimum account age", { min: 0, max: 100_000 });
  const allowlist = policy.contract_allowlist.map((account, index) =>
    assertAccount(account, `Allowlisted contract ${index + 1}`),
  );
  const reasons: string[] = [];
  let score = 0;

  if (signals.sanctions_hit) {
    score += 100;
    reasons.push("sanctions signal is present");
  }
  if (allowlist.length > 0 && !signals.contract_allowlisted) {
    score += 45;
    reasons.push("target contract is not on the allowlist");
  }
  if (signals.verified === null) {
    score += 40;
    reasons.push("verification status is unknown");
  }
  if (signals.account_age_days === null) {
    score += 25;
    reasons.push("account age is unknown");
  } else if (signals.account_age_days < minAge) {
    score += 20;
    reasons.push(`account is younger than ${minAge} days`);
  }
  if (amount > threshold) {
    score += 20;
    reasons.push(`amount exceeds the high-value threshold of ${formatAmount(threshold, subject.currency)}`);
  }
  if (signals.report_count > 0) {
    score += Math.min(40, signals.report_count * 15);
    reasons.push(`${signals.report_count} prior report(s) exist`);
  }
  if (signals.allowlisted) {
    score = Math.max(0, score - 25);
    reasons.push("counterparty is allowlisted");
  }
  if (signals.verified === true) {
    score = Math.max(0, score - 15);
    reasons.push("verification is current");
  }
  if (signals.contract_allowlisted) {
    score = Math.max(0, score - 10);
    reasons.push("target contract is allowlisted");
  }
  score = Math.min(100, score);

  let decision: SecurityDecision;
  if (
    signals.sanctions_hit ||
    (allowlist.length > 0 && !signals.contract_allowlisted) ||
    signals.report_count >= 2 ||
    (signals.verified === null && policy.fail_mode === "BLOCK") ||
    (signals.account_age_days === null && policy.fail_mode === "BLOCK") ||
    (signals.verified === false && !signals.allowlisted) ||
    (amount > threshold && !signals.allowlisted)
  ) {
    decision = "BLOCK";
  } else if (
    signals.report_count === 1 ||
    signals.verified === null ||
    signals.account_age_days === null ||
    amount > threshold ||
    (signals.account_age_days !== null && signals.account_age_days < minAge)
  ) {
    decision = "WARN";
  } else {
    decision = "ALLOW";
  }

  return {
    case: testCase,
    counterparty,
    amount: formatAmount(amount, subject.currency),
    currency: subject.currency,
    decision,
    risk_score: score,
    reasons: reasons.length > 0 ? reasons : ["all required signals are known and within policy"],
    signing: {
      signature_produced: false,
      note: "This is a policy evaluation at the signing boundary. No key is loaded and no transaction is signed.",
    },
  };
}

export function runSecurity(overrides: Partial<SecurityInput> = {}): TrackRun<SecurityEvidence> {
  const input: SecurityInput = {
    allowed_case: overrides.allowed_case ?? DEFAULTS.allowed_case,
    attack_case: overrides.attack_case ?? DEFAULTS.attack_case,
    policy: overrides.policy ?? DEFAULTS.policy,
  };
  if (!["BLOCK", "WARN"].includes(input.policy.fail_mode)) {
    throw new AshError("VALIDATION_FAILED", "Unknown-signal policy must be BLOCK or WARN.");
  }
  const allowed = evaluate(input.allowed_case, input.policy, "allowed");
  const attack = evaluate(input.attack_case, input.policy, "attack");
  const evidence: SecurityEvidence = {
    policy: input.policy,
    decisions: [allowed, attack],
    decision_log: [allowed, attack].map((decision) => ({
      at: new Date().toISOString(),
      counterparty: decision.counterparty,
      decision: decision.decision,
      signature_produced: false,
    })),
  };
  const checks = [
    {
      id: "verified-counterparty",
      passed: allowed.decision === "ALLOW",
      detail: `${allowed.counterparty} received ${allowed.decision} with risk score ${allowed.risk_score}.`,
    },
    {
      id: "unknown-counterparty-blocked",
      passed: attack.decision === "BLOCK",
      detail: `${attack.counterparty} received ${attack.decision} with risk score ${attack.risk_score}.`,
    },
    {
      id: "fail-safe-unknown",
      passed: attack.reasons.some((reason) => reason.includes("unknown")),
      detail: "Unknown verification or age signals cannot become an automatic ALLOW in the default policy.",
    },
    {
      id: "no-signature",
      passed: [allowed, attack].every((decision) => decision.signing.signature_produced === false),
      detail: "No signing key was loaded and no transaction signature was produced.",
    },
  ];

  return finalizeTrackRun<SecurityEvidence>({
    track_id: "security",
    title: "Counterparty policy and signing boundary",
    summary: `Evaluated a trusted vendor (${allowed.decision}) and an unknown high-risk counterparty (${attack.decision}) before the signing boundary.`,
    integrationNote:
      "Policy evaluation is local and deterministic. No NEAR RPC, signer, access key or contract call is used, so no on-chain evidence is claimed.",
    checks,
    evidence,
  });
}
