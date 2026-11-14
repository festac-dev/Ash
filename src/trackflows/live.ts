import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { AshError } from "../errors.js";
import { allocateMinor, assertText, percentWeight, sha256Text } from "../journey/core.js";
import { MainnetClient, TransferProofSchema } from "../providers/mainnet.js";
import { MainnetService } from "../server/mainnet-service.js";
import { atomicWriteJson, ensurePrivateDir, readJsonIfExists, withFileLock } from "../util/fs.js";
import { hashJson } from "../util/json.js";
import { ID_SCHEMA } from "../domain/schemas.js";
import { TaskStore } from "../state/store.js";

const account = TransferProofSchema.shape.recipient_account;
const amount = TransferProofSchema.shape.amount_atomic;
const reference = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const ObligationSchema = z
  .object({
    reference,
    agent_account: account,
    token_account: account,
    task_id: ID_SCHEMA,
    amount_atomic: amount,
    status: z.enum(["RESERVED", "RELEASED"]),
  })
  .strict();
const RevenueStateSchema = z.object({
  reference,
  input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  treasury_account: account,
  token_account: account,
  payouts: z.array(z.object({ recipient_account: account, amount_atomic: z.string().regex(/^(0|[1-9]\d*)$/) })),
  total_atomic: amount,
  status: z.enum(["AWAITING_WALLET_APPROVAL", "PAID"]),
  transfers: z.array(TransferProofSchema),
});
const InvoiceSchema = z
  .object({
    reference,
    client: z.string().trim().min(1).max(120),
    recipient_account: account,
    token_account: account,
    amount_atomic: amount,
  })
  .strict();
type Invoice = z.infer<typeof InvoiceSchema> & {
  network: "mainnet";
  status: "UNPAID" | "PAID";
  tx_hash: string | null;
};
const StoredInvoiceSchema = InvoiceSchema.extend({
  network: z.literal("mainnet"),
  status: z.enum(["UNPAID", "PAID"]),
  tx_hash: TransferProofSchema.shape.tx_hash.nullable(),
}).refine((invoice) => (invoice.status === "PAID") === (invoice.tx_hash !== null));
const SwarmAllocationSchema = z
  .object({
    reference,
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    funding_references: z.array(reference).min(1),
    pool_account: account,
    token_account: account,
    cost_atomic: amount,
    winner: account,
    quantity: z.number().int().positive(),
    funded_atomic: amount,
    remainder_atomic: z.string().regex(/^(0|[1-9]\d*)$/),
    status: z.enum(["AWAITING_WALLET_APPROVAL", "PAID"]),
    transfer: TransferProofSchema.nullable(),
  })
  .refine((round) => (round.status === "PAID") === (round.transfer !== null));
type SwarmAllocation = z.infer<typeof SwarmAllocationSchema>;

function parseRecords<T>(schema: z.ZodType<T>, data: unknown, label: string): T[] {
  const parsed = z.array(schema).safeParse(data);
  if (!parsed.success) throw new AshError("STATE_INVALID", `${label} store is invalid.`);
  const identities = new Set<string>();
  for (const row of parsed.data) {
    const value = Reflect.get(Object(row), "reference") ?? Reflect.get(Object(row), "id");
    if (value === undefined) continue;
    if (identities.has(value)) throw new AshError("STATE_INVALID", `${label} store contains duplicate records.`);
    identities.add(value);
  }
  return parsed.data;
}

export class LiveTracks {
  readonly payments: MainnetService;
  constructor(
    private readonly config: AppConfig,
    client?: MainnetClient,
  ) {
    this.payments = new MainnetService(config, client);
  }

  private async live(): Promise<void> {
    if (this.config.simulation) throw new AshError("UNSAFE_OPERATION", "Live workstreams do not run in demo mode.");
    await this.payments.initialize();
  }

  private async obligations() {
    return parseRecords(
      ObligationSchema,
      (await readJsonIfExists<unknown>(path.join(this.config.dataDir, "mainnet", "obligations.json"))) ?? [],
      "Obligation",
    );
  }

