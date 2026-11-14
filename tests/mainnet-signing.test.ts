import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { KeyPair } from "@near-js/crypto";
import { decodeSignedTransaction, encodeTransaction, type SignedTransaction } from "@near-js/transactions";
import { MainnetSigner, nearToAtomic } from "../src/server/mainnet-signer.js";
import { MainnetClient } from "../src/providers/mainnet.js";
import { MainnetPolicy } from "../src/server/mainnet-policy.js";
import { hashJson } from "../src/util/json.js";
import { TaskStore } from "../src/state/store.js";
import { TaskInputSchema } from "../src/domain/schemas.js";
import { MainnetService } from "../src/server/mainnet-service.js";
import { redact } from "../src/util/redact.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

const HASH = "EFWy1YAmbQQMBPCheirp6oVSwEV6EVNfX7isCeE8nsoL";
const ACCOUNT = "0xfestac.near";
const input = {
  reference: "smoke-1",
  kind: "native",
  recipient_account: ACCOUNT,
  amount_atomic: "1000000000000000000",
};

async function setup(dir: string, overrides: Record<string, string> = {}) {
  const key = KeyPair.fromRandom("ed25519");
  const file = path.join(dir, "near-key.json");
  await fs.writeFile(file, JSON.stringify({ account_id: ACCOUNT, private_key: key.toString() }), { mode: 0o600 });
  const config = testConfig(dir, {
    ASH_DEMO: "0",
    ASH_SIMULATE: "false",
    ASH_MODEL_PROVIDER: "none",
    ASH_NEAR_ACCOUNT: ACCOUNT,
    ASH_NEAR_SIGNING_ENABLED: "true",
    ASH_NEAR_SIGNING_KEY_FILE: file,
    ASH_NEAR_MAX_TOTAL_NEAR: "0.01",
    ...overrides,
  });
  let broadcasts = 0;
  let failBroadcast = false;
  let burned = "100000000000000000000";
  let permission: unknown = "FullAccess";
  const transactions = new Map<string, SignedTransaction>();
  const signatures: SignedTransaction[] = [];
  const client = new MainnetClient(config.near, (async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    let result: unknown;
    if (body.method === "status")
      result = {
        chain_id: "mainnet",
        sync_info: {
          syncing: false,
          latest_block_height: 1,
          latest_block_hash: HASH,
          latest_block_time: "2026-11-13T21:00:00Z",
        },
      };
    else if (body.method === "gas_price") result = { gas_price: "100000000" };
    else if (body.method === "EXPERIMENTAL_protocol_config")
      result = { runtime_config: { storage_amount_per_byte: "10000000000000000000" } };
    else if (body.method === "broadcast_tx_commit") {
      broadcasts++;
      const signed = decodeSignedTransaction(Buffer.from(body.params[0], "base64"));
      const digest = createHash("sha256").update(encodeTransaction(signed.transaction)).digest();
      assert.ok(
        key.getPublicKey().verify(digest, Uint8Array.from(signed.signature.ed25519Signature!.data)),
        "Official NEAR decoder verifies the actual signature",
      );
      assert.equal(signed.transaction.signerId, ACCOUNT);
      assert.equal(signed.transaction.receiverId, ACCOUNT);
      assert.equal(signed.transaction.actions[0]!.transfer!.deposit, BigInt(input.amount_atomic));
      signatures.push(signed);
      transactions.set(digest.toString("hex"), signed);
      if (failBroadcast) throw new Error("Network disconnected after acceptance");
      result = {};
    } else if (body.method === "tx") {
      // Requests are matched to a signed transaction's hash; the mock never signs.
      const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let n = 0n;
      for (const ch of body.params.tx_hash) n = n * 58n + BigInt(alphabet.indexOf(ch));
      const signed = transactions.get(n.toString(16).padStart(64, "0"));
      assert.ok(signed);
      result = {
        final_execution_status: "FINAL",
        status: { SuccessValue: "" },
        transaction: {
          hash: body.params.tx_hash,
          signer_id: ACCOUNT,
          receiver_id: ACCOUNT,
          actions: [{ Transfer: { deposit: input.amount_atomic } }],
        },
        transaction_outcome: { outcome: { tokens_burnt: "0" } },
        receipts_outcome: [{ outcome: { status: { SuccessValue: "" }, tokens_burnt: burned } }],
      };
    } else if (body.params.request_type === "view_access_key") result = { nonce: 4, permission, block_hash: HASH };
    else
      result = {
        amount: "1000000000000000000000000",
        locked: "0",
        code_hash: HASH,
        storage_usage: 1,
        block_height: 1,
        block_hash: HASH,
      };
    return Response.json({ jsonrpc: "2.0", id: "ash-mainnet", result });
  }) as typeof fetch);
  const signer = new MainnetSigner(config, client);
  const policy = new MainnetPolicy(config);
  const authorize = async (value: unknown) => {
    const request = { max_gas_near: "0.009", ...Object(value) };
    const proposed = await policy.request(request);
    await policy.approvals().decide(proposed.approval.id, "approved", proposed.confirmation_phrase);
    return { ...request, approval_id: proposed.approval.id };
  };
  return {
    signer,
    policy,
    authorize,
    send: async (value: unknown) => signer.send(await authorize(value)),
    key,
    file,
    config,
    client,
    broadcasts: () => broadcasts,
    signatures,
    fail: () => {
      failBroadcast = true;
    },
    setBurned: (value: string) => {
      burned = value;
    },
    setPermission: (value: unknown) => {
      permission = value;
    },
  };
}

