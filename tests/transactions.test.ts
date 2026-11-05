import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TransactionLedger, computeReceiptHash, RECEIPT_FILE_PATTERN } from "../src/transactions/ledger.js";
import type { ReceiptInput } from "../src/transactions/ledger.js";
import { tempDir, cleanup } from "./helpers.js";

function receipt(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    idempotency_key: `task_a:st_1:${Math.random()}`,
    task_id: "task_test",
    subtask_id: "st_1",
    task_description: "A test task",
    item: "Architecture",
    subtask_description: "Produce architecture notes",
    status: "UNPAID",
    vendor: null,
    planned_max: "0.00",
    quoted_price: null,
    negotiated_price: null,
    agreed_price: null,
    currency: "USDC",
    marketplace_job_id: null,
    payment_status: "NOT_PAID",
    check_result: { passed: true, status: "passed", details: "ok", criteria: [], injection_flags: [] },
    negotiation_log: [],
    approval_ref: null,
    mode: "simulated",
    attempt: 1,
    metadata: {},
    ...overrides,
  };
}

test("receipts are individually named, hashed and chained", async () => {
  const dir = await tempDir();
  try {
    const ledger = new TransactionLedger(dir);
    const first = await ledger.record(receipt({ idempotency_key: "task_test:st_1", item: "First" }));
    const second = await ledger.record(
      receipt({ idempotency_key: "task_test:st_2", subtask_id: "st_2", item: "Second" }),
    );
    const third = await ledger.record(
      receipt({ idempotency_key: "task_test:st_3", subtask_id: "st_3", item: "Third" }),
    );
    const files = (await fs.readdir(path.join(dir, "transactions"))).filter((file) => RECEIPT_FILE_PATTERN.test(file));
    assert.equal(files.length, 3);
    assert.equal(new Set(files).size, 3);
    assert.ok(files.every((file) => /^Ash_\d{8}_\d{4}(?:_\d+)?\.json$/.test(file)));

    assert.equal(first.previous_hash, "GENESIS");
    assert.equal(second.previous_hash, first.hash);
    assert.equal(third.previous_hash, second.hash);

    const raw = JSON.parse(await fs.readFile(path.join(dir, "transactions", files.sort()[0]!), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(raw.hash, computeReceiptHash(raw));
    assert.equal(raw.hash_algorithm, "SHA-256");

    const report = await ledger.verify();
    assert.equal(report.ok, true);
    assert.equal(report.receipt_count, 3);
    assert.equal(report.last_hash, third.hash);
  } finally {
    await cleanup(dir);
  }
});

test("the same idempotency key never creates a second receipt", async () => {
  const dir = await tempDir();
  try {
    const ledger = new TransactionLedger(dir);
    const key = "task_test:st_1";
    const first = await ledger.record(receipt({ idempotency_key: key }));
    const replay = await ledger.record(receipt({ idempotency_key: key, item: "changed but ignored for replay" }));
    assert.equal(replay.transaction_id, first.transaction_id);
    assert.equal(await ledger.count(), 1);
  } finally {
    await cleanup(dir);
  }
});

test("tampering with a receipt is detected with the exact file", async () => {
  const dir = await tempDir();
  try {
    const ledger = new TransactionLedger(dir);
    await ledger.record(receipt({ idempotency_key: "task_test:st_1" }));
    await ledger.record(receipt({ idempotency_key: "task_test:st_2", subtask_id: "st_2" }));
    const transactions = path.join(dir, "transactions");
    const file = (await fs.readdir(transactions)).find((name) => RECEIPT_FILE_PATTERN.test(name))!;
    const full = path.join(transactions, file);
    const parsed = JSON.parse(await fs.readFile(full, "utf8")) as Record<string, unknown>;
    parsed.item = "tampered";
    await fs.writeFile(full, JSON.stringify(parsed, null, 2));
    const report = await ledger.verify();
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => error.file === file && error.code === "HASH_MISMATCH"));
    await assert.rejects(() => ledger.list(), /integrity/i);
  } finally {
    await cleanup(dir);
  }
});

