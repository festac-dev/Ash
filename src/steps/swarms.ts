import { AshError } from "../errors.js";
import type { Currency, Minor } from "../util/money.js";
import {
  allocateMinor,
  assertText,
  equalWeights,
  finalizeTrackRun,
  formatAmount,
  parseCount,
  parsePositiveMoney,
  seededRandom,
  sha256Text,
  type TrackRun,
} from "../journey/core.js";

export interface SwarmsInput {
  seed: string;
  product: string;
  buyer_count: number;
  seller_count: number;
  quantity_per_buyer: number;
  max_unit_price: string;
  currency: Currency;
}

export interface SwarmsEvidence {
  round: {
    round_id: string;
    seed: string;
    product: string;
    currency: Currency;
    total_quantity: number;
    buyer_count: number;
    seller_count: number;
    max_unit_price: string;
  };
  buyers: Array<{
    account: string;
    quantity: number;
    budget: string;
    share: string;
  }>;
  commitments: Array<{
    seller: string;
    commitment: string;
  }>;
  revealed_bids: Array<{
    seller: string;
    price: string;
    capacity: number;
    nonce: string;
    commitment: string;
    commitment_verified: boolean;
  }>;
  winner: {
    seller: string;
    unit_price: string;
    capacity: number;
    total_cost: string;
    selection_rule: string;
  };
  settlement: {
    mode: "local-simulation";
    escrow: "none";
    authoritative: false;
    note: string;
  };
}

const DEFAULTS: SwarmsInput = {
  seed: "ash-swarms-2026",
  product: "H100 GPU hour",
  buyer_count: 20,
  seller_count: 5,
  quantity_per_buyer: 1,
  max_unit_price: "2.50",
  currency: "USDC",
};

function generatedPrice(max: Minor, random: () => number): Minor {
  const weight = 400_000 + Math.floor(random() * 550_000);
  const price = (max * BigInt(weight)) / 1_000_000n;
  return price > 0n ? price : 1n;
}

function generatedBudget(max: Minor, random: () => number): Minor {
  const weight = 1_050_000 + Math.floor(random() * 450_000);
  return (max * BigInt(weight)) / 1_000_000n;
}

