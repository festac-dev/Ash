import assert from "node:assert/strict";
import test from "node:test";
import { formatMinor, parseAmount, percentOf } from "../src/util/money.js";
import { parseBudget } from "../src/cli/wizard.js";
import { AshError } from "../src/errors.js";

test("money parses exact six-decimal minor units without floating point", () => {
  assert.equal(parseAmount("150", "USDC"), 150_000_000n);
  assert.equal(parseAmount("0.000001", "USDC"), 1n);
  assert.equal(parseAmount("12.34", "USDC"), 12_340_000n);
  assert.equal(formatMinor(150_000_000n, "USDC"), "150.00");
  assert.equal(formatMinor(1n, "USDC"), "0.000001");
  assert.equal(formatMinor(12_340_000n, "USDC"), "12.34");
});

test("money rejects malformed, negative and over-precise amounts", () => {
  for (const bad of ["", "-1", "1.1234567", "1e3", "1,000", "abc", ".5"]) {
    assert.throws(() => parseAmount(bad, "USD"), AshError, bad);
  }
});

test("percentage reserve uses integer arithmetic", () => {
  assert.equal(percentOf(150_000_000n, 0.1), 15_000_000n);
  assert.equal(percentOf(1n, 0.1), 0n);
  assert.equal(percentOf(10_000_000n, 0.1), 1_000_000n);
});

test("new-task budgets require an explicit currency", () => {
  assert.equal(parseBudget("150"), null);
  assert.equal(parseBudget("0 USDC"), null);
  assert.equal(parseBudget("$150 USDC"), null);
  assert.deepEqual(parseBudget("150 USDC"), { amount: "150", currency: "USDC" });
  assert.deepEqual(parseBudget("$150.50"), { amount: "150.50", currency: "USD" });
});
