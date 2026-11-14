import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { KeyPair, KeyType, type KeyPairString } from "@near-js/crypto";
import {
  actionCreators,
  createTransaction,
  encodeTransaction,
  Signature,
  SignedTransaction,
} from "@near-js/transactions";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { AshError } from "../errors.js";
import { MainnetClient, TransferProofSchema } from "../providers/mainnet.js";
import { MainnetService, PaymentVerificationSchema } from "./mainnet-service.js";
import { atomicWriteJson, ensurePrivateDir, readJsonIfExists, withFileLock } from "../util/fs.js";
import { hashJson } from "../util/json.js";
import { registerSecret } from "../util/redact.js";
import { MainnetPolicy, AuthorizedTransferSchema, NearAllowanceSchema, transferTerms } from "./mainnet-policy.js";
import { TaskStore } from "../state/store.js";
import { LiveTracks } from "../trackflows/live.js";

const reference = z
  .string()
  .min(1)
  .max(140)
  .regex(/^[a-zA-Z0-9._:-]+$/);
export const SendMainnetSchema = z
  .object({
    reference,
    kind: z.enum(["native", "wrapped-near"]),
    recipient_account: TransferProofSchema.shape.recipient_account,
    amount_atomic: TransferProofSchema.shape.amount_atomic,
    purpose: PaymentVerificationSchema.shape.purpose.default("revenue-share"),
  })
  .strict();
const recordSchema = SendMainnetSchema.extend({
  approval_id: z.string().optional(),
  max_gas_near: NearAllowanceSchema.optional(),
  funding_source: z.enum(["operator", "earnings"]).optional(),
  task_id: z.string().optional(),
  task_limit_near: NearAllowanceSchema.optional(),
  input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  signer_account: TransferProofSchema.shape.signer_account,
  public_key: z.string().startsWith("ed25519:"),
  nonce: z.string().regex(/^[1-9]\d*$/),
  tx_hash: TransferProofSchema.shape.tx_hash,
  reserved_near_atomic: TransferProofSchema.shape.amount_atomic,
  status: z.enum(["SIGNED", "UNKNOWN", "FINAL", "BLOCKED"]),
  created_at: z.string().datetime(),
  evidence_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  actual_cost_near_atomic: z.string().regex(/^\d+$/).optional(),
});
type SpendRecord = z.infer<typeof recordSchema>;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(value: string): Uint8Array {
  let integer = 0n;
  for (const char of value) integer = integer * 58n + BigInt(ALPHABET.indexOf(char));
  const hex = integer.toString(16);
  const body = integer === 0n ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  const zeros = value.length - value.replace(/^1+/, "").length;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}
function encodeBase58(bytes: Uint8Array): string {
  let integer = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let encoded = "";
  while (integer) {
    encoded = ALPHABET[Number(integer % 58n)] + encoded;
    integer /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded;
}

export function nearToAtomic(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, "0"));
}

/** Only the operator CLI reaches this signer. Models and browser requests cannot submit transactions. */
export class MainnetSigner {
  private readonly service: MainnetService;
  constructor(
    private readonly config: AppConfig,
    client?: MainnetClient,
  ) {
    this.service = new MainnetService(config, client);
  }
  private get file() {
    return path.join(this.config.dataDir, "mainnet", "spending.json");
  }

  private async records(): Promise<SpendRecord[]> {
    const parsed = z.array(recordSchema).safeParse((await readJsonIfExists<unknown>(this.file)) ?? []);
    if (!parsed.success) throw new AshError("STATE_INVALID", "Mainnet spending store is invalid; spending is blocked.");
    if (new Set(parsed.data.map((row) => `${row.signer_account}:${row.reference}`)).size !== parsed.data.length)
      throw new AshError("STATE_INVALID", "Mainnet spending store has duplicate references.");
    const consumed = parsed.data.flatMap((row) => (row.approval_id ? [row.approval_id] : []));
    if (new Set(consumed).size !== consumed.length)
      throw new AshError("STATE_INVALID", "A transfer approval was consumed more than once.");
    return parsed.data;
  }

  async status() {
    await this.service.initialize();
    const rows = await this.records();
    const reserved = rows
      .filter((row) => row.signer_account === this.config.near.account)
      .reduce((sum, row) => sum + BigInt(row.reserved_near_atomic), 0n);
    const limit = nearToAtomic(this.config.near.maxTotalNear);
    return {
      network: "mainnet",
      account: this.config.near.account,
      signing_enabled: await new MainnetPolicy(this.config).enabledStatus(),
      max_total_near: this.config.near.maxTotalNear,
      reserved_near_atomic: reserved.toString(),
      remaining_near_atomic: (limit > reserved ? limit - reserved : 0n).toString(),
      transactions: rows.map(({ public_key: _key, ...row }) => row),
    };
  }