export function runSwarms(overrides: Partial<SwarmsInput> = {}): TrackRun<SwarmsEvidence> {
  const input: SwarmsInput = { ...DEFAULTS, ...overrides };
  const seed = assertText(input.seed, "Round seed", 120);
  const product = assertText(input.product, "GPU product", 160);
  const buyerCount = parseCount(input.buyer_count, "Buyer count", { min: 1, max: 1_000 });
  const sellerCount = parseCount(input.seller_count, "Seller count", { min: 1, max: 1_000 });
  const quantityPerBuyer = parseCount(input.quantity_per_buyer, "Quantity per buyer", { min: 1, max: 100 });
  const totalQuantity = buyerCount * quantityPerBuyer;
  const maxUnitPrice = parsePositiveMoney(input.max_unit_price, "Maximum unit price", input.currency);
  const random = seededRandom(seed);

  const buyers = Array.from({ length: buyerCount }, (_, index) => ({
    account: `buyer-${String(index + 1).padStart(3, "0")}.testnet`,
    quantity: quantityPerBuyer,
    budget: generatedBudget(maxUnitPrice, random),
  }));
  const poolBudget = buyers.reduce((sum, buyer) => sum + buyer.budget, 0n);

  const sellers = Array.from({ length: sellerCount }, (_, index) => {
    const seller = `seller-${String(index + 1).padStart(3, "0")}.testnet`;
    const price = generatedPrice(maxUnitPrice, random);
    const generatedCapacity = Math.max(quantityPerBuyer, Math.ceil(totalQuantity * (0.5 + random() * 0.8)));
    const capacity = index === sellerCount - 1 ? Math.max(totalQuantity, generatedCapacity) : generatedCapacity;
    const nonce = sha256Text(`${seed}:${seller}:nonce`).slice(0, 24);
    const commitment = sha256Text(`${seed}|${seller}|${price.toString()}|${capacity}|${nonce}`);
    return { seller, price, capacity, nonce, commitment };
  });

  const eligible = sellers
    .filter((seller) => seller.price <= maxUnitPrice && seller.capacity >= totalQuantity)
    .sort((a, b) => {
      if (a.price === b.price) return a.seller.localeCompare(b.seller);
      return a.price < b.price ? -1 : 1;
    });
  const winner = eligible[0];
  if (!winner) {
    throw new AshError(
      "NOT_IMPLEMENTED",
      "No seller can satisfy the full group-buy quantity within the maximum unit price.",
      { hint: "Increase seller count, quantity capacity or the maximum unit price." },
    );
  }
  const totalCost = winner.price * BigInt(totalQuantity);
  if (totalCost > poolBudget) {
    throw new AshError("BUDGET_EXCEEDED", "The winning bid exceeds the pooled buyer budget.");
  }

  const weights = equalWeights(buyerCount);
  const shares = allocateMinor(
    totalCost,
    buyers.map((buyer, index) => ({ label: buyer.account, weight: weights[index] ?? 0 })),
  );
  const allocated = shares.reduce((sum, share) => sum + share.amount, 0n);
  const shareByAccount = new Map(shares.map((share) => [share.label, share.amount]));

  const evidence: SwarmsEvidence = {
    round: {
      round_id: `round_${sha256Text(`${seed}:${product}:${totalQuantity}`).slice(0, 12)}`,
      seed,
      product,
      currency: input.currency,
      total_quantity: totalQuantity,
      buyer_count: buyerCount,
      seller_count: sellerCount,
      max_unit_price: formatAmount(maxUnitPrice, input.currency),
    },
    buyers: buyers.map((buyer) => ({
      account: buyer.account,
      quantity: buyer.quantity,
      budget: formatAmount(buyer.budget, input.currency),
      share: formatAmount(shareByAccount.get(buyer.account) ?? 0n, input.currency),
    })),
    commitments: sellers.map(({ seller, commitment }) => ({ seller, commitment })),
    revealed_bids: sellers.map((seller) => ({
      seller: seller.seller,
      price: formatAmount(seller.price, input.currency),
      capacity: seller.capacity,
      nonce: seller.nonce,
      commitment: seller.commitment,
      commitment_verified:
        sha256Text(`${seed}|${seller.seller}|${seller.price.toString()}|${seller.capacity}|${seller.nonce}`) ===
        seller.commitment,
    })),
    winner: {
      seller: winner.seller,
      unit_price: formatAmount(winner.price, input.currency),
      capacity: winner.capacity,
      total_cost: formatAmount(totalCost, input.currency),
      selection_rule: "lowest valid revealed price; ties break by seller account; capacity must cover the full pool",
    },
    settlement: {
      mode: "local-simulation",
      escrow: "none",
      authoritative: false,
      note: "Buyer shares and the winning bid are simulated. No NEAR Intents quote, escrow, signature or on-chain settlement exists.",
    },
  };

  const checks = [
    {
      id: "commitments-verified",
      passed: evidence.revealed_bids.every((bid) => bid.commitment_verified),
      detail: `${evidence.revealed_bids.length} sealed-bid commitment(s) were verified after reveal.`,
    },
    {
      id: "winner-valid",
      passed: winner.price <= maxUnitPrice && winner.capacity >= totalQuantity,
      detail: `${winner.seller} covers ${totalQuantity} unit(s) at ${formatAmount(winner.price, input.currency)}.`,
    },
    {
      id: "allocation-total",
      passed: allocated === totalCost,
      detail: `${formatAmount(allocated, input.currency)} allocated across ${buyers.length} buyer(s).`,
    },
    {
      id: "pool-budget",
      passed: totalCost <= poolBudget,
      detail: `${formatAmount(poolBudget, input.currency)} pooled against a ${formatAmount(totalCost, input.currency)} winning cost.`,
    },
    {
      id: "simulation-only",
      passed: evidence.settlement.authoritative === false,
      detail: "No custody, escrow or provider settlement is claimed.",
    },
  ];

  return finalizeTrackRun<SwarmsEvidence>({
    track_id: "swarms",
    title: "Sealed-bid group purchase",
    summary: `${buyerCount} buyers pooled ${totalQuantity} ${product} unit(s); ${winner.seller} won with a verified sealed bid of ${formatAmount(winner.price, input.currency)}.`,
    integrationNote:
      "The round is deterministic and replayed from a seed. It uses no LLM calls, custody, NEAR accounts or provider settlement.",
    checks,
    evidence,
  });
}
