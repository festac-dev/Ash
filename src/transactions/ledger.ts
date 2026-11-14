import path from "node:path";
import type { Currency } from "../util/money.js";
import type { CriterionResult, NegotiationEntry, TransactionReceipt, VendorRef } from "../domain/types.js";
import { TransactionReceiptSchema } from "../domain/schemas.js";
import { AshError } from "../errors.js";
import { atomicWriteFile, ensurePrivateDir, listFiles, readFileIfExists, withFileLock } from "../util/fs.js";
import { hashJson } from "../util/json.js";
import { newId } from "../util/ids.js";
import { nowIso, receiptStamp } from "../util/time.js";

/** Receipt filenames are Ash_YYYYMMDD_HHMM.json, with an optional _N collision suffix. */
export const RECEIPT_FILE_PATTERN = /^Ash_\d{8}_\d{4}(?:_\d+)?\.json$/;
export const CHAIN_HEAD_FILE = ".chain-head.json";
export const PENDING_APPEND_FILE = ".pending-append.json";
export const GENESIS_HASH = "GENESIS";

/** Chronological order; the numeric collision suffix must not sort as text. */
function compareReceiptFiles(left: string, right: string): number {
  const leftMatch = /^Ash_(\d{8}_\d{4})(?:_(\d+))?\.json$/.exec(left);
  const rightMatch = /^Ash_(\d{8}_\d{4})(?:_(\d+))?\.json$/.exec(right);
  if (!leftMatch || !rightMatch) return left.localeCompare(right);
  const stamp = leftMatch[1]!.localeCompare(rightMatch[1]!);
  if (stamp !== 0) return stamp;
  return Number(leftMatch[2] ?? 1) - Number(rightMatch[2] ?? 1);
}

export interface ReceiptInput {
  idempotency_key: string;
  task_id: string;
  subtask_id: string;
  task_description: string;
  item: string;
  subtask_description: string;
  status: TransactionReceipt["status"];
  vendor: VendorRef | null;
  planned_max: string;
  quoted_price: string | null;
  negotiated_price: string | null;
  agreed_price: string | null;
  currency: Currency;
  marketplace_job_id: string | null;
  payment_status: TransactionReceipt["payment_status"];
  check_result: {
    passed: boolean;
    status: TransactionReceipt["check_result"]["status"];
    details: string;
    criteria: CriterionResult[];
    injection_flags: string[];
  };
  negotiation_log: NegotiationEntry[];
  approval_ref: string | null;
  mode: TransactionReceipt["mode"];
  attempt: number;
  metadata: Record<string, string>;
}

export interface IntegrityIssue {
  file: string;
  code: string;
  message: string;
}

export interface IntegrityReport {
  ok: boolean;
  exists: boolean;
  receipt_count: number;
  last_hash: string | null;
  last_file: string | null;
  chain_head: { count: number; last_hash: string; last_file: string } | null;
  errors: IntegrityIssue[];
  warnings: IntegrityIssue[];
}

interface ChainHead {
  schema_version: 1;
  count: number;
  last_hash: string;
  last_file: string;
  updated_at: string;
}

interface ChainState {
  report: IntegrityReport;
  receipts: TransactionReceipt[];
}

/**
 * Compute the SHA-256 digest for a receipt. The `hash` field is excluded from
 * its own input; everything else is canonicalized with sorted keys.
 */
export function computeReceiptHash(receipt: unknown): string {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new AshError("VALIDATION_FAILED", "A receipt must be a JSON object.");
  }
  const { hash: _ignored, ...rest } = receipt as Record<string, unknown>;
  return hashJson(rest);
}

/**
 * Individual, hash-chained JSON receipts under `<dataDir>/transactions/`.
 * Writes are atomic and exclusive; the chain is verified before every append
 * and never silently repaired.
 */
