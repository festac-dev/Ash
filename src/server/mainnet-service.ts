import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { AshError } from "../errors.js";
import { MainnetClient, TransferProofSchema } from "../providers/mainnet.js";
import { atomicWriteJson, ensurePrivateDir, readJsonIfExists, withFileLock } from "../util/fs.js";
import { hashJson, sha256Hex } from "../util/json.js";
import { ApprovalRecordSchema } from "../domain/schemas.js";
import { TaskStore } from "../state/store.js";
import { McpMarketAdapter } from "../market/mcp-adapter.js";
import { TransactionLedger } from "../transactions/ledger.js";

export const PaymentVerificationSchema = z
  .object({
    purpose: z.enum(["invoice", "sale", "hire", "api", "swarm", "bounty", "revenue-share"]),
    reference: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9._:-]+$/),
    transfer: TransferProofSchema,
  })
  .strict();
export type PaymentVerification = z.infer<typeof PaymentVerificationSchema>;
type VerifiedTransfer = Awaited<ReturnType<MainnetClient["verifyTransfer"]>>;
export interface MainnetPayment {
  purpose: PaymentVerification["purpose"];
  reference: string;
  verification: VerifiedTransfer;
  dao_payout?: { account: string; proposal_id: number };
}

const StoredPaymentSchema = PaymentVerificationSchema.omit({ transfer: true }).extend({
  dao_payout: z
    .object({ account: TransferProofSchema.shape.sender_account, proposal_id: z.number().int().nonnegative().safe() })
    .optional(),
  verification: z
    .object({
      network: z.literal("mainnet"),
      status: z.literal("VERIFIED_TRANSFER"),
      finality: z.literal("FINAL"),
      expected: TransferProofSchema,
      events: z
        .array(
          z.object({
            receipt_id: z.string().min(1),
            block_hash: TransferProofSchema.shape.tx_hash,
            log_index: z.number().int().nonnegative(),
            data_index: z.number().int().nonnegative(),
            amount_atomic: TransferProofSchema.shape.amount_atomic,
          }),
        )
        .min(1),
      evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      verified_at: z.string().datetime(),
      note: z.string(),
    })
    .refine(
      (proof) =>
        proof.events.reduce((sum, event) => sum + BigInt(event.amount_atomic), 0n) ===
        BigInt(proof.expected.amount_atomic),
    ),
});

function paymentEvents(proof: VerifiedTransfer): string[] {
  return proof.events.map(
    (event) => `${proof.expected.tx_hash}:${event.receipt_id}:${event.log_index}:${event.data_index}`,
  );
}

function parsePayments(data: unknown): MainnetPayment[] {
  const parsed = z.array(StoredPaymentSchema).safeParse(data);
  if (!parsed.success) throw new AshError("STATE_INVALID", "Mainnet payment store is invalid.");
  const references = new Set<string>();
  const events = new Set<string>();
  for (const payment of parsed.data) {
    const reference = `${payment.purpose}:${payment.reference}`;
    if (references.has(reference))
      throw new AshError("STATE_INVALID", "Mainnet payment store contains duplicate references.");
    references.add(reference);
    for (const event of paymentEvents(payment.verification)) {
      if (events.has(event))
        throw new AshError("STATE_INVALID", "Mainnet payment store contains duplicate transfer events.");
      events.add(event);
    }
  }
  return parsed.data;
}

export class MainnetService {
  readonly client: MainnetClient;
  private initialized: Promise<void> | null = null;
  constructor(
    private readonly config: AppConfig,
    client?: MainnetClient,
  ) {
    this.client = client ?? new MainnetClient(config.near);
  }

  private requireLive(): void {
    if (this.config.simulation)
      throw new AshError(
        "UNSAFE_OPERATION",
        "Mainnet network access is disabled in demo mode. Use live mode for read-only mainnet checks.",
      );
  }

  async initialize(): Promise<void> {
    this.requireLive();
    // Reuse the task store's mode marker rather than opening demo state as mainnet data.
    this.initialized ??= new TaskStore(this.config).init();
    await this.initialized;
  }

