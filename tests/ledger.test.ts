import assert from "node:assert/strict";
import test from "node:test";
import {
  adjustBudget,
  commitEscrow,
  createLedger,
  computeTotals,
  refundEscrow,
  releaseEscrow,
  summarizeLedger,
} from "../src/ledger/ledger.js";
import { AshError } from "../src/errors.js";

test("ledger enforces exact limit, multiple commitments and release/refund", () => {
  let ledger = createLedger("task_test", "USDC", "100.00");
  assert.equal(summarizeLedger(ledger).available, 100_000_000n);
  ledger = commitEscrow(ledger, "40.00", "job:a", "first", null);
  ledger = commitEscrow(ledger, "60.00", "job:b", "second", null);
  assert.equal(summarizeLedger(ledger).available, 0n);
  assert.throws(() => commitEscrow(ledger, "0.000001", "job:c", "over", null), AshError);
  ledger = releaseEscrow(ledger, "25.00", "job:a", "partial release", null);
  const totals = summarizeLedger(ledger);
  assert.equal(totals.committed, 75_000_000n);
  assert.equal(totals.paid, 25_000_000n);
  assert.equal(totals.available, 0n);
  ledger = refundEscrow(ledger, "20.00", "job:b", "refund", null);
  assert.equal(summarizeLedger(ledger).refunded, 20_000_000n);
  assert.equal(summarizeLedger(ledger).available, 20_000_000n);
});

test("ledger rejects releases and refunds above committed escrow", () => {
  const ledger = commitEscrow(createLedger("task_test", "USD", "10.00"), "5.00", "job:a", "escrow", null);
  assert.throws(() => releaseEscrow(ledger, "5.01", "job:a", "over", null), AshError);
  assert.throws(() => refundEscrow(ledger, "5.01", "job:a", "over", null), AshError);
});

test("budget changes require approval and cannot drop below committed or paid", () => {
  let ledger = createLedger("task_test", "USDC", "50.00");
  ledger = commitEscrow(ledger, "20.00", "job:a", "escrow", null);
  assert.throws(() => adjustBudget(ledger, "10.00", "", "no approval"), AshError);
  assert.throws(() => adjustBudget(ledger, "10.00", "apr_1", "too low"), AshError);
  ledger = adjustBudget(ledger, "80.00", "apr_1", "increase");
  assert.equal(summarizeLedger(ledger).available, 60_000_000n);
  ledger = releaseEscrow(ledger, "20.00", "job:a", "paid", null);
  assert.throws(() => adjustBudget(ledger, "19.99", "apr_2", "below paid"), AshError);
});

test("ledger derives totals from entries and detects tampering", () => {
  const ledger = createLedger("task_test", "USDC", "10.00");
  const tampered = { ...ledger, authorized_budget: "20.00" };
  assert.throws(() => computeTotals(tampered), AshError);
});

test("escrow for one job cannot pay or refund another job", () => {
  let ledger = commitEscrow(createLedger("task_test", "USDC", "20.00"), "5.00", "job:a", "first", null);
  ledger = commitEscrow(ledger, "10.00", "job:b", "second", null);
  assert.throws(() => releaseEscrow(ledger, "6.00", "job:a", "wrong escrow", null), /this reference/);
  assert.throws(() => refundEscrow(ledger, "1.00", "job:unknown", "wrong job", null), /this reference/);
  ledger = refundEscrow(ledger, "5.00", "job:a", "returned", null);
  assert.throws(() => releaseEscrow(ledger, "1.00", "job:a", "already refunded", null), /this reference/);
  assert.equal(summarizeLedger(ledger).committed, 10_000_000n);
});