export class TransactionLedger {
  readonly dir: string;
  private readonly headFile: string;
  private readonly lockFile: string;
  private readonly pendingFile: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "transactions");
    this.headFile = path.join(this.dir, CHAIN_HEAD_FILE);
    this.pendingFile = path.join(this.dir, PENDING_APPEND_FILE);
    this.lockFile = path.join(dataDir, ".transactions.lock");
  }

  /** Append exactly one receipt, or return the receipt for a replayed idempotency key. */
  async record(input: ReceiptInput): Promise<TransactionReceipt> {
    await ensurePrivateDir(this.dir);
    return withFileLock(this.lockFile, async () => {
      const before = await this.readChainLocked();
      if (!before.report.ok) {
        throw new AshError(
          "INTEGRITY_FAILED",
          `Refusing to append to a broken transaction chain (${before.report.errors[0]?.code ?? "integrity failure"}).`,
          { hint: "Run `ash verify`; restore the original receipt files before recording new transactions." },
        );
      }
      const replay = before.receipts.find((receipt) => receipt.idempotency_key === input.idempotency_key);
      if (replay) return replay;

      const timestamp = nowIso();
      const sequence = before.report.receipt_count + 1;
      const previousHash = before.report.last_hash ?? GENESIS_HASH;
      // Never append a receipt that would sort before the existing chain.
      const previousStamp = before.report.last_file?.slice(4, 17) ?? "";
      const stamp = receiptStamp(new Date(timestamp));
      if (stamp < previousStamp)
        throw new AshError(
          "CONFLICT",
          "The system clock is behind the newest receipt. Correct the clock before recording another receipt; the existing chain is intact.",
        );
      let receipt: TransactionReceipt | null = null;

      for (let suffix = 1; suffix <= 1_000; suffix += 1) {
        const file = suffix === 1 ? `Ash_${stamp}.json` : `Ash_${stamp}_${suffix}.json`;
        const candidate = {
          schema_version: "1.0" as const,
          transaction_id: newId("txn"),
          sequence,
          idempotency_key: input.idempotency_key,
          task_id: input.task_id,
          subtask_id: input.subtask_id,
          task_description: input.task_description,
          item: input.item,
          subtask_description: input.subtask_description,
          status: input.status,
          vendor: input.vendor,
          planned_max: input.planned_max,
          quoted_price: input.quoted_price,
          negotiated_price: input.negotiated_price,
          agreed_price: input.agreed_price,
          currency: input.currency,
          marketplace_job_id: input.marketplace_job_id,
          payment_status: input.payment_status,
          check_result: input.check_result,
          negotiation_log: input.negotiation_log,
          approval_ref: input.approval_ref,
          timestamp,
          previous_hash: previousHash,
          hash_algorithm: "SHA-256" as const,
          mode: input.mode,
          attempt: input.attempt,
          metadata: { ...input.metadata, file },
        };
        // Hash exactly the schema-normalized representation that is persisted.
        const parsed = TransactionReceiptSchema.parse({ ...candidate, hash: "0".repeat(64) }) as TransactionReceipt;
        parsed.hash = computeReceiptHash(parsed);
        if ((await readFileIfExists(path.join(this.dir, file))) !== null) continue;
        // A durable intent ties the next receipt to the exact previous witness.
        await atomicWriteFile(
          this.pendingFile,
          `${JSON.stringify({ schema_version: 1, previous_head: before.report.chain_head, receipt: parsed })}\n`,
        );
        // Leave the intent intact on interruption; recovery must validate it.
        await atomicWriteFile(path.join(this.dir, file), `${JSON.stringify(parsed, null, 2)}\n`, {
          exclusive: true,
        });
        receipt = parsed;
        break;
      }

      if (!receipt) {
        throw new AshError("CONFLICT", "Could not find a free receipt filename for this minute.");
      }
      const file = receipt.metadata.file ?? `Ash_${stamp}.json`;
      await this.writeChainHead({
        schema_version: 1,
        count: sequence,
        last_hash: receipt.hash,
        last_file: file,
        updated_at: nowIso(),
      });
      await atomicWriteFile(this.pendingFile, "null\n");
      return receipt;
    });
  }

  /** Every receipt, oldest first. Throws when the chain failed verification. */
  async list(): Promise<TransactionReceipt[]> {
    const state = await this.readChain();
    if (!state.report.ok) {
      throw new AshError(
        "INTEGRITY_FAILED",
        `The transaction chain failed integrity verification (${state.report.errors.length} issue(s)).`,
        { hint: "Run `ash verify` for the exact file and reason. Receipts are never repaired automatically." },
      );
    }
    return state.receipts;
  }

  async history(limit: number): Promise<TransactionReceipt[]> {
    const receipts = await this.list();
    const count = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : receipts.length;
    return receipts.slice(-count);
  }

  async count(): Promise<number> {
    const state = await this.readChain();
    if (!state.report.ok) {
      throw new AshError("INTEGRITY_FAILED", "The transaction chain failed integrity verification.");
    }
    return state.receipts.length;
  }

  /** Verify hashes, chain links, sequence numbers, names and the local chain head. */
  async verify(): Promise<IntegrityReport> {
    return (await this.readChain()).report;
  }

  /** Read and verify once so the report and displayed receipts share a snapshot. */
  async inspect(limit = 100): Promise<{ report: IntegrityReport; receipts: TransactionReceipt[] }> {
    const state = await this.readChain();
    const count = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 100;
    return { report: state.report, receipts: state.report.ok ? state.receipts.slice(-count) : [] };
  }

  private async readChain(): Promise<ChainState> {
    return withFileLock(this.lockFile, () => this.readChainLocked());
  }

  private async readChainLocked(): Promise<ChainState> {
    try {
      await this.recoverAppend();
    } catch (error) {
      if (!(error instanceof AshError) || error.code !== "INTEGRITY_FAILED") throw error;
      const state = await this.readChainRaw();
      state.report.ok = false;
      state.report.errors.push({ file: PENDING_APPEND_FILE, code: "APPEND_RECOVERY_FAILED", message: error.message });
      return state;
    }
    return this.readChainRaw();
  }

  /** Complete only a journaled append. Never infer a new head from loose receipts. */
  private async recoverAppend(): Promise<void> {
    const text = await readFileIfExists(this.pendingFile);
    if (text === null || text.trim() === "null") return;
    const fail = (): never => {
      throw new AshError("INTEGRITY_FAILED", "Pending receipt append does not match the receipt chain and witness.");
    };
    let journal: { schema_version: number; previous_head: IntegrityReport["chain_head"]; receipt: TransactionReceipt };
    try {
      journal = JSON.parse(text) as typeof journal;
      if (journal.schema_version !== 1) fail();
      journal.receipt = TransactionReceiptSchema.parse(journal.receipt) as TransactionReceipt;
      if (journal.previous_head !== null && !validHead(journal.previous_head)) fail();
    } catch {
      return fail();
    }
    const receipt = journal.receipt;
    const previous = journal.previous_head;
    const file = receipt.metadata.file;
    if (
      !file ||
      !RECEIPT_FILE_PATTERN.test(file) ||
      computeReceiptHash(receipt) !== receipt.hash ||
      receipt.sequence !== (previous?.count ?? 0) + 1 ||
      receipt.previous_hash !== (previous?.last_hash ?? GENESIS_HASH)
    )
      fail();
    const next = { count: receipt.sequence, last_hash: receipt.hash, last_file: file! };
    let head: IntegrityReport["chain_head"] = null;
    const headText = await readFileIfExists(this.headFile);
    if (headText !== null) {
      try {
        const parsed = JSON.parse(headText) as ChainHead;
        if (parsed.schema_version !== 1 || !validHead(parsed)) fail();
        head = { count: parsed.count, last_hash: parsed.last_hash, last_file: parsed.last_file };
      } catch {
        return fail();
      }
    }
    const same = (left: unknown, right: unknown): boolean => hashJson(left) === hashJson(right);
    if (!same(head, previous) && !same(head, next)) fail();
    const existing = await readFileIfExists(path.join(this.dir, file!));
    if (existing === null) {
      // Once the head was committed, a missing tail is deletion, not an interrupted write.
      if (!same(head, previous)) fail();
      const prefix = await this.readChainRaw(previous);
      if (!prefix.report.ok || prefix.receipts.length !== (previous?.count ?? 0)) fail();
      await atomicWriteFile(path.join(this.dir, file!), `${JSON.stringify(receipt, null, 2)}\n`, { exclusive: true });
    } else {
      try {
        if (!same(JSON.parse(existing), receipt)) fail();
      } catch {
        return fail();
      }
    }
    const completed = await this.readChainRaw(next);
    if (!completed.report.ok || completed.receipts.length !== next.count) fail();
    await this.writeChainHead({ schema_version: 1, ...next, updated_at: nowIso() });
    await atomicWriteFile(this.pendingFile, "null\n");
  }

  private async readChainRaw(headOverride?: IntegrityReport["chain_head"]): Promise<ChainState> {
    const errors: IntegrityIssue[] = [];
    const warnings: IntegrityIssue[] = [];
    const entries = await listFiles(this.dir);
    const exists = entries.length > 0;
    if (!exists) {
      return {
        report: {
          ok: true,
          exists: false,
          receipt_count: 0,
          last_hash: null,
          last_file: null,
          chain_head: null,
          errors,
          warnings,
        },
        receipts: [],
      };
    }

    const files = entries.filter((file) => RECEIPT_FILE_PATTERN.test(file)).sort(compareReceiptFiles);
    const receipts: TransactionReceipt[] = [];
    const seenIds = new Map<string, string>();
    const seenKeys = new Map<string, string>();
    let previousHash: string | null = null;
    let previousFile: string | null = null;

    for (const [index, file] of files.entries()) {
      const rawText = await readFileIfExists(path.join(this.dir, file));
      if (rawText === null) {
        errors.push({ file, code: "MISSING_RECEIPT", message: "Receipt disappeared while the chain was being read." });
        continue;
      }
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        errors.push({ file, code: "PARSE_ERROR", message: "File is not valid JSON." });
        previousHash = null;
        previousFile = file;
        continue;
      }

      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push({ file, code: "SCHEMA_INVALID", message: "Receipt must be a JSON object." });
        previousHash = null;
        previousFile = file;
        continue;
      }

      const parsed = TransactionReceiptSchema.safeParse(raw);
      if (!parsed.success) {
        errors.push({
          file,
          code: "SCHEMA_INVALID",
          message: `Receipt does not match schema 1.0: ${parsed.error.issues[0]?.message ?? "invalid record"}.`,
        });
      }
      if (parsed.success && parsed.data.metadata.file !== file) {
        errors.push({
          file,
          code: "FILENAME_MISMATCH",
          message: "Receipt filename does not match its recorded filename.",
        });
      }

      let recomputed: string | null = null;
      try {
        recomputed = computeReceiptHash(raw);
      } catch {
        errors.push({ file, code: "HASH_MISMATCH", message: "Receipt cannot be canonicalized for hashing." });
      }
      if (recomputed !== null && typeof raw.hash === "string" && recomputed !== raw.hash) {
        errors.push({ file, code: "HASH_MISMATCH", message: "Stored hash does not match the receipt contents." });
      }

      if (typeof raw.timestamp === "string") {
        const parsedTime = Date.parse(raw.timestamp);
        if (Number.isFinite(parsedTime)) {
          const expected = `Ash_${receiptStamp(new Date(parsedTime))}`;
          if (file !== `${expected}.json` && !new RegExp(`^${expected}_\\d+\\.json$`).test(file)) {
            errors.push({
              file,
              code: "FILENAME_MISMATCH",
              message: `Filename does not match the receipt UTC minute (${expected}.json).`,
            });
          }
        }
      }

      if (raw.sequence !== index + 1) {
        errors.push({
          file,
          code: "SEQUENCE_GAP",
          message: `Receipt sequence is ${String(raw.sequence)} but position ${index + 1} was expected.`,
        });
      }

      if (index === 0) {
        if (raw.previous_hash !== GENESIS_HASH) {
          errors.push({
            file,
            code: "GENESIS_INVALID",
            message: 'The first receipt must use previous_hash "GENESIS".',
          });
        }
      } else if (previousHash === null || raw.previous_hash !== previousHash) {
        errors.push({
          file,
          code: "BROKEN_CHAIN",
          message: `previous_hash does not match the previous receipt${previousFile ? ` (${previousFile})` : ""}.`,
        });
      }

      if (seenIds.has(String(raw.transaction_id))) {
        errors.push({
          file,
          code: "DUPLICATE_TRANSACTION_ID",
          message: `Transaction id also appears in ${seenIds.get(String(raw.transaction_id))}.`,
        });
      } else {
        seenIds.set(String(raw.transaction_id), file);
      }
      if (seenKeys.has(String(raw.idempotency_key))) {
        errors.push({
          file,
          code: "DUPLICATE_IDEMPOTENCY_KEY",
          message: `Idempotency key also appears in ${seenKeys.get(String(raw.idempotency_key))}.`,
        });
      } else {
        seenKeys.set(String(raw.idempotency_key), file);
      }

      previousHash = typeof raw.hash === "string" ? raw.hash : null;
      previousFile = file;
      if (parsed.success) receipts.push(parsed.data as TransactionReceipt);
    }

    for (const file of entries) {
      if (file === CHAIN_HEAD_FILE || file === PENDING_APPEND_FILE || RECEIPT_FILE_PATTERN.test(file)) continue;
      if (file.endsWith(".json") || file.startsWith("Ash_")) {
        warnings.push({ file, code: "UNKNOWN_FILE", message: "File is not part of the receipt chain." });
      }
    }

    let chainHead: IntegrityReport["chain_head"] = null;
    const headText =
      headOverride === undefined
        ? await readFileIfExists(this.headFile)
        : headOverride === null
          ? null
          : JSON.stringify({ schema_version: 1, ...headOverride });
    if (headText !== null) {
      try {
        const rawHead = JSON.parse(headText) as Partial<ChainHead>;
        if (
          rawHead.schema_version !== 1 ||
          typeof rawHead.count !== "number" ||
          !Number.isInteger(rawHead.count) ||
          rawHead.count < 1 ||
          typeof rawHead.last_hash !== "string" ||
          typeof rawHead.last_file !== "string"
        ) {
          throw new Error("invalid shape");
        }
        chainHead = { count: rawHead.count, last_hash: rawHead.last_hash, last_file: rawHead.last_file };
      } catch {
        errors.push({
          file: CHAIN_HEAD_FILE,
          code: "CHAIN_HEAD_INVALID",
          message: "Chain head is missing fields or is not valid JSON.",
        });
      }
    } else if (files.length > 0) {
      errors.push({
        file: CHAIN_HEAD_FILE,
        code: "MISSING_RECEIPT",
        message: "The chain-head witness is missing, so a deleted tail receipt cannot be ruled out.",
      });
    }

    if (chainHead) {
      if (chainHead.count > receipts.length) {
        errors.push({
          file: CHAIN_HEAD_FILE,
          code: "MISSING_RECEIPT",
          message: `Chain head records ${chainHead.count} receipts but only ${receipts.length} are present.`,
        });
      } else if (chainHead.count < receipts.length) {
        warnings.push({
          file: CHAIN_HEAD_FILE,
          code: "CHAIN_HEAD_STALE",
          message: `Chain head records ${chainHead.count} receipts but ${receipts.length} are present.`,
        });
      }
      const last = receipts.at(-1);
      if (last && (chainHead.last_hash !== last.hash || chainHead.last_file !== last.metadata.file)) {
        errors.push({
          file: CHAIN_HEAD_FILE,
          code: "CHAIN_HEAD_MISMATCH",
          message: "Chain head does not point at the final receipt.",
        });
      }
    }

    const last = receipts.at(-1) ?? null;
    return {
      report: {
        ok: errors.length === 0,
        exists: true,
        receipt_count: receipts.length,
        last_hash: last?.hash ?? null,
        last_file: last?.metadata.file ?? null,
        chain_head: chainHead,
        errors,
        warnings,
      },
      receipts,
    };
  }

  private async writeChainHead(head: ChainHead): Promise<void> {
    await atomicWriteFile(this.headFile, `${JSON.stringify(head, null, 2)}\n`);
  }
}