test("mainnet signing uses official encoding, exact amounts, final evidence and replay protection", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    const first = await mock.send(input);
    assert.equal(first.status, "FINAL");
    assert.equal(first.actual_cost_near_atomic, "101000000000000000000");
    assert.equal((await mock.send(input)).replayed, true);
    assert.equal(mock.broadcasts(), 1);
    assert.equal(mock.signatures[0]!.transaction.nonce, 5n);
    assert.equal((await mock.signer.status()).max_total_near, "0.01");
    assert.equal(redact(mock.key.toString()), "[REDACTED]");
    await assert.rejects(() => mock.send({ ...input, amount_atomic: "2" }), /different terms/);
  } finally {
    await cleanup(dir);
  }
});

test("gas allowance, task cancellation and cumulative task allowance prevent new signatures", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    const gas = await mock.authorize({ ...input, max_gas_near: "0.00001" });
    await assert.rejects(() => mock.signer.send(gas), /Gas reservation exceeds/);
    const store = new TaskStore(mock.config);
    const task = await store.create(
      TaskInputSchema.parse({ description: "A reviewed local handover", budget: "1.00", currency: "USDC" }),
    );
    const plan = {
      schema_version: 1,
      summary: "Create a local note",
      final_outcome: "A local note",
      assumptions: [],
      risks: [],
      currency: "USDC",
      authorized_budget: "1.00",
      contingency: "0.10",
      external_planned: "0.00",
      subtasks: [
        {
          id: "st_note",
          title: "Write note",
          description: "Write a local handover note",
          execution: "DIY",
          dependencies: [],
          complexity: "low",
          skills: [],
          deliverable: "A note",
          acceptance_criteria: [{ kind: "deliverable_present", description: "A note exists", min_chars: 1 }],
          planned_max: "0.00",
          estimated_cost: "0.00",
          rationale: "No external work",
        },
      ],
    };
    await store.installPlan(task.id, plan);
    const installed = await store.load(task.id);
    const manager = store.approvals(task.id);
    const approval = await manager.request({
      kind: "plan",
      amount: "1.00",
      currency: "USDC",
      summary: "Review local task",
      scope: { plan_hash: hashJson(installed.plan), currency: "USDC" },
    });
    await manager.decide(approval.id, "approved", manager.confirmationPhrase(approval));
    await store.update(task.id, (row) => {
      row.plan_approval_ref = approval.id;
      row.status = "planned";
    });
    const linked = { ...input, task_id: task.id, task_limit_near: "0.001" };
    const first = await mock.authorize(linked);
    assert.equal((await mock.signer.send(first)).status, "FINAL");
    const over = await mock.authorize({ ...linked, reference: "task-second" });
    await assert.rejects(() => mock.signer.send(over), /task NEAR allowance/);
    const stopped = await mock.authorize({ ...linked, reference: "task-stopped", task_limit_near: "0.005" });
    await store.update(task.id, (row) => {
      row.status = "cancelled";
    });
    await assert.rejects(() => mock.signer.send(stopped), /Task is stopped/);
    assert.equal(mock.broadcasts(), 1);
    assert.equal(mock.signatures.length, 1);
  } finally {
    await cleanup(dir);
  }
});

