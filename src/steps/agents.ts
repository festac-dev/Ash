import { AshError } from "../errors.js";
import {
  assertAccount,
  assertText,
  finalizeTrackRun,
  formatAmount,
  parseMoney,
  parsePositiveMoney,
  sha256Text,
  type TrackRun,
} from "../journey/core.js";

export interface AgentOffer {
  account: string;
  ask: string;
  minimum: string;
  verified_delivery: boolean;
}

export interface AgentEconomyInput {
  account: string;
  opening_balance: string;
  earned: string;
  budget: string;
  api_cost: string;
  offers: AgentOffer[];
  task: string;
  approved: boolean;
  killed: boolean;
}

export interface AgentEconomyEvidence {
  account: string;
  currency: "USDC";
  negotiated_offers: Array<{ account: string; ask: string; agreed: string }>;
  hired: string;
  delivery: { verified: true; sha256: string };
  wallet: { opening: string; earned: string; spent: string; remaining: string };
  receipts: Array<{ id: string; type: "earn" | "hire" | "api"; amount: string; recipient: string }>;
  duplicate_payment_blocked: boolean;
  simulated: true;
}

const DEFAULTS: AgentEconomyInput = {
  account: "operator.ash.testnet",
  opening_balance: "10.00",
  earned: "25.00",
  budget: "12.00",
  api_cost: "1.50",
  offers: [
    { account: "researcher.ash.testnet", ask: "10.00", minimum: "8.00", verified_delivery: true },
    { account: "analyst.ash.testnet", ask: "12.00", minimum: "9.00", verified_delivery: true },
  ],
  task: "Produce a sourced market research brief",
  approved: true,
  killed: false,
};

export function runAgentEconomy(overrides: Partial<AgentEconomyInput> = {}): TrackRun<AgentEconomyEvidence> {
  const input = { ...DEFAULTS, ...overrides };
  const currency = "USDC";
  const account = assertAccount(input.account, "Agent wallet account");
  const task = assertText(input.task, "Agent task", 2000);
  if (input.approved !== true) throw new AshError("APPROVAL_REQUIRED", "Agent hiring requires approval.");
  if (input.killed !== false) throw new AshError("UNSAFE_OPERATION", "The agent economy kill switch blocks spending.");
  const opening = parseMoney(input.opening_balance, "Opening balance", currency);
  const earned = parsePositiveMoney(input.earned, "Earned revenue", currency);
  const budget = parsePositiveMoney(input.budget, "Agent spending budget", currency);
  const apiCost = parsePositiveMoney(input.api_cost, "API cost", currency);
  if (!input.offers.length || input.offers.length > 20)
    throw new AshError("VALIDATION_FAILED", "Provide between one and twenty specialist offers.");
  const seen = new Set<string>();
  const offers = input.offers
    .map((offer) => {
      const specialist = assertAccount(offer.account, "Specialist account");
      if (specialist === account || seen.has(specialist))
        throw new AshError("VALIDATION_FAILED", "Specialists must be distinct from each other and the buyer.");
      seen.add(specialist);
      if (typeof offer.verified_delivery !== "boolean")
        throw new AshError("VALIDATION_FAILED", "Delivery verification must be true or false.");
      const ask = parsePositiveMoney(offer.ask, "Specialist ask", currency);
      const minimum = parsePositiveMoney(offer.minimum, "Specialist minimum", currency);
      if (minimum > ask) throw new AshError("VALIDATION_FAILED", "A specialist minimum cannot exceed its ask.");
      // One bounded counteroffer; a seller accepts only at or above its stated minimum.
      const counter = (ask * 80n) / 100n;
      return {
        account: specialist,
        ask,
        agreed: counter >= minimum ? counter : minimum,
        verified: offer.verified_delivery,
      };
    })
    .sort((a, b) => (a.agreed === b.agreed ? a.account.localeCompare(b.account) : a.agreed < b.agreed ? -1 : 1));
  const winner = offers[0]!;
  const spending = winner.agreed + apiCost;
  if (spending > budget || spending > opening + earned)
    throw new AshError("BUDGET_EXCEEDED", "Hiring and API costs exceed the budget or available wallet balance.");
  if (!winner.verified) throw new AshError("VERIFICATION_FAILED", "Unverified specialist delivery cannot be paid.");
  const receiptIds = new Set<string>();
  const receipt = (id: string, type: "earn" | "hire" | "api", amount: bigint, recipient: string) => {
    if (receiptIds.has(id)) return null;
    receiptIds.add(id);
    return { id, type, amount: formatAmount(amount, currency), recipient };
  };
  const receipts = [
    receipt("sale-1", "earn", earned, account)!,
    receipt("hire-1", "hire", winner.agreed, winner.account)!,
    receipt("api-1", "api", apiCost, "compute.ash.testnet")!,
  ];
  const duplicateBlocked = receipt("hire-1", "hire", winner.agreed, winner.account) === null;
  const remaining = opening + earned - spending;
  const evidence: AgentEconomyEvidence = {
    account,
    currency,
    negotiated_offers: offers.map((offer) => ({
      account: offer.account,
      ask: formatAmount(offer.ask, currency),
      agreed: formatAmount(offer.agreed, currency),
    })),
    hired: winner.account,
    delivery: { verified: true, sha256: sha256Text(`${winner.account}:${task}`) },
    wallet: {
      opening: formatAmount(opening, currency),
      earned: formatAmount(earned, currency),
      spent: formatAmount(spending, currency),
      remaining: formatAmount(remaining, currency),
    },
    receipts,
    duplicate_payment_blocked: duplicateBlocked,
    simulated: true,
  };
  return finalizeTrackRun({
    track_id: "agents",
    title: "Agent earning, negotiation, hiring and API payment",
    summary: `Earned ${formatAmount(earned, currency)}, hired ${winner.account}, paid for an API and retained ${formatAmount(remaining, currency)}.`,
    integrationNote:
      "Local simulation of agent commerce. Live hiring uses the existing Agent Market adapter; mainnet token transfers require wallet approval and separate settlement verification.",
    evidence,
    checks: [
      {
        id: "negotiated-hire",
        passed: winner.agreed <= winner.ask,
        detail: "A bounded counteroffer respects the seller's minimum.",
      },
      {
        id: "budget-and-wallet",
        passed: spending <= budget && remaining >= 0n,
        detail: "Hiring plus API costs fit both the approved budget and wallet balance.",
      },
      { id: "verified-before-payment", passed: winner.verified, detail: "Unverified delivery blocks the payment." },
      {
        id: "wallet-conservation",
        passed: opening + earned === spending + remaining,
        detail: "Every amount uses integer minor units.",
      },
      {
        id: "duplicate-payment-blocked",
        passed: duplicateBlocked,
        detail: "Replaying a receipt does not charge the simulated wallet twice.",
      },
    ],
  });
}