  async check(accountId?: string) {
    await this.initialize();
    const status = await this.client.status();
    const tokens = await this.client.tokens();
    const id = accountId || this.config.near.account;
    return {
      status,
      supported_assets: tokens.length,
      assets: tokens,
      near_assets: tokens.filter((token) => token.blockchain === "near"),
      account: id ? await this.client.account(id) : null,
      wallet_configured: Boolean(this.config.near.account),
      signing_enabled: await new (await import("./mainnet-policy.js")).MainnetPolicy(this.config).enabledStatus(),
      funds_spent: "0",
      paid_workflows: "UNVERIFIED",
      note: "This check spends nothing. Paid workflows require final payment evidence; the optional signer is restricted to the operator CLI.",
    };
  }

  async quote(input: unknown) {
    await this.initialize();
    return this.client.dryQuote(input as Parameters<MainnetClient["dryQuote"]>[0]);
  }

  async verifyPayment(
    input: unknown,
    daoPayout?: { account: string; proposal_id: number },
  ): Promise<MainnetPayment & { replayed: boolean }> {
    await this.initialize();
    const parsed = PaymentVerificationSchema.safeParse(input);
    if (!parsed.success)
      throw new AshError("VALIDATION_FAILED", "Provide purpose, reference and an exact mainnet transfer proof.");
    // Re-query the provider even on replay; a local receipt is never the source of finality.
    const verification = await this.client.verifyTransfer(parsed.data.transfer, daoPayout);
    const file = path.join(this.config.dataDir, "mainnet", "payments.json");
    await ensurePrivateDir(path.dirname(file));
    return withFileLock(`${file}.lock`, async () => {
      const stored = parsePayments((await readJsonIfExists<unknown>(file)) ?? []);
      const previous = stored.find(
        (payment) => payment.purpose === parsed.data.purpose && payment.reference === parsed.data.reference,
      );
      if (previous) {
        if (hashJson(previous.verification.expected) !== hashJson(parsed.data.transfer))
          throw new AshError("INTEGRITY_FAILED", "This payment reference is already bound to a different transfer.");
        if (daoPayout) {
          if (previous.dao_payout && hashJson(previous.dao_payout) !== hashJson(daoPayout))
            throw new AshError("INTEGRITY_FAILED", "Payment belongs to a different DAO proposal.");
          if (!previous.dao_payout) {
            previous.dao_payout = daoPayout;
            await atomicWriteJson(file, stored);
          }
        }
        return { ...previous, replayed: true };
      }
      const incoming = new Set(paymentEvents(verification));
      if (stored.some((payment) => paymentEvents(payment.verification).some((key) => incoming.has(key))))
        throw new AshError("INTEGRITY_FAILED", "A transfer event cannot pay a second invoice, hire or bounty.");
      const payment: MainnetPayment = { purpose: parsed.data.purpose, reference: parsed.data.reference, verification };
      if (daoPayout) payment.dao_payout = daoPayout;
      await atomicWriteJson(file, [...stored, payment]);
      return { ...payment, replayed: false };
    });
  }

  /** Inspect finality without assigning events to any invoice/job or writing payment records. */
  async previewPayment(input: unknown) {
    await this.initialize();
    const parsed = z.object({ transfer: TransferProofSchema }).strict().safeParse(input);
    if (!parsed.success) throw new AshError("VALIDATION_FAILED", "Provide an exact mainnet transfer proof.");
    return { verification: await this.client.verifyTransfer(parsed.data.transfer), recorded: false as const };
  }

  async payments() {
    await this.initialize();
    return parsePayments(
      (await readJsonIfExists<unknown>(path.join(this.config.dataDir, "mainnet", "payments.json"))) ?? [],
    );
  }

