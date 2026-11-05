import { AshError } from "../errors.js";
import type { Currency, Minor } from "../util/money.js";
import { formatMinor, parseAmount } from "../util/money.js";
import { nowIso } from "../util/time.js";
import { newId } from "../util/ids.js";
import type { LedgerEntry, LedgerRecord, LedgerTotals } from "../domain/types.js";
import { LedgerRecordSchema } from "../domain/schemas.js";

export function createLedger(taskId: string, currency: Currency, authorized: string): LedgerRecord {
  const at = nowIso();
  const record: LedgerRecord = {
    schema_version: 1,
    task_id: taskId,
    currency,
    initial_authorized: authorized,
    authorized_budget: authorized,
    created_at: at,
    updated_at: at,
    entries: [
      {
        id: newId("led"),
        at,
        kind: "AUTHORIZE",
        amount: authorized,
        currency,
        reference: "task-created",
        description: "Initial task budget authorized by the human.",
        approval_ref: null,
        metadata: {},
      },
    ],
  };
  computeTotals(record);
  return record;
}

export function parseLedger(raw: unknown): LedgerRecord {
  let record: LedgerRecord;
  try {
    record = LedgerRecordSchema.parse(raw) as LedgerRecord;
  } catch (error) {
    throw new AshError("STATE_INVALID", "The budget ledger is corrupt or has an unsupported schema.", { cause: error });
  }
  computeTotals(record);
  return record;
}

/**
 * Derive every total from the append-only entries. The ledger is never
 * trusted as a stored summary: corruption surfaces here as an invariant
 * failure instead of silently misreporting available funds.
 */
export function computeTotals(record: LedgerRecord): LedgerTotals {
  const authorizedBudget = parseAmount(record.authorized_budget, record.currency);
  const initial = parseAmount(record.initial_authorized, record.currency);
  let authorized = 0n;
  let committed = 0n;
  let paid = 0n;
  let refunded = 0n;
  let sawAuthorize = false;
  const seen = new Set<string>();
  const escrowByReference = new Map<string, bigint>();

  for (const entry of record.entries) {
    if (seen.has(entry.id)) {
      throw new AshError("BUDGET_INVARIANT", `Duplicate ledger entry id ${entry.id}.`);
    }
    seen.add(entry.id);
    if (entry.currency !== record.currency) {
      throw new AshError("BUDGET_INVARIANT", "Ledger entry currency does not match the task currency.");
    }
    const amount = parseAmount(entry.amount, record.currency);
    if (amount <= 0n) throw new AshError("BUDGET_INVARIANT", "Ledger entries must be positive amounts.");
    switch (entry.kind) {
      case "AUTHORIZE":
        if (sawAuthorize) throw new AshError("BUDGET_INVARIANT", "The ledger has more than one AUTHORIZE entry.");
        if (amount !== initial)
          throw new AshError("BUDGET_INVARIANT", "AUTHORIZE entry does not match initial_authorized.");
        authorized += amount;
        sawAuthorize = true;
        break;
      case "COMMIT":
        authorized += 0n;
        if (committed + paid + amount > authorized) {
          throw new AshError(
            "BUDGET_INVARIANT",
            `Ledger commit of ${formatMinor(amount, record.currency)} would exceed the authorized budget.`,
          );
        }
        committed += amount;
        escrowByReference.set(entry.reference, (escrowByReference.get(entry.reference) ?? 0n) + amount);
        break;
      case "RELEASE":
        if (amount > (escrowByReference.get(entry.reference) ?? 0n)) {
          throw new AshError("BUDGET_INVARIANT", "Ledger release exceeds committed escrow for this reference.");
        }
        escrowByReference.set(entry.reference, escrowByReference.get(entry.reference)! - amount);
        committed -= amount;
        paid += amount;
        break;
      case "REFUND":
        if (amount > (escrowByReference.get(entry.reference) ?? 0n)) {
          throw new AshError("BUDGET_INVARIANT", "Ledger refund exceeds committed escrow for this reference.");
        }
        escrowByReference.set(entry.reference, escrowByReference.get(entry.reference)! - amount);
        committed -= amount;
        refunded += amount;
        break;
      case "ADJUST_UP":
        authorized += amount;
        break;
      case "ADJUST_DOWN":
        if (amount >= authorized || authorized - amount < committed + paid) {
          throw new AshError("BUDGET_INVARIANT", "Ledger adjustment would drop below committed and paid funds.");
        }
        authorized -= amount;
        break;
      default:
        throw new AshError("BUDGET_INVARIANT", `Unknown ledger entry kind ${(entry as { kind: string }).kind}.`);
    }
  }

  if (!sawAuthorize) throw new AshError("BUDGET_INVARIANT", "The ledger has no AUTHORIZE entry.");
  if (authorized !== authorizedBudget) {
    throw new AshError(
      "BUDGET_INVARIANT",
      `Ledger authorized total ${formatMinor(authorized, record.currency)} does not match authorized_budget ${record.authorized_budget}.`,
    );
  }
  if (committed < 0n || paid < 0n || refunded < 0n) {
    throw new AshError("BUDGET_INVARIANT", "Ledger totals cannot be negative.");
  }
  const available = authorized - committed - paid;
  if (available < 0n) throw new AshError("BUDGET_INVARIANT", "Ledger available balance is negative.");
  return { authorized, committed, paid, refunded, available };
}