  async reserveObligation(input: unknown) {
    await this.live();
    const request = ObligationSchema.omit({ status: true }).parse(input);
    const file = path.join(this.config.dataDir, "mainnet", "obligations.json");
    return withFileLock(path.join(this.config.dataDir, "mainnet", "spending.json.lock"), async () => {
      const rows = await this.obligations();
      const existing = rows.find((row) => row.reference === request.reference);
      if (existing) {
        const { status: _status, ...terms } = existing;
        if (hashJson(terms) !== hashJson(request))
          throw new AshError("CONFLICT", "Obligation reference has different terms.");
        return { ...existing, replayed: true };
      }
      const task = await new TaskStore(this.config).load(request.task_id);
      if (["cancelled", "completed", "failed"].includes(task.status))
        throw new AshError("UNSAFE_OPERATION", "Closed tasks cannot reserve new earnings obligations.");
      const balance = await this.agentBalance({
        agent_account: request.agent_account,
        token_account: request.token_account,
        spending_limit_atomic: request.amount_atomic,
      });
      if (BigInt(balance.spendable_atomic) < BigInt(request.amount_atomic))
        throw new AshError("BUDGET_EXCEEDED", "Verified earnings cannot cover this outstanding obligation.");
      const obligation = { ...request, status: "RESERVED" as const };
      rows.push(obligation);
      await atomicWriteJson(file, rows);
      return { ...obligation, replayed: false };
    });
  }

  async releaseObligation(input: unknown) {
    await this.live();
    const request = z.object({ reference }).strict().parse(input);
    return withFileLock(path.join(this.config.dataDir, "mainnet", "spending.json.lock"), async () => {
      const rows = await this.obligations();
      const row = rows.find((item) => item.reference === request.reference);
      if (!row) throw new AshError("NOT_FOUND", "Obligation was not found.");
      row.status = "RELEASED";
      await atomicWriteJson(path.join(this.config.dataDir, "mainnet", "obligations.json"), rows);
      return row;
    });
  }

  private async invoices<T>(work: (rows: Invoice[]) => Promise<T>): Promise<T> {
    await this.live();
    const file = path.join(this.config.dataDir, "mainnet", "invoices.json");
    await ensurePrivateDir(path.dirname(file));
    return withFileLock(`${file}.lock`, async () => {
      const data = (await readJsonIfExists<unknown>(file)) ?? [];
      const rows = parseRecords(StoredInvoiceSchema, data, "Mainnet invoice");
      const result = await work(rows);
      await atomicWriteJson(file, rows);
      return result;
    });
  }

  async createInvoice(input: unknown): Promise<Invoice> {
    await this.live();
    const parsed = InvoiceSchema.safeParse(input);
    if (!parsed.success)
      throw new AshError(
        "VALIDATION_FAILED",
        "Invoice requires a reference, client, recipient, token contract and atomic amount.",
      );
    assertText(parsed.data.client, "Invoice client", 120);
    await this.payments.client.account(parsed.data.recipient_account);
    const tokens = await this.payments.client.tokens();
    if (
      !tokens.some(
        (token) =>
          token.blockchain === "near" &&
          (token.contractAddress === parsed.data.token_account ||
            token.assetId === `nep141:${parsed.data.token_account}`),
      )
    )
      throw new AshError("VALIDATION_FAILED", "Invoice token is not in the live supported NEAR asset catalogue.");
    return this.invoices(async (rows) => {
      const existing = rows.find((row) => row.reference === parsed.data.reference);
      if (existing) {
        const { network: _network, status: _status, tx_hash: _hash, ...terms } = existing;
        if (hashJson(terms) !== hashJson(parsed.data))
          throw new AshError("CONFLICT", "Invoice reference already has different payment terms.");
        return existing;
      }
      const invoice: Invoice = { ...parsed.data, network: "mainnet", status: "UNPAID", tx_hash: null };
      rows.push(invoice);
      return invoice;
    });
  }