test("native evidence requires matching historical approval and exact provider terms", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    await mock.send(input);
    const service = new MainnetService(mock.config, mock.client);
    assert.equal(
      (await service.evidence()).tracks.find((row) => row.id === "security")!.verification_status,
      "LIVE_VERIFIED",
    );
    const file = path.join(dir, "mainnet", "approvals.json");
    const approvals = JSON.parse(await fs.readFile(file, "utf8"));
    approvals.requests[0].scope.transfer_sha256 = "0".repeat(64);
    await fs.writeFile(file, JSON.stringify(approvals));
    await assert.rejects(() => service.evidence(), /historical human authority/);
  } finally {
    await cleanup(dir);
  }
});

test("signing refuses disabled, disallowed, over-cap and unrestricted input before broadcasting", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir, { ASH_NEAR_SIGNING_ENABLED: "false" });
    await assert.rejects(() => mock.send(input), /disabled/);
    mock.config.near.signingEnabled = true;
    await assert.rejects(() => mock.send({ ...input, recipient_account: "other.near" }), /outside/);
    await assert.rejects(() => mock.send({ ...input, amount_atomic: nearToAtomic("0.01").toString() }), /gas/);
    await assert.rejects(() => mock.signer.send({ ...input, actions: [] }), /Provide/);
    assert.equal(mock.broadcasts(), 0);
  } finally {
    await cleanup(dir);
  }
});

test("cumulative reservation serializes concurrent sends and survives finality", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir, { ASH_NEAR_MAX_TOTAL_NEAR: "0.001" });
    const results = await Promise.allSettled([mock.send(input), mock.send({ ...input, reference: "smoke-2" })]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(mock.broadcasts(), 1);
    assert.equal((await mock.signer.status()).reserved_near_atomic, "901000000000000000000");
  } finally {
    await cleanup(dir);
  }
});

test("uncertain broadcast retains its budget and reconciles without sending another transaction", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    mock.fail();
    await assert.rejects(() => mock.send(input), /may have been sent/);
    assert.equal((await mock.signer.status()).transactions[0]!.status, "UNKNOWN");
    assert.equal((await mock.signer.reconcile(input.reference)).status, "FINAL");
    assert.equal(mock.broadcasts(), 1);
  } finally {
    await cleanup(dir);
  }
});

test("POSIX key-file permissions fail before signing", { skip: process.platform === "win32" }, async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    await fs.chmod(mock.file, 0o644);
    await assert.rejects(() => mock.send(input), /permissions 600/);
    assert.equal(mock.broadcasts(), 0);
  } finally {
    await cleanup(dir);
  }
});

test("function-call keys fail before signing", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    mock.setPermission({
      FunctionCall: { receiver_id: "wrap.near", allowance: "1000", method_names: ["ft_transfer"] },
    });
    await assert.rejects(() => mock.send(input), /full-access/);
    assert.equal(mock.broadcasts(), 0);
  } finally {
    await cleanup(dir);
  }
});

test("symlinked signing keys fail before signing", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    const target = path.join(dir, "key-target.json");
    await fs.rename(mock.file, target);
    await fs.symlink(target, mock.file, "file");
    await assert.rejects(() => mock.send(input), /private regular file/);
    assert.equal(mock.broadcasts(), 0);
  } finally {
    await cleanup(dir);
  }
});

test("fee overruns permanently block subsequent spending and corrupt state fails closed", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    mock.setBurned("2000000000000000000000");
    await assert.rejects(() => mock.send(input), /may have been sent/);
    assert.equal((await mock.signer.status()).transactions[0]!.status, "BLOCKED");
    await assert.rejects(() => mock.send({ ...input, reference: "smoke-2" }), /blocked/);
    await fs.writeFile(path.join(dir, "mainnet", "spending.json"), "[{}]");
    await assert.rejects(() => mock.signer.status(), /store is invalid/);
    assert.equal(mock.broadcasts(), 1);
  } finally {
    await cleanup(dir);
  }
});

