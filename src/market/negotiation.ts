import { AshError } from "../errors.js";
import type { Currency, Minor } from "../util/money.js";
import { formatMinor, parseAmount } from "../util/money.js";
import { nowIso } from "../util/time.js";
import { sleep } from "../util/async.js";
import { logger } from "../logger.js";
import type { NegotiationEntry } from "../domain/types.js";
import type { JobBid, MarketAdapter } from "./types.js";

export interface NegotiationResult {
  accepted: boolean;
  bid: JobBid;
  status: "within_budget" | "counter_accepted" | "counter_rejected" | "walked_away" | "capability_missing";
  log: NegotiationEntry[];
  note: string;
}

/**
 * One counter-offer per vendor per subtask, never above the planned maximum.
 * The market's direct-hire price is fixed, so counter-offers are only possible
 * on a posted job's bid thread. A missing capability means walk away, not
 * invent an offer.
 */
export class NegotiationEngine {
  private readonly adapter: MarketAdapter;
  private readonly subtaskId: string;
  private readonly currency: Currency;
  private readonly plannedMax: Minor;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly sent = new Set<string>();

  constructor(options: {
    adapter: MarketAdapter;
    subtaskId: string;
    currency: Currency;
    plannedMax: Minor;
    timeoutMs?: number;
    pollMs?: number;
  }) {
    this.adapter = options.adapter;
    this.subtaskId = options.subtaskId;
    this.currency = options.currency;
    this.plannedMax = options.plannedMax;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pollMs = options.pollMs ?? 3_000;
  }

  async negotiateBid(jobId: string, bid: JobBid, priorLog: NegotiationEntry[] = []): Promise<NegotiationResult> {
    if (bid.currency !== this.currency)
      throw new AshError("MARKET_PROTOCOL_ERROR", "Bid currency differs from the approved currency.");
    const amount = parseAmount(bid.amount, this.currency);
    if (amount <= this.plannedMax) {
      return { accepted: true, bid, status: "within_budget", log: [], note: "Bid is within the planned maximum." };
    }

    const vendorKey = bid.bidder.id ?? bid.bidder.handle ?? bid.bidder.name ?? bid.bid_id;
    const alreadySent =
      this.sent.has(`${jobId}:${vendorKey}`) ||
      priorLog.some(
        (entry) =>
          entry.direction === "COUNTER_OFFER" &&
          ((bid.bidder.id !== null && entry.vendor_id === bid.bidder.id) ||
            (bid.bidder.name !== null && entry.vendor_name === bid.bidder.name) ||
            (bid.bidder.handle !== null && entry.vendor_name === bid.bidder.handle)),
      );
    if (alreadySent) {
      return {
        accepted: false,
        bid,
        status: "walked_away",
        log: [],
        note: "A counter-offer was already sent to this vendor for this subtask. Ash does not repeat it.",
      };
    }

    if (!this.adapter.capabilities().can_message) {
      return {
        accepted: false,
        bid,
        status: "capability_missing",
        log: [],
        note: "This marketplace connection has no bid-message tool, so Ash cannot counter-offer.",
      };
    }

    const offered = formatMinor(this.plannedMax, this.currency);
    const note = `Counter-offer ${offered} ${this.currency} against quote ${bid.amount} ${this.currency}. The quote exceeds the approved subtask maximum of ${offered} ${this.currency}; this is a single counter-offer.`;
    this.sent.add(`${jobId}:${vendorKey}`);
    const entry: NegotiationEntry = {
      at: nowIso(),
      direction: "COUNTER_OFFER",
      vendor_id: bid.bidder.id,
      vendor_name: bid.bidder.name ?? bid.bidder.handle,
      amount: offered,
      currency: this.currency,
      reason: note,
    };
    try {
      await this.adapter.messageWorker({
        job_id: jobId,
        bid_id: bid.bid_id,
        body: `${note}\n\nIf this does not fit, no hard feelings — Ash will walk away.`,
      });
    } catch (error) {
      await logger.audit("negotiation.send_failed", {
        job_id: jobId,
        bid_id: bid.bid_id,
        error: (error as Error).message,
      });
      return {
        accepted: false,
        bid,
        status: "walked_away",
        log: [entry],
        note: `Could not send the counter-offer: ${(error as Error).message}`,
      };
    }
    await logger.audit("negotiation.counter_offer", {
      job_id: jobId,
      bid_id: bid.bid_id,
      vendor: bid.bidder.name,
      offered,
      currency: this.currency,
    });

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollMs);
      let bids: JobBid[];
      try {
        bids = await this.adapter.listBids(jobId);
      } catch {
        continue;
      }
      const updated = bids.find((candidate) => candidate.bid_id === bid.bid_id);
      if (!updated) continue;
      if (updated.currency !== this.currency)
        throw new AshError("MARKET_PROTOCOL_ERROR", "Bid currency changed during negotiation.");
      const updatedAmount = parseAmount(updated.amount, this.currency);
      if (updatedAmount <= this.plannedMax && updated.status !== "rejected" && updated.status !== "withdrawn") {
        const reply: NegotiationEntry = {
          at: nowIso(),
          direction: "VENDOR_REPLY",
          vendor_id: bid.bidder.id,
          vendor_name: bid.bidder.name,
          amount: updated.amount,
          currency: this.currency,
          reason: "Vendor accepted the counter-offer.",
        };
        return {
          accepted: true,
          bid: updated,
          status: "counter_accepted",
          log: [entry, reply],
          note: "Counter-offer accepted.",
        };
      }
      if (updated.status === "rejected" || updated.status === "withdrawn") {
        return {
          accepted: false,
          bid: updated,
          status: "counter_rejected",
          log: [entry],
          note: `Vendor ${updated.status} the counter-offer.`,
        };
      }
    }

    return {
      accepted: false,
      bid,
      status: "walked_away",
      log: [entry],
      note: "No response to the single counter-offer before the deadline. Walking away.",
    };
  }
}