test("deleting the newest receipt is detected by the chain head", async () => {
  const dir = await tempDir();
  try {
    const ledger = new TransactionLedger(dir);
    await ledger.record(receipt({ idempotency_key: "task_test:st_1" }));
    await ledger.record(receipt({ idempotency_key: "task_test:st_2", subtask_id: "st_2" }));
    const transactions = path.join(dir, "transactions");
    const files = (await fs.readdir(transactions)).filter((name) => RECEIPT_FILE_PATTERN.test(name)).sort();
    await fs.rm(path.join(transactions, files[1]!));
    const report = await ledger.verify();
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => error.code === "MISSING_RECEIPT"));
  } finally {
    await cleanup(dir);
  }
});

test("deleting a middle receipt breaks the chain and leaves a sequence gap", async () => {
  const dir = await tempDir();
  try {
    const ledger = new TransactionLedger(dir);
    await ledger.record(receipt({ idempotency_key: "task_test:st_1" }));
    await ledger.record(receipt({ idempotency_key: "task_test:st_2", subtask_id: "st_2" }));
    await ledger.record(receipt({ idempotency_key: "task_test:st_3", subtask_id: "st_3" }));
    const transactions = path.join(dir, "transactions");
    const files = (await fs.readdir(transactions)).filter((name) => RECEIPT_FILE_PATTERN.test(name)).sort();
    await fs.rm(path.join(transactions, files[1]!));
    const report = await ledger.verify();
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => error.code === "SEQUENCE_GAP"));
    assert.ok(report.errors.some((error) => error.code === "BROKEN_CHAIN"));
  } finally {
    await cleanup(dir);
  }
});

test("an empty ledger is valid and no transactions folder is created by verify", async () => {
  const dir = await tempDir();
  try {
    const ledger = new TransactionLedger(dir);
    const report = await ledger.verify();
    assert.equal(report.ok, true);
    assert.equal(report.exists, false);
    await assert.rejects(() => fs.stat(path.join(dir, "transactions")), /ENOENT/);
  } finally {
    await cleanup(dir);
  }
});

test("a corrupt chain-head witness is reported instead of silently ignored", async () => {
  const dir = await tempDir();
  try {
    const ledger = new TransactionLedger(dir);
    await ledger.record(receipt({ idempotency_key: "task_test:st_1" }));
    await fs.writeFile(path.join(dir, "transactions", ".chain-head.json"), "not json");
    const report = await ledger.verify();
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => error.code === "CHAIN_HEAD_INVALID"));
  } finally {
    await cleanup(dir);
  }
});

for (const prefixCount of [0, 1]) {
  for (const stage of ["intent", "receipt", "head"]) {
    test(`receipt recovery is idempotent after interruption at ${stage} with ${prefixCount} prior receipts`, async () => {
      const dir = await tempDir();
      try {
        const ledger = new TransactionLedger(dir);
        if (prefixCount) await ledger.record(receipt({ idempotency_key: "prior" }));
        const original = ledger["writeChainHead"].bind(ledger);
        ledger["writeChainHead"] = async (head) => {
          if (stage === "head") await original(head);
          throw new Error("interrupted append");
        };
        const input = receipt({ idempotency_key: "interrupted" });
        await assert.rejects(() => ledger.record(input), /interrupted append/);
        const journal = JSON.parse(await fs.readFile(path.join(ledger.dir, ".pending-append.json"), "utf8"));
        if (stage === "intent") await fs.rm(path.join(ledger.dir, journal.receipt.metadata.file));
        const restarted = new TransactionLedger(dir);
        assert.equal((await restarted.verify()).ok, true);
        const replay = await restarted.record(input);
        assert.equal(replay.transaction_id, journal.receipt.transaction_id);
        assert.equal(await restarted.count(), prefixCount + 1);
        await restarted.record(receipt({ idempotency_key: "next" }));
        assert.equal((await restarted.verify()).ok, true);
      } finally {
        await cleanup(dir);
      }
    });
  }
}