test("signing is impossible in demo mode", async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(() => new MainnetSigner(testConfig(dir)).send(input), /demo mode/);
  } finally {
    await cleanup(dir);
  }
});

test("raw base58 NEAR secret exports are normalized without changing the private file", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    const text = JSON.stringify({ account_id: ACCOUNT, private_key: mock.key.toString().slice("ed25519:".length) });
    await fs.writeFile(mock.file, text);
    assert.equal((await mock.send(input)).status, "FINAL");
    assert.equal(await fs.readFile(mock.file, "utf8"), text);
  } finally {
    await cleanup(dir);
  }
});

test("public keys are rejected as signing keys even with the ed25519 prefix", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    for (const value of [
      mock.key.getPublicKey().toString(),
      mock.key.getPublicKey().toString().slice("ed25519:".length),
    ]) {
      await fs.writeFile(mock.file, JSON.stringify({ account_id: ACCOUNT, private_key: value }));
      await assert.rejects(() => mock.send(input), /public key cannot sign/);
    }
    assert.equal(mock.broadcasts(), 0);
  } finally {
    await cleanup(dir);
  }
});

test("new signing requires exact expiring human authority before accessing the key", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    await assert.rejects(() => mock.signer.send(input), /approved max_gas|approval/i);
    const authorized = await mock.authorize(input);
    await assert.rejects(() => mock.signer.send({ ...authorized, amount_atomic: "2" }), /changed since approval/);
    const file = path.join(dir, "mainnet", "approvals.json");
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.requests[0].expires_at = "2000-01-01T00:00:00.000Z";
    await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(() => mock.signer.send(authorized), /expired/);
    assert.equal(mock.signatures.length, 0);
    assert.equal(mock.broadcasts(), 0);
  } finally {
    await cleanup(dir);
  }
});

test("disk stop flag blocks new signatures without reloading process configuration", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    const authorized = await mock.authorize(input);
    await mock.policy.setEnabled(false);
    assert.equal((await mock.signer.status()).signing_enabled, false);
    await assert.rejects(() => mock.signer.send(authorized), /stop flag/);
    assert.equal(mock.broadcasts(), 0);
    await mock.policy.setEnabled(true);
    assert.equal((await mock.signer.send(authorized)).status, "FINAL");
  } finally {
    await cleanup(dir);
  }
});

test("earnings-funded signing cannot draw on an unrelated wrapped-NEAR wallet balance", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir, { ASH_NEAR_ALLOWED_RECIPIENTS: "vendor.near" });
    mock.client.tokenBalance = async (token, owner) => ({
      network: "mainnet",
      token_account: token,
      owner_account: owner,
      balance_atomic: "1000000000000000000000000",
      block_height: 1,
      block_hash: HASH,
    });
    mock.client.tokenStorage = async (token, owner) => ({
      network: "mainnet",
      token_account: token,
      owner_account: owner,
      registered: true,
      block_height: 1,
      block_hash: HASH,
    });
    const funded = { ...input, recipient_account: "vendor.near", funding_source: "earnings" };
    await assert.rejects(() => mock.send(funded), /requires wrapped-near/);
    await assert.rejects(() => mock.send({ ...funded, kind: "wrapped-near" }), /Verified earnings/);
    assert.equal(mock.signatures.length, 0);
    assert.equal(mock.broadcasts(), 0);
    assert.equal((await mock.signer.status()).reserved_near_atomic, "0");
  } finally {
    await cleanup(dir);
  }
});

test("legacy final records retain their hash and reconcile without a new approval or broadcast", async () => {
  const dir = await tempDir();
  try {
    const mock = await setup(dir);
    await mock.send(input);
    const file = path.join(dir, "mainnet", "spending.json");
    const rows = JSON.parse(await fs.readFile(file, "utf8"));
    for (const key of ["approval_id", "max_gas_near", "funding_source"]) delete rows[0][key];
    rows[0].input_hash = hashJson({ ...input, purpose: "revenue-share" });
    await fs.writeFile(file, JSON.stringify(rows));
    assert.equal((await mock.signer.send(input)).replayed, true);
    assert.equal(mock.broadcasts(), 1);
  } finally {
    await cleanup(dir);
  }
});
