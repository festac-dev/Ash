import assert from "node:assert/strict";
import test from "node:test";
import { csvEscape, csvRecordCount, csvRow } from "../src/journey/core.js";
import { runRealWorld } from "../src/steps/realworld.js";

test("invoice dates reject normalized impossible calendar days", () => {
  for (const date of ["2026-02-29", "2026-02-31", "2026-11-31", "2026-13-01"])
    assert.throws(() => runRealWorld({ due_date: date }), /Due date/);
  assert.equal(runRealWorld({ due_date: "2028-02-29" }).evidence.invoice.due_date, "2028-02-29");
});

test("invoice CSV makes formula-like text inert without changing invoice data", () => {
  const run = runRealWorld({
    client: "=1+1",
    line_items: [{ description: "@SUM(1,2)", quantity: 1, unit_price: "1.00" }],
  });
  assert.equal(run.evidence.invoice.client, "=1+1");
  assert.match(run.evidence.accounting_csv, /'=1\+1/);
  assert.match(run.evidence.accounting_csv, /'@SUM/);
  for (const value of ["=1+1", "+cmd", "-cmd", "@SUM(1)", "\t=1+1"])
    assert.ok(csvEscape(value).startsWith("'") || csvEscape(value).startsWith("\"'"));
  assert.equal(csvEscape(-2), "-2");
});

test("accounting CSV counts quoted multiline fields as one record", () => {
  const description = 'Design "review"\nImplementation support';
  const run = runRealWorld({ line_items: [{ description, quantity: 1, unit_price: "1.00" }] });
  assert.equal(csvRecordCount(run.evidence.accounting_csv), 2);
  assert.ok(run.checks.every((check) => check.passed));
  assert.equal(csvRecordCount(csvRow(["a\nb", 'a"b']) + "\n" + csvRow(["x", "y"])), 2);
});