  async settleInvoice(input: unknown): Promise<Invoice> {
    await this.live();
    const parsed = z.object({ reference, transfer: TransferProofSchema }).strict().safeParse(input);
    if (!parsed.success) throw new AshError("VALIDATION_FAILED", "Provide invoice reference and transfer proof.");
    // Fetch first, then lock the local records; provider latency cannot hold the store lock.
    const rows = parseRecords(
      StoredInvoiceSchema,
      (await readJsonIfExists<unknown>(path.join(this.config.dataDir, "mainnet", "invoices.json"))) ?? [],
      "Mainnet invoice",
    );
    const invoice = rows.find((row) => row.reference === parsed.data.reference);
    if (!invoice) throw new AshError("NOT_FOUND", "Invoice was not found.");
    for (const key of ["recipient_account", "token_account", "amount_atomic"] as const)
      if (invoice[key] !== parsed.data.transfer[key])
        throw new AshError("VERIFICATION_FAILED", "Transfer does not match the invoice terms.");
    const verified = await this.payments.verifyPayment({
      purpose: "invoice",
      reference: invoice.reference,
      transfer: parsed.data.transfer,
    });
    return this.invoices(async (current) => {
      const record = current.find((row) => row.reference === invoice.reference);
      if (!record || hashJson({ ...record, status: invoice.status, tx_hash: invoice.tx_hash }) !== hashJson(invoice))
        throw new AshError("CONFLICT", "Invoice terms changed during payment verification.");
      record.status = "PAID";
      record.tx_hash = verified.verification.expected.tx_hash;
      return record;
    });
  }