export function availableToCommit(record: LedgerRecord): Minor {
  const totals = computeTotals(record);
  return totals.available;
}

function append(record: LedgerRecord, entry: Omit<LedgerEntry, "id" | "at" | "currency">): LedgerRecord {
  const next: LedgerRecord = {
    ...record,
    updated_at: nowIso(),
    entries: [
      ...record.entries,
      {
        ...entry,
        id: newId("led"),
        at: nowIso(),
        currency: record.currency,
      },
    ],
  };
  computeTotals(next);
  return next;
}

export function commitEscrow(
  record: LedgerRecord,
  amountRaw: string,
  reference: string,
  description: string,
  approvalRef: string | null,
  metadata: Record<string, string> = {},
): LedgerRecord {
  const amount = parseAmount(amountRaw, record.currency);
  if (amount <= 0n) throw new AshError("VALIDATION_FAILED", "A commitment must be greater than zero.");
  const totals = computeTotals(record);
  if (totals.committed + totals.paid + amount > totals.authorized) {
    throw new AshError(
      "BUDGET_EXCEEDED",
      `Commitment of ${formatMinor(amount, record.currency)} ${record.currency} exceeds the authorized budget.`,
      {
        details: {
          authorized: formatMinor(totals.authorized),
          committed: formatMinor(totals.committed),
          paid: formatMinor(totals.paid),
          available: formatMinor(totals.available),
        },
      },
    );
  }
  return append(record, {
    kind: "COMMIT",
    amount: amountRaw,
    reference,
    description,
    approval_ref: approvalRef,
    metadata,
  });
}

export function releaseEscrow(
  record: LedgerRecord,
  amountRaw: string,
  reference: string,
  description: string,
  approvalRef: string | null,
  metadata: Record<string, string> = {},
): LedgerRecord {
  const amount = parseAmount(amountRaw, record.currency);
  const totals = computeTotals(record);
  if (amount > totals.committed) {
    throw new AshError("BUDGET_INVARIANT", "Release exceeds the committed escrow for this task.");
  }
  return append(record, {
    kind: "RELEASE",
    amount: amountRaw,
    reference,
    description,
    approval_ref: approvalRef,
    metadata,
  });
}

export function refundEscrow(
  record: LedgerRecord,
  amountRaw: string,
  reference: string,
  description: string,
  approvalRef: string | null,
  metadata: Record<string, string> = {},
): LedgerRecord {
  const amount = parseAmount(amountRaw, record.currency);
  const totals = computeTotals(record);
  if (amount > totals.committed) {
    throw new AshError("BUDGET_INVARIANT", "Refund exceeds the committed escrow for this task.");
  }
  return append(record, {
    kind: "REFUND",
    amount: amountRaw,
    reference,
    description,
    approval_ref: approvalRef,
    metadata,
  });
}

export function adjustBudget(
  record: LedgerRecord,
  newAuthorizedRaw: string,
  approvalRef: string,
  description: string,
): LedgerRecord {
  if (!approvalRef) {
    throw new AshError("APPROVAL_REQUIRED", "Changing the authorized budget requires a recorded human approval.");
  }
  const totals = computeTotals(record);
  const next = parseAmount(newAuthorizedRaw, record.currency);
  if (next <= 0n) throw new AshError("VALIDATION_FAILED", "The authorized budget must stay greater than zero.");
  if (next < totals.committed + totals.paid) {
    throw new AshError("BUDGET_INVARIANT", "The budget cannot drop below committed and paid funds.");
  }
  const delta = next > totals.authorized ? next - totals.authorized : totals.authorized - next;
  if (delta === 0n) return record;
  const nextRecord: LedgerRecord = {
    ...record,
    authorized_budget: newAuthorizedRaw,
    updated_at: nowIso(),
    entries: [
      ...record.entries,
      {
        id: newId("led"),
        at: nowIso(),
        kind: next > totals.authorized ? "ADJUST_UP" : "ADJUST_DOWN",
        amount: formatMinor(delta, record.currency),
        currency: record.currency,
        reference: `budget-change:${approvalRef}`,
        description,
        approval_ref: approvalRef,
        metadata: {
          from: formatMinor(totals.authorized, record.currency),
          to: formatMinor(next, record.currency),
        },
      },
    ],
  };
  computeTotals(nextRecord);
  return nextRecord;
}

export interface BudgetSummary {
  authorized: Minor;
  committed: Minor;
  paid: Minor;
  refunded: Minor;
  available: Minor;
  currency: Currency;
}

export function summarizeLedger(record: LedgerRecord): BudgetSummary {
  const totals = computeTotals(record);
  return { ...totals, currency: record.currency };
}
