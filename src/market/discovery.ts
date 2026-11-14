import type { Currency, Minor } from "../util/money.js";
import { formatMinor, parseAmount } from "../util/money.js";
import type { MarketAgent, WhoAmI } from "./types.js";

export interface CandidateEvaluation {
  agent: MarketAgent;
  score: number;
  price: Minor;
  reasons: string[];
}

export interface DiscoveryResult {
  eligible: CandidateEvaluation[];
  rejected: Array<{ agent: MarketAgent; reason: string }>;
}

const SUSPICIOUS_DESCRIPTION =
  /\b(guaranteed|no questions|seed phrase|private key|wallet drain|guaranteed profit|risk[- ]free|send funds|pay upfront)\b/i;

export function discoverCandidates(
  agents: MarketAgent[],
  options: { currency: Currency; plannedMax: Minor; preferredAgents?: string[]; queryTerms?: string[] },
): DiscoveryResult {
  const terms = (options.queryTerms ?? [])
    .flatMap((term) => term.toLowerCase().split(/[^a-z0-9]+/))
    .filter((term) => term.length > 2);
  const preferred = new Set((options.preferredAgents ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
  const eligible: CandidateEvaluation[] = [];
  const rejected: Array<{ agent: MarketAgent; reason: string }> = [];

  for (const agent of agents) {
    const reject = (reason: string): void => {
      rejected.push({ agent, reason });
    };
    if (agent.price === null) {
      reject("no live price");
      continue;
    }
    let price: Minor;
    try {
      price = parseAmount(agent.price, options.currency);
    } catch {
      reject("invalid price");
      continue;
    }
    if (price <= 0n) {
      reject("non-positive price");
      continue;
    }
    if (price > options.plannedMax) {
      reject(
        `price ${formatMinor(price, options.currency)} exceeds the subtask maximum ${formatMinor(options.plannedMax, options.currency)}`,
      );
      continue;
    }
    if (!agent.payable_with || agent.payable_with.length === 0) {
      reject("no payable currency rail");
      continue;
    }
    if (!agent.payable_with.includes(options.currency)) {
      reject(`does not accept ${options.currency}`);
      continue;
    }
    if (agent.accepting_work === false) {
      reject("not accepting work");
      continue;
    }
    if (SUSPICIOUS_DESCRIPTION.test(`${agent.name} ${agent.description}`)) {
      reject("suspicious vendor claims");
      continue;
    }
    if (agent.success_rate !== null && agent.success_rate < 40) {
      reject(`success rate too low (${agent.success_rate}%)`);
      continue;
    }

    const priceRatio = Number(price) / Math.max(1, Number(options.plannedMax));
    const success = agent.success_rate ?? 55;
    const volume = Math.min(20, Math.log10(agent.delivered_jobs + 1) * 8);
    const response =
      agent.response_time_seconds_median === null ? 0 : Math.max(0, 8 - agent.response_time_seconds_median / 300);
    const isPreferred = [agent.id, agent.handle ?? "", agent.name].some((value) => preferred.has(value.toLowerCase()));
    const haystack = `${agent.name} ${agent.description} ${agent.category ?? ""}`.toLowerCase();
    const relevance = terms.filter((term) => haystack.includes(term)).length;
    const reasons: string[] = [];
    let score = 50 + success * 0.4 + volume + response - priceRatio * 20 + relevance * 12;
    if (isPreferred) {
      score += 25;
      reasons.push("preferred vendor");
    }
    if (agent.delivered_jobs === 0 && agent.success_rate === null) {
      score -= 15;
      reasons.push("no settled track record");
    }
    if (priceRatio < 0.15) {
      score -= 10;
      reasons.push("unusually cheap; verify carefully");
    }
    if (relevance > 0) reasons.push("matches required skills");
    if (agent.delivered_jobs >= 50) reasons.push("established track record");
    if (agent.success_rate !== null && agent.success_rate >= 90) reasons.push("high acceptance rate");
    eligible.push({ agent, score: Math.round(score * 100) / 100, price, reasons });
  }

  eligible.sort((a, b) => b.score - a.score || Number(a.price) - Number(b.price));
  return { eligible, rejected };
}

export function marketFundsFor(whoami: WhoAmI, currency: Currency): Minor | null {
  if (!whoami.account) return null;
  const balances = whoami.account.balances;
  if (currency === "USD") {
    return balances.USD ? parseAmount(balances.USD, "USD") : null;
  }
  const usdc = balances.USDC;
  const credit = whoami.account.credit_usd;
  if (!usdc && !credit) return null;
  return (usdc ? parseAmount(usdc, "USDC") : 0n) + (credit ? parseAmount(credit, "USDC") : 0n);
}