function validHead(head: unknown): head is NonNullable<IntegrityReport["chain_head"]> {
  if (!head || typeof head !== "object") return false;
  const value = head as Record<string, unknown>;
  return (
    Number.isInteger(value.count) &&
    Number(value.count) > 0 &&
    typeof value.last_hash === "string" &&
    typeof value.last_file === "string"
  );
}

/** Human-readable integrity report used by `verify`, reports and startup errors. */
export function formatIntegrityReport(report: IntegrityReport): string[] {
  const lines: string[] = [];
  if (!report.exists) {
    lines.push("Ledger: empty");
    lines.push("No receipts yet. The transactions/ folder is created on the first receipt.");
    return lines;
  }
  lines.push(`Ledger: ${report.ok ? "VERIFIED" : "FAILED"}`);
  lines.push(`Receipts: ${report.receipt_count}`);
  lines.push(`Head: ${report.last_hash ?? "—"}`);
  if (report.last_file) lines.push(`Last file: ${report.last_file}`);
  if (report.errors.length > 0) {
    lines.push("", `Errors (${report.errors.length}):`);
    for (const issue of report.errors) lines.push(`${issue.code}  ${issue.file}  ${issue.message}`);
  }
  if (report.warnings.length > 0) {
    lines.push("", `Warnings (${report.warnings.length}):`);
    for (const issue of report.warnings) lines.push(`${issue.code}  ${issue.file}  ${issue.message}`);
  }
  return lines;
}