  async evidence() {
    await this.initialize();
    const payments = await this.payments();
    // Always re-read finality. Static implementation metadata cannot produce a live verdict.
    for (const payment of payments) await this.client.verifyTransfer(payment.verification.expected, payment.dao_payout);
    const evidence = (purposes: PaymentVerification["purpose"][]) =>
      payments
        .filter((row) => purposes.includes(row.purpose))
        .map((row) => ({ reference: row.reference, tx_hash: row.verification.expected.tx_hash, purpose: row.purpose }));
    const signed = z
      .array(
        z.object({
          reference: z.string(),
          signer_account: TransferProofSchema.shape.signer_account,
          recipient_account: TransferProofSchema.shape.recipient_account,
          amount_atomic: TransferProofSchema.shape.amount_atomic,
          tx_hash: TransferProofSchema.shape.tx_hash,
          status: z.string(),
          kind: z.enum(["native", "wrapped-near"]),
          approval_id: z.string().optional(),
          input_hash: z.string(),
          created_at: z.string().datetime(),
          purpose: PaymentVerificationSchema.shape.purpose,
          max_gas_near: z.string().optional(),
          funding_source: z.enum(["operator", "earnings"]).optional(),
          task_id: z.string().optional(),
          task_limit_near: z.string().optional(),
        }),
      )
      .parse((await readJsonIfExists<unknown>(path.join(this.config.dataDir, "mainnet", "spending.json"))) ?? []);
    const authorityData = await readJsonIfExists<unknown>(path.join(this.config.dataDir, "mainnet", "approvals.json"));
    const authorities = authorityData ? ApprovalRecordSchema.parse(authorityData).requests : [];
    const signatures = [];
    for (const row of signed.filter((row) => row.status === "FINAL" && row.kind === "native" && row.approval_id)) {
      const terms = {
        reference: row.reference,
        kind: row.kind,
        recipient_account: row.recipient_account,
        amount_atomic: row.amount_atomic,
        purpose: row.purpose,
        max_gas_near: row.max_gas_near,
        funding_source: row.funding_source,
        task_id: row.task_id,
        task_limit_near: row.task_limit_near,
      };
      const authority = authorities.find((approval) => approval.id === row.approval_id);
      if (
        !authority ||
        authority.kind !== "mainnet_transfer" ||
        !["approved", "expired"].includes(authority.status) ||
        authority.decided_by !== "human" ||
        !authority.decided_at ||
        Date.parse(authority.decided_at) > Date.parse(row.created_at) ||
        Date.parse(authority.expires_at) <= Date.parse(row.created_at) ||
        authority.scope.signer_account !== row.signer_account ||
        authority.scope.transfer_sha256 !== hashJson(terms) ||
        row.input_hash !== hashJson(terms) ||
        authority.scope.max_gas_near !== row.max_gas_near
      )
        throw new AshError("VERIFICATION_FAILED", "Recorded transfer lacks matching historical human authority.");
      const success = z
        .record(z.string(), z.unknown())
        .refine((status) => "SuccessValue" in status || "SuccessReceiptId" in status);
      const tx = z
        .object({
          final_execution_status: z.literal("FINAL"),
          status: z.object({ SuccessValue: z.string() }),
          transaction: z.object({
            hash: z.literal(row.tx_hash),
            signer_id: z.literal(row.signer_account),
            receiver_id: z.literal(row.recipient_account),
            actions: z.array(z.object({ Transfer: z.object({ deposit: z.literal(row.amount_atomic) }) })).length(1),
          }),
          receipts_outcome: z.array(z.object({ outcome: z.object({ status: success }) })).min(1),
        })
        .safeParse(await this.client.transaction(row.tx_hash, row.signer_account));
      if (!tx.success)
        throw new AshError("VERIFICATION_FAILED", "Recorded native transfer is not final with the approved terms.");
      signatures.push({ reference: row.reference, tx_hash: row.tx_hash, approval_id: row.approval_id });
    }
    const definitions = [
      {
        id: "business",
        scope: "Verified sale allocation and its contributor payouts",
        records: evidence(["sale", "revenue-share"]),
        verified: false,
        missing: "Record a verified sale and its contributor payouts.",
      },
      {
        id: "swarms",
        scope: "Pool funding and payout transfers",
        records: evidence(["swarm"]),
        verified: payments.some((row) => row.purpose === "swarm" && row.reference.startsWith("payout:")),
        missing: "Record pool funding, the allocation and the winner's payout.",
      },
      {
        id: "security",
        scope: "Approved native signing and finality",
        records: signatures,
        verified: signatures.length > 0,
        missing: "Verify a final native transfer signed under the current approval policy.",
      },
      {
        id: "agents",
        scope: "Hire/API payment transfers",
        records: evidence(["hire", "api"]),
        verified: false,
        missing: "Complete a marketplace job, review its delivery and verify settlement.",
      },
      {
        id: "realworld",
        scope: "Invoice token settlement",
        records: evidence(["invoice"]),
        verified: payments.some((row) => row.purpose === "invoice"),
        missing: "Settle an Ash invoice with a matching final token transfer.",
      },
      {
        id: "social",
        scope: "DAO bounty payout",
        records: evidence(["bounty"]),
        verified: false,
        missing: "Verify an approved Sputnik proposal's payout and record its reputation event.",
      },
    ];
    // Only workflow-created state can complete settlement evidence, never an arbitrary purpose label.
    const invoiceRows = z
      .array(
        z.object({
          reference: z.string(),
          status: z.enum(["UNPAID", "PAID"]),
          tx_hash: z.string().nullable(),
          recipient_account: z.string(),
          token_account: z.string(),
          amount_atomic: z.string(),
        }),
      )
      .parse((await readJsonIfExists<unknown>(path.join(this.config.dataDir, "mainnet", "invoices.json"))) ?? []);
    definitions.find((row) => row.id === "realworld")!.verified = invoiceRows.some(
      (invoice) =>
        invoice.status === "PAID" &&
        payments.some(
          (payment) =>
            payment.purpose === "invoice" &&
            payment.reference === invoice.reference &&
            payment.verification.expected.tx_hash === invoice.tx_hash &&
            ["recipient_account", "token_account", "amount_atomic"].every(
              (key) => Reflect.get(invoice, key) === Reflect.get(payment.verification.expected, key),
            ),
        ),
    );
    const rounds = z
      .array(
        z.object({
          reference: z.string(),
          status: z.enum(["AWAITING_WALLET_APPROVAL", "PAID"]),
          pool_account: TransferProofSchema.shape.sender_account,
          token_account: TransferProofSchema.shape.token_account,
          winner: TransferProofSchema.shape.recipient_account,
          cost_atomic: TransferProofSchema.shape.amount_atomic,
          funded_atomic: TransferProofSchema.shape.amount_atomic,
          funding_references: z.array(z.string()).min(1),
          transfer: TransferProofSchema.nullable(),
        }),
      )
      .parse(
        (await readJsonIfExists<unknown>(path.join(this.config.dataDir, "mainnet", "swarm-allocations.json"))) ?? [],
      );
    definitions.find((row) => row.id === "swarms")!.verified = rounds.some(
      (round) =>
        round.status === "PAID" &&
        round.transfer &&
        round.transfer.sender_account === round.pool_account &&
        round.transfer.recipient_account === round.winner &&
        round.transfer.token_account === round.token_account &&
        round.transfer.amount_atomic === round.cost_atomic &&
        BigInt(round.cost_atomic) <= BigInt(round.funded_atomic) &&
        new Set(round.funding_references).size === round.funding_references.length &&
        round.funding_references.every((ref) =>
          payments.some(
            (payment) =>
              payment.purpose === "swarm" &&
              payment.reference === ref &&
              payment.verification.expected.recipient_account === round.pool_account &&
              payment.verification.expected.token_account === round.token_account,
          ),
        ) &&
        round.funding_references.reduce(
          (sum, ref) =>
            sum +
            BigInt(
              payments.find((payment) => payment.purpose === "swarm" && payment.reference === ref)!.verification
                .expected.amount_atomic,
            ),
          0n,
        ) === BigInt(round.funded_atomic) &&
        payments.some(
          (payment) =>
            payment.purpose === "swarm" &&
            payment.reference === `payout:${round.reference}` &&
            hashJson(payment.verification.expected) === hashJson(round.transfer),
        ),
    );
    const allocations = z
      .array(
        z.object({
          reference: z.string(),
          treasury_account: TransferProofSchema.shape.sender_account,
          token_account: TransferProofSchema.shape.token_account,
          total_atomic: TransferProofSchema.shape.amount_atomic,
          payouts: z.array(
            z.object({
              recipient_account: TransferProofSchema.shape.recipient_account,
              amount_atomic: z.string().regex(/^(0|[1-9]\d*)$/),
            }),
          ),
          status: z.enum(["AWAITING_WALLET_APPROVAL", "PAID"]),
          transfers: z.array(TransferProofSchema),
        }),
      )
      .parse(
        (await readJsonIfExists<unknown>(path.join(this.config.dataDir, "mainnet", "revenue-allocations.json"))) ?? [],
      );
    definitions.find((row) => row.id === "business")!.verified = allocations.some((allocation) => {
      const sale = payments.find((payment) => payment.purpose === "sale" && payment.reference === allocation.reference);
      const payouts = allocation.payouts.filter((payout) => BigInt(payout.amount_atomic) > 0n);
      return (
        allocation.status === "PAID" &&
        sale &&
        sale.verification.expected.recipient_account === allocation.treasury_account &&
        sale.verification.expected.token_account === allocation.token_account &&
        sale.verification.expected.amount_atomic === allocation.total_atomic &&
        allocation.payouts.reduce((sum, payout) => sum + BigInt(payout.amount_atomic), 0n) ===
          BigInt(allocation.total_atomic) &&
        new Set(payouts.map((payout) => payout.recipient_account)).size === payouts.length &&
        allocation.transfers.length === payouts.length &&
        payouts.every((payout) =>
          allocation.transfers.some(
            (transfer) =>
              transfer.sender_account === allocation.treasury_account &&
              transfer.token_account === allocation.token_account &&
              transfer.recipient_account === payout.recipient_account &&
              transfer.amount_atomic === payout.amount_atomic &&
              payments.some(
                (payment) =>
                  payment.purpose === "revenue-share" &&
                  payment.reference ===
                    `revenue:${hashJson(allocation.reference).slice(0, 16)}:${payout.recipient_account}` &&
                  hashJson(payment.verification.expected) === hashJson(transfer),
              ),
          ),
        )
      );
    });
    const reputations = z
      .array(
        z.object({
          id: z.string(),
          recipient_account: TransferProofSchema.shape.recipient_account,
          tx_hash: TransferProofSchema.shape.tx_hash,
          points: z.literal(1),
        }),
      )
      .parse((await readJsonIfExists<unknown>(path.join(this.config.dataDir, "mainnet", "reputation.json"))) ?? []);
    for (const payment of payments.filter((payment) => payment.purpose === "bounty" && payment.dao_payout)) {
      const dao = payment.dao_payout!;
      const view = await this.client.daoProposal(dao.account, dao.proposal_id);
      const terms = payment.verification.expected;
      const approved = z
        .object({
          status: z.literal("Approved"),
          kind: z.object({
            Transfer: z.object({
              token_id: z.literal(terms.token_account),
              receiver_id: z.literal(terms.recipient_account),
              amount: z.literal(terms.amount_atomic),
            }),
          }),
        })
        .safeParse(view.proposal);
      if (
        approved.success &&
        reputations.some(
          (row) =>
            row.id === `bounty:${dao.account}:${dao.proposal_id}` &&
            row.tx_hash === terms.tx_hash &&
            row.recipient_account === terms.recipient_account,
        )
      )
        definitions.find((row) => row.id === "social")!.verified = true;
    }
    const tasks = await new TaskStore(this.config).list();
    const completed = tasks.flatMap((task) =>
      task.subtasks.flatMap((subtask) =>
        subtask.attempts
          .filter(
            (attempt) =>
              attempt.job_id &&
              attempt.verification?.passed &&
              attempt.delivery?.sha256 &&
              attempt.payment_status === "RELEASED",
          )
          .map((attempt) => ({ task, subtask, attempt })),
      ),
    );
    if (completed.length) {
      const market = new McpMarketAdapter(this.config);
      try {
        const ledger = new TransactionLedger(this.config.dataDir);
        if (!(await ledger.verify()).ok) throw new AshError("INTEGRITY_FAILED", "Task receipt chain is invalid.");
        const receipts = await ledger.list();
        for (const { task, subtask, attempt } of completed.slice(0, 10)) {
          const job = await market.getJobStatus(attempt.job_id!);
          const result = await market.getJobResult(attempt.job_id!, attempt.assignment_id);
          const receipt = receipts.find(
            (receipt) =>
              receipt.task_id === task.id &&
              receipt.subtask_id === subtask.id &&
              receipt.marketplace_job_id === attempt.job_id &&
              receipt.status === "PAID" &&
              receipt.mode === "live",
          );
          if (
            receipt &&
            job.settled &&
            result.status === "delivered" &&
            !result.truncated &&
            result.content &&
            sha256Hex(result.content) === attempt.delivery!.sha256
          ) {
            const row = definitions.find((row) => row.id === "agents")!;
            row.verified = true;
            row.scope = "Marketplace delivery review, settlement and hash-linked task receipt";
          }
        }
      } catch {
        definitions.find((row) => row.id === "agents")!.missing =
          "Marketplace delivery or settlement could not be independently reverified.";
      } finally {
        await market.disconnect();
      }
    }
    return {
      network: "mainnet",
      checked_at: new Date().toISOString(),
      all_six_live_verified: definitions.every((row) => row.verified),
      tracks: definitions.map(({ verified, missing, ...row }) => ({
        ...row,
        implementation_status: "IMPLEMENTED",
        verification_status: verified ? "LIVE_VERIFIED" : "UNVERIFIED",
        missing: verified ? null : missing,
      })),
      note: "These verdicts identify the stated operation only. They do not establish hackathon eligibility or every external integration.",
    };
  }
}