  private async key(): Promise<KeyPair> {
    const { account, signingKeyFile } = this.config.near;
    if (!account || !signingKeyFile)
      throw new AshError("CONFIG_INVALID", "Set ASH_NEAR_ACCOUNT and ASH_NEAR_SIGNING_KEY_FILE locally.");
    let handle;
    try {
      handle = await fs.open(signingKeyFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      throw new AshError(
        "CONFIG_INVALID",
        "Cannot open the local signing key file. It must be a private regular file.",
      );
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
        throw new AshError(
          "UNSAFE_OPERATION",
          "Signing key file must be a regular file of at most 16 KB with permissions 600.",
        );
      const text = await handle.readFile("utf8");
      registerSecret(text);
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new AshError("CONFIG_INVALID", "Signing key file must contain JSON.");
      }
      const parsed = z
        .object({
          account_id: z.literal(account),
          private_key: z
            .string()
            .trim()
            .transform((value) => {
              registerSecret(value);
              return /^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(value) ? `ed25519:${value}` : value;
            })
            .pipe(z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/)),
        })
        .safeParse(data);
      if (!parsed.success)
        throw new AshError(
          "CONFIG_INVALID",
          "Add the ed25519 private_key for the configured account to the local key file; never paste it into chat.",
        );
      registerSecret(parsed.data.private_key);
      const secret = decodeBase58(parsed.data.private_key.slice("ed25519:".length));
      if (secret.length !== 64)
        throw new AshError(
          "CONFIG_INVALID",
          "Signing requires the 64-byte NEAR private key export. A public key cannot sign; adding ed25519: does not change that.",
        );
      try {
        const key = KeyPair.fromString(parsed.data.private_key as KeyPairString);
        if (!Buffer.from(key.getPublicKey().data).equals(Buffer.from(secret.slice(32))))
          throw new AshError("CONFIG_INVALID", "Private key export has inconsistent public-key bytes.");
        return key;
      } catch {
        throw new AshError("CONFIG_INVALID", "Local ed25519 signing key is invalid.");
      }
    } finally {
      await handle.close();
    }
  }

  async send(input: unknown) {
    await this.service.initialize();
    const policy = new MainnetPolicy(this.config);
    await policy.assertEnabled();
    const parsed = AuthorizedTransferSchema.safeParse(input);
    if (!parsed.success)
      throw new AshError(
        "VALIDATION_FAILED",
        "Provide reference, kind, recipient_account and a positive atomic amount.",
      );
    const request = parsed.data;
    const signer = this.config.near.account;
    if (!signer || !this.config.near.allowedRecipients.includes(request.recipient_account))
      throw new AshError(
        "UNSAFE_OPERATION",
        "The account is missing or the recipient is outside ASH_NEAR_ALLOWED_RECIPIENTS.",
      );
    if (BigInt(request.amount_atomic) >= nearToAtomic(this.config.near.maxTotalNear))
      throw new AshError("BUDGET_EXCEEDED", "Transfer amount leaves no room for gas inside the total NEAR cap.");
    if (request.kind === "wrapped-near" && request.recipient_account === signer)
      throw new AshError("VALIDATION_FAILED", "Wrapped NEAR token transfers require a different recipient.");
    await ensurePrivateDir(path.dirname(this.file));
    return withFileLock(
      `${this.file}.lock`,
      async () => {
        const rows = await this.records();
        if (rows.some((row) => row.status === "BLOCKED"))
          throw new AshError(
            "UNSAFE_OPERATION",
            "Spending is blocked because an observed fee exceeded its reservation.",
          );
        const existing = rows.find((row) => row.reference === request.reference && row.signer_account === signer);
        if (existing) {
          const terms = existing.approval_id
            ? transferTerms(request)
            : {
                reference: request.reference,
                kind: request.kind,
                recipient_account: request.recipient_account,
                amount_atomic: request.amount_atomic,
                purpose: request.purpose,
              };
          if (existing.input_hash !== hashJson(terms))
            throw new AshError("CONFLICT", "This spending reference is bound to different terms.");
          return this.finalize(existing, rows, true);
        }
        await policy.assertApproved(request);
        if (rows.some((row) => row.approval_id === request.approval_id))
          throw new AshError("APPROVAL_INVALID", "This approval already authorized another transaction.");
        if (request.funding_source === "earnings" && request.kind !== "wrapped-near")
          throw new AshError(
            "UNSAFE_OPERATION",
            "Verified earnings spending currently requires wrapped-near token receipts.",
          );
        const key = await this.key();
        const client = this.service.client;
        const context = await client.signingContext(signer, key.getPublicKey().toString());
        const actor = await client.account(signer);
        await client.account(request.recipient_account);
        const tokenValue = BigInt(request.amount_atomic);
        const deposit = request.kind === "native" ? tokenValue : 1n;
        // Reserve three times the fresh gas price for submission delays and receipt
        // overhead. Keep the full reservation after finality to bound cumulative spend.
        const gas = request.kind === "native" ? 3_000_000_000_000n : 13_000_000_000_000n;
        const reservation = tokenValue + (request.kind === "native" ? 0n : deposit) + gas * context.gas_price * 3n;
        if (reservation - tokenValue > nearToAtomic(request.max_gas_near!))
          throw new AshError(
            "BUDGET_EXCEEDED",
            "Gas reservation exceeds the approved gas allowance; request a fresh approval.",
          );
        const reserved = rows
          .filter((row) => row.signer_account === signer)
          .reduce((sum, row) => sum + BigInt(row.reserved_near_atomic), 0n);
        if (reserved + reservation > nearToAtomic(this.config.near.maxTotalNear))
          throw new AshError("BUDGET_EXCEEDED", "Transfer plus reserved gas exceeds the cumulative total NEAR cap.");
        if (request.task_id) {
          const taskReserved = rows
            .filter((row) => row.task_id === request.task_id)
            .reduce((sum, row) => sum + BigInt(row.reserved_near_atomic), 0n);
          if (taskReserved + reservation > nearToAtomic(request.task_limit_near!))
            throw new AshError("BUDGET_EXCEEDED", "Transfer exceeds the approved task NEAR allowance.");
        }
        const liquid = BigInt(actor.amount) - BigInt(actor.storage_usage) * context.storage_price;
        if (liquid < deposit + gas * context.gas_price * 3n)
          throw new AshError(
            "BUDGET_EXCEEDED",
            "Account balance after storage staking cannot cover the transfer and reserved gas.",
          );
        if (request.kind === "wrapped-near") {
          const balance = await client.tokenBalance("wrap.near", signer);
          const storage = await client.tokenStorage("wrap.near", request.recipient_account);
          if (!storage.registered || BigInt(balance.balance_atomic) < tokenValue)
            throw new AshError("BUDGET_EXCEEDED", "Wrapped NEAR balance or recipient storage is insufficient.");
        }
        if (request.funding_source === "earnings") {
          const earnings = await new LiveTracks(this.config, client).agentBalance({
            agent_account: signer,
            token_account: "wrap.near",
            spending_limit_atomic: request.amount_atomic,
          });
          if (BigInt(earnings.spendable_atomic) < tokenValue)
            throw new AshError(
              "BUDGET_EXCEEDED",
              "Verified earnings after outstanding obligations cannot fund this transfer.",
            );
        }
        const previousNonce = rows
          .filter((row) => row.public_key === key.getPublicKey().toString() && row.signer_account === signer)
          .reduce((max, row) => (BigInt(row.nonce) > max ? BigInt(row.nonce) : max), context.nonce);
        const nonce = previousNonce + 1n;
        const transaction = createTransaction(
          signer,
          key.getPublicKey(),
          request.kind === "native" ? request.recipient_account : "wrap.near",
          nonce,
          [
            request.kind === "native"
              ? actionCreators.transfer(deposit)
              : actionCreators.functionCall(
                  "ft_transfer",
                  { receiver_id: request.recipient_account, amount: request.amount_atomic },
                  10_000_000_000_000n,
                  1n,
                ),
          ],
          decodeBase58(context.block_hash),
        );
        const digest = createHash("sha256").update(encodeTransaction(transaction)).digest();
        const seal = async () => {
          // Recheck expiring authority and the disk stop flag after all provider reads.
          await policy.assertApproved(request);
          await policy.assertEnabled();
          const signature = key.sign(digest);
          const encoded = Buffer.from(
            encodeTransaction(
              new SignedTransaction({
                transaction,
                signature: new Signature({ keyType: KeyType.ED25519, data: signature.signature }),
              }),
            ),
          ).toString("base64");
          const record: SpendRecord = {
            ...request,
            signer_account: signer,
            public_key: key.getPublicKey().toString(),
            nonce: nonce.toString(),
            input_hash: hashJson(transferTerms(request)),
            tx_hash: encodeBase58(digest),
            reserved_near_atomic: reservation.toString(),
            status: "SIGNED",
            created_at: new Date().toISOString(),
          };
          rows.push(record);
          // Reserve durably before broadcast. A crash or timeout never frees uncertain money.
          await atomicWriteJson(this.file, rows);
          return { record, encoded };
        };
        const { record, encoded } = request.task_id
          ? await withFileLock(path.join(new TaskStore(this.config).taskDir(request.task_id), "task.lock"), seal)
          : await seal();
        try {
          await client.broadcastSignedTransaction(encoded);
          return await this.finalize(record, rows, false);
        } catch {
          if (record.status !== "BLOCKED") record.status = "UNKNOWN";
          await atomicWriteJson(this.file, rows);
          throw new AshError(
            "MARKET_UNAVAILABLE",
            `Transaction ${record.tx_hash} may have been sent. Its budget remains reserved. Use mainnet reconcile ${record.reference}; do not create another payment.`,
          );
        }
      },
      { timeoutMs: 120_000, staleMs: 180_000 },
    );
  }

  async reconcile(ref: string) {
    await this.service.initialize();
    if (!reference.safeParse(ref).success) throw new AshError("VALIDATION_FAILED", "Invalid spending reference.");
    return withFileLock(
      `${this.file}.lock`,
      async () => {
        const rows = await this.records();
        const row = rows.find((entry) => entry.reference === ref && entry.signer_account === this.config.near.account);
        if (!row) throw new AshError("NOT_FOUND", "Spending reference was not found.");
        return this.finalize(row, rows, true);
      },
      { timeoutMs: 120_000, staleMs: 180_000 },
    );
  }

  private async finalize(row: SpendRecord, rows: SpendRecord[], replayed: boolean) {
    const value = await this.service.client.transaction(row.tx_hash, row.signer_account);
    const result = z
      .object({
        final_execution_status: z.literal("FINAL"),
        status: z.object({ SuccessValue: z.string() }),
        transaction: z.object({
          hash: z.literal(row.tx_hash),
          signer_id: z.literal(row.signer_account),
          receiver_id: z.literal(row.kind === "native" ? row.recipient_account : "wrap.near"),
          actions: z.array(z.unknown()).length(1),
        }),
        transaction_outcome: z.object({ outcome: z.object({ tokens_burnt: z.string().regex(/^\d+$/) }) }),
        receipts_outcome: z
          .array(
            z.object({
              outcome: z.object({
                status: z
                  .record(z.string(), z.unknown())
                  .refine((status) => "SuccessValue" in status || "SuccessReceiptId" in status),
                tokens_burnt: z.string().regex(/^\d+$/),
              }),
            }),
          )
          .min(1),
      })
      .safeParse(value);
    if (!result.success)
      throw new AshError("VERIFICATION_FAILED", "Transaction is not a successful final mainnet transfer.");
    if (row.kind === "native") {
      const action = z
        .object({ Transfer: z.object({ deposit: z.literal(row.amount_atomic) }) })
        .safeParse(result.data.transaction.actions[0]);
      if (!action.success)
        throw new AshError("VERIFICATION_FAILED", "Final native transfer differs from the authorized amount.");
    } else {
      await this.service.verifyPayment({
        purpose: row.purpose,
        reference: row.reference,
        transfer: {
          tx_hash: row.tx_hash,
          signer_account: row.signer_account,
          sender_account: row.signer_account,
          recipient_account: row.recipient_account,
          token_account: "wrap.near",
          amount_atomic: row.amount_atomic,
        },
      });
    }
    const burned =
      BigInt(result.data.transaction_outcome.outcome.tokens_burnt) +
      result.data.receipts_outcome.reduce((sum, receipt) => sum + BigInt(receipt.outcome.tokens_burnt), 0n);
    const actual = BigInt(row.amount_atomic) + (row.kind === "native" ? 0n : 1n) + burned;
    if (actual > BigInt(row.reserved_near_atomic)) {
      row.status = "BLOCKED";
      row.actual_cost_near_atomic = actual.toString();
      await atomicWriteJson(this.file, rows);
      throw new AshError(
        "INTEGRITY_FAILED",
        "Observed gas cost exceeds the reserved limit; spending remains blocked pending review.",
      );
    }
    row.status = "FINAL";
    row.actual_cost_near_atomic = actual.toString();
    row.evidence_sha256 = hashJson(result.data);
    await atomicWriteJson(this.file, rows);
    return {
      network: "mainnet",
      verified: true,
      status: "FINAL",
      reference: row.reference,
      tx_hash: row.tx_hash,
      recipient_account: row.recipient_account,
      amount_atomic: row.amount_atomic,
      actual_cost_near_atomic: actual.toString(),
      reserved_near_atomic: row.reserved_near_atomic,
      replayed,
    };
  }
}