for (const damage of ["receipt", "head", "deleted_committed_tail", "unjournaled_tail"]) {
  test(`receipt recovery refuses ${damage}`, async () => {
    const dir = await tempDir();
    try {
      const ledger = new TransactionLedger(dir);
      await ledger.record(receipt({ idempotency_key: "prior" }));
      const original = ledger["writeChainHead"].bind(ledger);
      ledger["writeChainHead"] = async (head) => {
        if (damage === "deleted_committed_tail") await original(head);
        throw new Error("interrupted");
      };
      await assert.rejects(() => ledger.record(receipt({ idempotency_key: "interrupted" })), /interrupted/);
      const journal = JSON.parse(await fs.readFile(path.join(ledger.dir, ".pending-append.json"), "utf8"));
      const file = path.join(ledger.dir, journal.receipt.metadata.file);
      if (damage === "receipt") await fs.writeFile(file, JSON.stringify({ ...journal.receipt, item: "tampered" }));
      if (damage === "head") await fs.writeFile(path.join(ledger.dir, ".chain-head.json"), "broken");
      if (damage === "deleted_committed_tail") await fs.rm(file);
      if (damage === "unjournaled_tail") await fs.rm(path.join(ledger.dir, ".pending-append.json"));
      const restarted = new TransactionLedger(dir);
      assert.equal((await restarted.verify()).ok, false);
      await assert.rejects(() => restarted.record(receipt()), /broken transaction chain/);
    } finally {
      await cleanup(dir);
    }
  });
}

for (const invalid of ["null", "[]", "42", '"receipt"']) {
  test(`receipt verification reports invalid JSON shape ${invalid} without crashing`, async () => {
    const dir = await tempDir();
    try {
      const ledger = new TransactionLedger(dir);
      const original = await ledger.record(receipt());
      await fs.writeFile(path.join(ledger.dir, original.metadata.file!), invalid);
      const report = await ledger.verify();
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((error) => error.code === "SCHEMA_INVALID"));
      await assert.rejects(() => ledger.record(receipt()), /broken transaction chain/);
    } finally {
      await cleanup(dir);
    }
  });
}

test("renaming a receipt cannot pass verification and corrupt the next append", async () => {
  const dir = await tempDir();
  try {
    const ledger = new TransactionLedger(dir);
    const original = await ledger.record(receipt());
    const name = original.metadata.file!;
    await fs.rename(path.join(ledger.dir, name), path.join(ledger.dir, name.replace(".json", "_900.json")));
    assert.equal((await ledger.verify()).ok, false);
    await assert.rejects(() => ledger.record(receipt()), /broken transaction chain/);
  } finally {
    await cleanup(dir);
  }
});

test("receipt hashing detects added prototype-named data", async () => {
  const dir = await tempDir();
  try {
    const ledger = new TransactionLedger(dir);
    const original = await ledger.record(receipt());
    const changed = JSON.parse(JSON.stringify(original));
    Object.defineProperty(changed.metadata, "__proto__", { value: "tampered", enumerable: true });
    await fs.writeFile(path.join(ledger.dir, original.metadata.file!), JSON.stringify(changed));
    assert.ok((await ledger.verify()).errors.some((error) => error.code === "HASH_MISMATCH"));
  } finally {
    await cleanup(dir);
  }
});

test("receipt creation hashes the normalized stored object", async () => {
  const dir = await tempDir();
  try {
    const ledger = new TransactionLedger(dir);
    const saved = await ledger.record(receipt({ metadata: JSON.parse('{"__proto__":"value","ordinary":"retained"}') }));
    assert.equal(saved.hash, computeReceiptHash(saved));
    assert.equal((await ledger.verify()).ok, true);
    await ledger.record(receipt());
    assert.equal((await ledger.verify()).receipt_count, 2);
  } finally {
    await cleanup(dir);
  }
});

test("backward clock changes stop before corrupting the receipt chain", async (t) => {
  const dir = await tempDir();
  try {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-03T12:00:00Z") });
    const ledger = new TransactionLedger(dir);
    const first = await ledger.record(receipt());
    t.mock.timers.setTime(Date.parse("2026-11-03T11:00:00Z"));
    await assert.rejects(() => ledger.record(receipt()), /system clock/);
    assert.equal((await ledger.verify()).ok, true);
    t.mock.timers.setTime(Date.parse("2026-11-03T12:00:00Z"));
    const second = await ledger.record(receipt());
    assert.equal(second.previous_hash, first.hash);
    assert.deepEqual(
      (await ledger.list()).map((row) => row.sequence),
      [1, 2],
    );
  } finally {
    t.mock.timers.reset();
    await cleanup(dir);
  }
});