  async revenueAllocation(input: unknown) {
    await this.live();
    const parsed = z
      .object({
        sale_reference: reference,
        treasury_account: account,
        split: z
          .array(z.object({ account, percent: z.number().min(0).max(100) }).strict())
          .min(1)
          .max(20),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success)
      throw new AshError("VALIDATION_FAILED", "Provide a sale reference, treasury and percentage split.");
    const sale = (await this.payments.payments()).find(
      (payment) => payment.purpose === "sale" && payment.reference === parsed.data.sale_reference,
    );
    if (!sale || sale.verification.expected.recipient_account !== parsed.data.treasury_account)
      throw new AshError("APPROVAL_REQUIRED", "Revenue allocation requires a verified sale paid to this treasury.");
    await this.payments.verifyPayment({
      purpose: sale.purpose,
      reference: sale.reference,
      transfer: sale.verification.expected,
    });
    const seen = new Set<string>();
    const payouts = allocateMinor(
      BigInt(sale.verification.expected.amount_atomic),
      parsed.data.split.map((part) => {
        if (seen.has(part.account))
          throw new AshError("VALIDATION_FAILED", "Revenue split recipients must be distinct.");
        seen.add(part.account);
        return { label: part.account, weight: percentWeight(part.percent, "Revenue share") };
      }),
    );
    const file = path.join(this.config.dataDir, "mainnet", "revenue-allocations.json");
    return withFileLock(`${file}.lock`, async () => {
      const rows = parseRecords(
        RevenueStateSchema,
        (await readJsonIfExists<unknown>(file)) ?? [],
        "Revenue allocation",
      );
      let state = rows.find((row) => row.reference === sale.reference);
      if (state && state.input_hash !== hashJson(parsed.data))
        throw new AshError("CONFLICT", "This sale already has a different revenue allocation.");
      if (!state) {
        state = {
          reference: sale.reference,
          input_hash: hashJson(parsed.data),
          treasury_account: parsed.data.treasury_account,
          token_account: sale.verification.expected.token_account,
          payouts: payouts.map((line) => ({ recipient_account: line.label, amount_atomic: line.amount.toString() })),
          total_atomic: sale.verification.expected.amount_atomic,
          status: "AWAITING_WALLET_APPROVAL",
          transfers: [],
        };
        rows.push(state);
        await atomicWriteJson(file, rows);
      }
      return {
        network: "mainnet",
        sale_reference: state.reference,
        status: state.status,
        sale_verified: true,
        token_account: state.token_account,
        payouts: state.payouts,
        total_atomic: state.total_atomic,
        paid: state.status === "PAID",
      };
    });
  }

  async settleRevenue(input: unknown) {
    await this.live();
    const request = z
      .object({ sale_reference: reference, transfers: z.array(TransferProofSchema).min(1).max(20) })
      .strict()
      .parse(input);
    const file = path.join(this.config.dataDir, "mainnet", "revenue-allocations.json");
    const rows = parseRecords(RevenueStateSchema, (await readJsonIfExists<unknown>(file)) ?? [], "Revenue allocation");
    const state = rows.find((row) => row.reference === request.sale_reference);
    if (!state) throw new AshError("NOT_FOUND", "Revenue allocation was not found.");
    const payouts = state.payouts.filter((payout) => BigInt(payout.amount_atomic) > 0n);
    if (
      request.transfers.length !== payouts.length ||
      new Set(request.transfers.map((transfer) => transfer.recipient_account)).size !== payouts.length
    )
      throw new AshError("VERIFICATION_FAILED", "Each allocated recipient requires one exact payout proof.");
    for (const payout of payouts) {
      const transfer = request.transfers.find((transfer) => transfer.recipient_account === payout.recipient_account)!;
      if (
        !transfer ||
        transfer.sender_account !== state.treasury_account ||
        transfer.token_account !== state.token_account ||
        transfer.amount_atomic !== payout.amount_atomic
      )
        throw new AshError("VERIFICATION_FAILED", "Revenue payout differs from the verified sale allocation.");
      await this.payments.verifyPayment({
        purpose: "revenue-share",
        reference: `revenue:${hashJson(state.reference).slice(0, 16)}:${payout.recipient_account}`,
        transfer,
      });
    }
    return withFileLock(`${file}.lock`, async () => {
      const current = parseRecords(
        RevenueStateSchema,
        (await readJsonIfExists<unknown>(file)) ?? [],
        "Revenue allocation",
      );
      const row = current.find((row) => row.reference === state.reference);
      if (!row || row.input_hash !== state.input_hash)
        throw new AshError("CONFLICT", "Revenue allocation changed during verification.");
      row.status = "PAID";
      row.transfers = request.transfers;
      await atomicWriteJson(file, current);
      return {
        network: "mainnet",
        sale_reference: row.reference,
        status: row.status,
        paid: true,
        transfers: row.transfers,
      };
    });
  }

  async agentBalance(input: unknown) {
    await this.live();
    const parsed = z
      .object({ agent_account: account, token_account: account, spending_limit_atomic: amount })
      .strict()
      .safeParse(input);
    if (!parsed.success)
      throw new AshError("VALIDATION_FAILED", "Provide the agent account, token and spending limit.");
    const actor = parsed.data;
    const balance = await this.payments.client.tokenBalance(actor.token_account, actor.agent_account);
    const receipts = (await this.payments.payments()).filter(
      (payment) => payment.verification.expected.token_account === actor.token_account,
    );
    let earned = 0n,
      spent = 0n;
    for (const payment of receipts) {
      const transfer = payment.verification.expected;
      if (transfer.sender_account === actor.agent_account || transfer.recipient_account === actor.agent_account) {
        await this.payments.verifyPayment({ purpose: payment.purpose, reference: payment.reference, transfer });
        if (transfer.sender_account === actor.agent_account) spent += BigInt(transfer.amount_atomic);
        if (transfer.recipient_account === actor.agent_account) earned += BigInt(transfer.amount_atomic);
      }
    }
    const obligations = (await this.obligations())
      .filter(
        (row) =>
          row.status === "RESERVED" &&
          row.agent_account === actor.agent_account &&
          row.token_account === actor.token_account,
      )
      .reduce((sum, row) => sum + BigInt(row.amount_atomic), 0n);
    const rounds = parseRecords(
      SwarmAllocationSchema,
      (await readJsonIfExists<unknown>(path.join(this.config.dataDir, "mainnet", "swarm-allocations.json"))) ?? [],
      "Swarm allocation",
    );
    const swarmReserved = rounds
      .filter(
        (row) =>
          row.status !== "PAID" &&
          row.pool_account === actor.agent_account &&
          row.token_account === actor.token_account,
      )
      .reduce((sum, row) => sum + BigInt(row.cost_atomic), 0n);
    const signed = z
      .array(
        z.object({
          signer_account: account,
          kind: z.enum(["native", "wrapped-near"]),
          amount_atomic: amount,
          tx_hash: TransferProofSchema.shape.tx_hash,
          status: z.enum(["SIGNED", "UNKNOWN", "FINAL", "BLOCKED"]),
        }),
      )
      .safeParse((await readJsonIfExists<unknown>(path.join(this.config.dataDir, "mainnet", "spending.json"))) ?? []);
    if (!signed.success) throw new AshError("STATE_INVALID", "Mainnet spending store is invalid.");
    const recorded = new Set(receipts.map((row) => row.verification.expected.tx_hash));
    const pending =
      actor.token_account === "wrap.near"
        ? signed.data
            .filter(
              (row) =>
                row.signer_account === actor.agent_account && row.kind === "wrapped-near" && !recorded.has(row.tx_hash),
            )
            .reduce((sum, row) => sum + BigInt(row.amount_atomic), 0n)
        : 0n;
    const net =
      earned > spent + obligations + pending + swarmReserved
        ? earned - spent - obligations - pending - swarmReserved
        : 0n;
    const spendable = [net, BigInt(balance.balance_atomic), BigInt(actor.spending_limit_atomic)].reduce(
      (min, current) => (current < min ? current : min),
    );
    return {
      network: "mainnet",
      ...actor,
      earned_atomic: earned.toString(),
      spent_atomic: spent.toString(),
      obligations_atomic: obligations.toString(),
      swarm_reserved_atomic: swarmReserved.toString(),
      pending_signer_atomic: pending.toString(),
      onchain_balance_atomic: balance.balance_atomic,
      spendable_atomic: spendable.toString(),
      signing_enabled: false,
      note: "Verified earnings minus recorded spending, reserved task/API obligations and unrecorded signer transfers. Earnings-funded signing uses this same bound.",
    };
  }

  async swarmAllocation(input: unknown) {
    await this.live();
    const parsed = z
      .object({
        round_reference: reference,
        pool_account: account,
        token_account: account,
        quantity: z.number().int().min(1).max(10000),
        max_unit_price_atomic: amount,
        funding_references: z.array(reference).min(1).max(100),
        bids: z
          .array(
            z
              .object({
                seller: account,
                unit_price_atomic: amount,
                capacity: z.number().int().min(1).max(10000),
                nonce: z.string().min(16).max(120),
                commitment: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success)
      throw new AshError("VALIDATION_FAILED", "Provide a funded round, contributors and revealed committed bids.");
    const round = parsed.data;
    const file = path.join(this.config.dataDir, "mainnet", "swarm-allocations.json");
    const inputHash = hashJson(round);
    const prior = parseRecords(
      SwarmAllocationSchema,
      (await readJsonIfExists<unknown>(file)) ?? [],
      "Swarm allocation",
    ).find((entry) => entry.reference === round.round_reference);
    if (prior) {
      if (prior.input_hash !== inputHash)
        throw new AshError("CONFLICT", "This round already has a different allocation.");
      if (prior.transfer)
        await this.payments.verifyPayment({
          purpose: "swarm",
          reference: `payout:${prior.reference}`,
          transfer: prior.transfer,
        });
      return this.swarmResult(prior, true);
    }
    if (
      new Set(round.funding_references).size !== round.funding_references.length ||
      new Set(round.bids.map((bid) => bid.seller)).size !== round.bids.length
    )
      throw new AshError("VALIDATION_FAILED", "Funding references and sellers must be distinct.");
    const payments = await this.payments.payments();
    let funding = 0n;
    for (const ref of round.funding_references) {
      const payment = payments.find((entry) => entry.purpose === "swarm" && entry.reference === ref);
      if (
        !payment ||
        payment.verification.expected.recipient_account !== round.pool_account ||
        payment.verification.expected.token_account !== round.token_account
      )
        throw new AshError("APPROVAL_REQUIRED", "Every pool contribution requires matching verified mainnet funding.");
      await this.payments.verifyPayment({
        purpose: payment.purpose,
        reference: ref,
        transfer: payment.verification.expected,
      });
      funding += BigInt(payment.verification.expected.amount_atomic);
    }
    const eligible = round.bids
      .filter((bid) => {
        const committed = sha256Text(
          JSON.stringify([round.round_reference, bid.seller, bid.unit_price_atomic, bid.capacity, bid.nonce]),
        );
        if (committed !== bid.commitment)
          throw new AshError("INTEGRITY_FAILED", "A revealed swarm bid does not match its commitment.");
        return bid.capacity >= round.quantity && BigInt(bid.unit_price_atomic) <= BigInt(round.max_unit_price_atomic);
      })
      .sort((left, right) =>
        BigInt(left.unit_price_atomic) === BigInt(right.unit_price_atomic)
          ? left.seller.localeCompare(right.seller)
          : BigInt(left.unit_price_atomic) < BigInt(right.unit_price_atomic)
            ? -1
            : 1,
      );
    const winner = eligible[0];
    if (!winner) throw new AshError("NOT_FOUND", "No revealed bid meets the quantity and price constraints.");
    const cost = BigInt(winner.unit_price_atomic) * BigInt(round.quantity);
    if (cost > funding) throw new AshError("BUDGET_EXCEEDED", "The verified pool cannot fund the selected bid.");
    const balance = await this.payments.client.tokenBalance(round.token_account, round.pool_account);
    if (BigInt(balance.balance_atomic) < cost)
      throw new AshError("BUDGET_EXCEEDED", "The pool's current on-chain token balance is insufficient.");
    const allocation: SwarmAllocation = {
      reference: round.round_reference,
      input_hash: inputHash,
      funding_references: round.funding_references,
      pool_account: round.pool_account,
      winner: winner.seller,
      token_account: round.token_account,
      quantity: round.quantity,
      cost_atomic: cost.toString(),
      funded_atomic: funding.toString(),
      remainder_atomic: (funding - cost).toString(),
      status: "AWAITING_WALLET_APPROVAL",
      transfer: null,
    };
    await ensurePrivateDir(path.dirname(file));
    return withFileLock(path.join(this.config.dataDir, "mainnet", "spending.json.lock"), () =>
      withFileLock(`${file}.lock`, async () => {
        const stored = parseRecords(
          SwarmAllocationSchema,
          (await readJsonIfExists<unknown>(file)) ?? [],
          "Swarm allocation",
        );
        const previous = stored.find((entry) => entry.reference === round.round_reference);
        if (previous) {
          if (previous.input_hash !== inputHash)
            throw new AshError("CONFLICT", "This round already has a different allocation.");
          return this.swarmResult(previous, true);
        }
        if (stored.some((entry) => entry.funding_references.some((ref) => round.funding_references.includes(ref))))
          throw new AshError("BUDGET_EXCEEDED", "Pool funding is already reserved for another round.");
        const available = await this.agentBalance({
          agent_account: round.pool_account,
          token_account: round.token_account,
          spending_limit_atomic: cost.toString(),
        });
        if (BigInt(available.spendable_atomic) < cost)
          throw new AshError(
            "BUDGET_EXCEEDED",
            "Pool obligations and pending rounds exceed verified available funding.",
          );
        stored.push(allocation);
        await atomicWriteJson(file, stored);
        return this.swarmResult(allocation, false);
      }),
    );
  }

  private swarmResult(round: SwarmAllocation, replayed: boolean) {
    return {
      network: "mainnet",
      round_reference: round.reference,
      winner: round.winner,
      token_account: round.token_account,
      quantity: round.quantity,
      cost_atomic: round.cost_atomic,
      funded_atomic: round.funded_atomic,
      remainder_atomic: round.remainder_atomic,
      status: round.status,
      paid: round.status === "PAID",
      replayed,
      note: "Verified pooled funding and deterministic allocation. Custody stays with the pool owner; no atomic group escrow is claimed.",
    };
  }

  async settleSwarm(input: unknown) {
    await this.live();
    const parsed = z.object({ round_reference: reference, transfer: TransferProofSchema }).strict().safeParse(input);
    if (!parsed.success)
      throw new AshError("VALIDATION_FAILED", "Provide the round reference and exact payout transfer.");
    const file = path.join(this.config.dataDir, "mainnet", "swarm-allocations.json");
    const snapshot = parseRecords(
      SwarmAllocationSchema,
      (await readJsonIfExists<unknown>(file)) ?? [],
      "Swarm allocation",
    );
    const round = snapshot.find((row) => row.reference === parsed.data.round_reference);
    if (!round) throw new AshError("NOT_FOUND", "Swarm allocation was not found.");
    const transfer = parsed.data.transfer;
    if (
      transfer.sender_account !== round.pool_account ||
      transfer.recipient_account !== round.winner ||
      transfer.token_account !== round.token_account ||
      transfer.amount_atomic !== round.cost_atomic
    )
      throw new AshError("VERIFICATION_FAILED", "Transfer does not match the selected swarm payout.");
    await this.payments.verifyPayment({ purpose: "swarm", reference: `payout:${round.reference}`, transfer });
    return withFileLock(`${file}.lock`, async () => {
      const rows = parseRecords(
        SwarmAllocationSchema,
        (await readJsonIfExists<unknown>(file)) ?? [],
        "Swarm allocation",
      );
      const current = rows.find((row) => row.reference === round.reference);
      if (!current || current.input_hash !== round.input_hash)
        throw new AshError("CONFLICT", "Swarm allocation changed during verification.");
      const replayed = current.status === "PAID";
      current.status = "PAID";
      current.transfer = transfer;
      await atomicWriteJson(file, rows);
      return this.swarmResult(current, replayed);
    });
  }

  async settleBounty(input: unknown) {
    await this.live();
    const parsed = z
      .object({
        reference,
        dao_account: account,
        proposal_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        transfer: TransferProofSchema,
      })
      .strict()
      .safeParse(input);
    if (!parsed.success)
      throw new AshError("VALIDATION_FAILED", "Provide a bounty reference, DAO proposal and transfer proof.");
    const request = parsed.data;
    const view = await this.payments.client.daoProposal(request.dao_account, request.proposal_id);
    const proposal = z
      .object({
        status: z.literal("Approved"),
        kind: z.object({
          Transfer: z.object({
            token_id: z.literal(request.transfer.token_account),
            receiver_id: z.literal(request.transfer.recipient_account),
            amount: z.literal(request.transfer.amount_atomic),
          }),
        }),
      })
      .safeParse(view.proposal);
    if (!proposal.success || request.transfer.sender_account !== request.dao_account)
      throw new AshError(
        "APPROVAL_REQUIRED",
        "Bounty payout must match an approved Sputnik token-transfer proposal from this DAO.",
      );
    const payment = await this.payments.verifyPayment(
      {
        purpose: "bounty",
        reference: request.reference,
        transfer: request.transfer,
      },
      { account: request.dao_account, proposal_id: request.proposal_id },
    );
    const event = {
      id: `bounty:${request.dao_account}:${request.proposal_id}`,
      recipient_account: request.transfer.recipient_account,
      points: 1 as const,
      tx_hash: request.transfer.tx_hash,
    };
    const file = path.join(this.config.dataDir, "mainnet", "reputation.json");
    await ensurePrivateDir(path.dirname(file));
    const reputation = await withFileLock(`${file}.lock`, async () => {
      const rows = parseRecords(
        z.object({
          id: z.string().min(1),
          recipient_account: account,
          points: z.literal(1),
          tx_hash: TransferProofSchema.shape.tx_hash,
        }),
        (await readJsonIfExists<unknown>(file)) ?? [],
        "Reputation",
      );
      const existing = rows.find((row) => row.id === event.id);
      if (existing && hashJson(existing) !== hashJson(event))
        throw new AshError("INTEGRITY_FAILED", "This proposal already has a different reputation event.");
      if (!existing) {
        rows.push(event);
        await atomicWriteJson(file, rows);
      }
      return {
        ...event,
        replayed: Boolean(existing),
        total_points: rows
          .filter((row) => row.recipient_account === event.recipient_account)
          .reduce((sum, row) => sum + row.points, 0),
      };
    });
    return {
      network: "mainnet",
      status: "PAID",
      reference: request.reference,
      dao_account: request.dao_account,
      proposal_id: request.proposal_id,
      recipient_account: request.transfer.recipient_account,
      payment,
      reputation_event: reputation,
    };
  }

  async transferPlan(input: unknown) {
    await this.live();
    const parsed = z
      .object({
        sender_account: account,
        recipient_account: account,
        token_account: account,
        amount_atomic: amount,
        spending_limit_atomic: amount,
        allowed_recipients: z.array(account).min(1).max(100),
        killed: z.boolean(),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success) throw new AshError("VALIDATION_FAILED", "Provide exact transfer terms and spending policy.");
    const request = parsed.data;
    if (
      request.killed ||
      !request.allowed_recipients.includes(request.recipient_account) ||
      BigInt(request.amount_atomic) > BigInt(request.spending_limit_atomic)
    )
      throw new AshError("UNSAFE_OPERATION", "Transfer policy blocks this recipient, amount or stopped agent.");
    await this.payments.client.account(request.recipient_account);
    const balance = await this.payments.client.tokenBalance(request.token_account, request.sender_account);
    if (BigInt(balance.balance_atomic) < BigInt(request.amount_atomic))
      throw new AshError("BUDGET_EXCEEDED", "The sender lacks sufficient tokens.");
    const registered = await this.payments.client.tokenStorage(request.token_account, request.recipient_account);
    if (!registered.registered)
      throw new AshError("UNSAFE_OPERATION", "Recipient must register token storage before a transfer is prepared.");
    return {
      network: "mainnet",
      status: "AWAITING_WALLET_APPROVAL",
      signed: false,
      transaction: {
        signerId: request.sender_account,
        receiverId: request.token_account,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "ft_transfer",
              args: { receiver_id: request.recipient_account, amount: request.amount_atomic },
              gas: "30000000000000",
              deposit: "1",
            },
          },
        ],
      },
      note: "Unsigned NEP-141 transfer with one yoctoNEAR deposit and 30 Tgas maximum. Review in your wallet; Ash does not sign or broadcast.",
    };
  }
}

export async function runLiveWorkflow(config: AppConfig, operation: string, input: unknown, client?: MainnetClient) {
  const tracks = new LiveTracks(config, client);
  switch (operation) {
    case "invoice-create":
      return tracks.createInvoice(input);
    case "invoice-settle":
      return tracks.settleInvoice(input);
    case "revenue-allocate":
      return tracks.revenueAllocation(input);
    case "revenue-settle":
      return tracks.settleRevenue(input);
    case "agent-balance":
      return tracks.agentBalance(input);
    case "obligation-reserve":
      return tracks.reserveObligation(input);
    case "obligation-release":
      return tracks.releaseObligation(input);
    case "swarm-allocate":
      return tracks.swarmAllocation(input);
    case "swarm-settle":
      return tracks.settleSwarm(input);
    case "bounty-settle":
      return tracks.settleBounty(input);
    case "transfer-plan":
      return tracks.transferPlan(input);
    default:
      throw new AshError(
        "NOT_FOUND",
        "Unknown live workflow. Available: invoice-create, invoice-settle, revenue-allocate, agent-balance, swarm-allocate, swarm-settle, bounty-settle, transfer-plan.",
      );
  }
}
