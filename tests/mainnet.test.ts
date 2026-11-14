import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { MainnetClient, loadMainnetConfig, type TransferProof } from "../src/providers/mainnet.js";
import { MainnetService } from "../src/server/mainnet-service.js";
import { startAshServer } from "../src/server/server.js";
import { LiveTracks } from "../src/trackflows/live.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

const HASH = "EFWy1YAmbQQMBPCheirp6oVSwEV6EVNfX7isCeE8nsoL";
const proof: TransferProof = {
  tx_hash: HASH,
  signer_account: "buyer.near",
  sender_account: "buyer.near",
  recipient_account: "seller.near",
  token_account: "usdc.near",
  amount_atomic: "1000000",
};
const status = {
  chain_id: "mainnet",
  sync_info: {
    syncing: false,
    latest_block_height: 224413189,
    latest_block_hash: HASH,
    latest_block_time: "2026-11-13T20:24:25.423Z",
  },
};
const tokens = [
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR" },
  { assetId: "nep141:usdc.near", decimals: 6, blockchain: "near", symbol: "USDC" },
];
const event = (sender = proof.sender_account, recipient = proof.recipient_account, amount = proof.amount_atomic) =>
  `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: sender, new_owner_id: recipient, amount }] })}`;
function transaction() {
  return {
    final_execution_status: "FINAL",
    status: { SuccessValue: "" },
    transaction: { hash: HASH, signer_id: "buyer.near" },
    transaction_outcome: {
      id: HASH,
      block_hash: HASH,
      outcome: { executor_id: "buyer.near", logs: [], status: { SuccessReceiptId: HASH } },
    },
    receipts_outcome: [
      {
        id: "receipt-1",
        block_hash: HASH,
        outcome: { executor_id: "usdc.near", logs: [event()], status: { SuccessValue: "" } },
      },
    ],
  };
}

function client(
  options: { status?: unknown; tx?: unknown; quote?: (body: Record<string, unknown>) => unknown; fail?: boolean } = {},
) {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const fetcher = (async (url, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url: String(url), body });
    if (options.fail) throw new Error("provider token must not be exposed");
    if (String(url).endsWith("/tokens")) return Response.json(tokens);
    if (String(url).endsWith("/quote"))
      return Response.json(
        options.quote
          ? options.quote(body!)
          : { quoteRequest: body, quote: { amountIn: body!.amount, amountOut: "1000000", minAmountOut: "990000" } },
      );
    const result = body?.method === "status" ? (options.status ?? status) : (options.tx ?? transaction());
    return Response.json({ jsonrpc: "2.0", id: "ash-mainnet", result });
  }) as typeof fetch;
  return { client: new MainnetClient(loadMainnetConfig({}), fetcher), calls };
}

test("mainnet configuration rejects unsafe endpoints and testnet names", () => {
  for (const endpoint of [
    "http://rpc.mainnet.near.org",
    "https://secret:password@rpc.mainnet.near.org",
    "https://rpc.mainnet.near.org?key=secret",
  ])
    assert.throws(() => loadMainnetConfig({ ASH_NEAR_RPC_URL: endpoint }));
  assert.throws(() => loadMainnetConfig({ ASH_NEAR_ACCOUNT: "agent.testnet" }));
  assert.throws(() => loadMainnetConfig({ ASH_NEAR_TIMEOUT_MS: "Infinity" }));
});

test("mainnet reads reject wrong networks and unsynchronized nodes", async () => {
  await assert.rejects(() => client({ status: { ...status, chain_id: "testnet" } }).client.status(), /mainnet/);
  await assert.rejects(
    () => client({ status: { ...status, sync_info: { ...status.sync_info, syncing: true } } }).client.status(),
    /synchronized/,
  );
  await assert.rejects(
    () => client({ fail: true }).client.status(),
    (error: Error) => /timed out/.test(error.message) && !error.message.includes("token"),
  );
});

const quoteInput = {
  origin_asset: tokens[0]!.assetId,
  destination_asset: tokens[1]!.assetId,
  amount_atomic: "1000000000000000000000000",
  refund_to: "buyer.near",
  recipient: "seller.near",
};
test("1Click quotes force dry mode and never request deposits or spending", async () => {
  const mock = client();
  const quote = await mock.client.dryQuote(quoteInput);
  assert.equal(quote.paid, false);
  assert.equal(quote.signed, false);
  assert.equal(quote.funds_spent, "0");
  assert.equal(mock.calls[1]!.body!.dry, true);
  assert.equal(mock.calls[1]!.body!.swapType, "EXACT_INPUT");
  assert.ok(mock.calls.every((call) => /\/(tokens|quote)$/.test(call.url)));
});

test("dry quotes reject unsafe inputs, unsupported assets and fundable replies", async () => {
  await assert.rejects(
    () => client().client.dryQuote({ ...quoteInput, dry: false } as typeof quoteInput),
    /Invalid dry quote/,
  );
  await assert.rejects(
    () => client().client.dryQuote({ ...quoteInput, recipient: "seller.testnet" }),
    /Invalid dry quote/,
  );
  await assert.rejects(() => client().client.dryQuote({ ...quoteInput, slippage_bps: 101 }), /slippage/);
  await assert.rejects(() => client().client.dryQuote({ ...quoteInput, amount_atomic: "1.5" }), /atomic/);
  await assert.rejects(
    () => client().client.dryQuote({ ...quoteInput, destination_asset: "made-up-token" }),
    /supported/,
  );
  await assert.rejects(
    () =>
      client({
        quote: (body) => ({
          quoteRequest: body,
          quote: { amountIn: body.amount, amountOut: "1", minAmountOut: "1", depositAddress: "fund-me.near" },
        }),
      }).client.dryQuote(quoteInput),
    /fundable/,
  );
});

test("transfer verification uses final execution and exact NEP-141 events", async () => {
  const mock = client();
  const result = await mock.client.verifyTransfer(proof);
  assert.equal(result.status, "VERIFIED_TRANSFER");
  assert.equal(result.events.length, 1);
  assert.deepEqual(mock.calls[1]!.body!.params, {
    tx_hash: HASH,
    sender_account_id: "buyer.near",
    wait_until: "FINAL",
  });
  assert.ok(mock.calls.every((call) => ["status", "tx"].includes(String(call.body!.method))));
});

test("a successful transaction alone cannot verify the wrong token, sender, recipient or amount", async () => {
  for (const changed of [
    { token_account: "other-token.near" },
    { sender_account: "other.near" },
    { recipient_account: "other.near" },
    { amount_atomic: "1000001" },
  ])
    await assert.rejects(() => client().client.verifyTransfer({ ...proof, ...changed }), /exact NEP-141/);
  await assert.rejects(() => client().client.verifyTransfer({ ...proof, tx_hash: "1".repeat(44) }), /Invalid transfer/);
});

test("failed, optimistic, refunding and spoofed receipt outcomes are refused", async () => {
  const failed = transaction();
  failed.receipts_outcome[0]!.outcome.status = { Failure: { ActionError: "failed" } } as unknown as {
    SuccessValue: string;
  };
  await assert.rejects(() => client({ tx: failed }).client.verifyTransfer(proof), /successful execution/);
  await assert.rejects(
    () =>
      client({ tx: { ...transaction(), final_execution_status: "EXECUTED_OPTIMISTIC" } }).client.verifyTransfer(proof),
    /FINAL/,
  );
  const refunded = transaction();
  refunded.receipts_outcome[0]!.outcome.logs.push(event("seller.near", "buyer.near", "1000000"));
  await assert.rejects(() => client({ tx: refunded }).client.verifyTransfer(proof), /reconciliation/);
  const spoofed = transaction();
  spoofed.receipts_outcome[0]!.outcome.executor_id = "untrusted.near";
  await assert.rejects(() => client({ tx: spoofed }).client.verifyTransfer(proof), /exact NEP-141/);
});

test("payment previews do not reserve events and the same payment can subsequently settle its invoice", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig(dir, { ASH_DEMO: "0", ASH_SIMULATE: "false", ASH_MODEL_PROVIDER: "none" });
    const provider = client().client;
    const service = new MainnetService(config, provider);
    const preview = await service.previewPayment({ transfer: proof });
    assert.equal(preview.recorded, false);
    assert.equal(preview.verification.status, "VERIFIED_TRANSFER");
    await assert.rejects(fs.stat(path.join(dir, "mainnet", "payments.json")), { code: "ENOENT" });
    await fs.mkdir(path.join(dir, "mainnet"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "mainnet", "invoices.json"),
      JSON.stringify([
        {
          reference: "actual-invoice",
          client: "Audit client",
          network: "mainnet",
          status: "UNPAID",
          tx_hash: null,
          recipient_account: proof.recipient_account,
          token_account: proof.token_account,
          amount_atomic: proof.amount_atomic,
        },
      ]),
    );
    const invoice = await new LiveTracks(config, provider).settleInvoice({
      reference: "actual-invoice",
      transfer: proof,
    });
    assert.equal(invoice.status, "PAID");
    assert.equal((await service.payments()).length, 1);
    assert.equal((await service.previewPayment({ transfer: proof })).recorded, false);
    assert.equal((await service.payments()).length, 1);
  } finally {
    await cleanup(dir);
  }
});

test("settlement persistence is idempotent and cannot credit a transfer twice", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig(dir, { ASH_DEMO: "0", ASH_SIMULATE: "false", ASH_MODEL_PROVIDER: "none" });
    const service = new MainnetService(config, client().client);
    const request = { purpose: "invoice", reference: "invoice-1", transfer: proof };
    assert.equal((await service.verifyPayment(request)).replayed, false);
    assert.equal((await service.verifyPayment(request)).replayed, true);
    assert.equal((await service.payments()).length, 1);
    await assert.rejects(
      () => service.verifyPayment({ ...request, purpose: "hire", reference: "hire-1" }),
      /second invoice/,
    );
    const stored = JSON.parse(await fs.readFile(path.join(dir, "mainnet", "payments.json"), "utf8"));
    assert.equal(stored[0].verification.status, "VERIFIED_TRANSFER");
    assert.equal(
      await fs
        .stat(path.join(dir, "mainnet", "payments.json.lock"))
        .then(() => true)
        .catch(() => false),
      false,
    );
  } finally {
    await cleanup(dir);
  }
});

test("concurrent settlement requests credit the same transfer once", async () => {
  const dir = await tempDir();
  try {
    const service = new MainnetService(
      testConfig(dir, { ASH_DEMO: "0", ASH_SIMULATE: "false", ASH_MODEL_PROVIDER: "none" }),
      client().client,
    );
    const results = await Promise.allSettled([
      service.verifyPayment({ purpose: "invoice", reference: "one", transfer: proof }),
      service.verifyPayment({ purpose: "sale", reference: "two", transfer: proof }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await service.payments()).length, 1);
  } finally {
    await cleanup(dir);
  }
});

test("demo mode and unauthenticated API calls cannot reach mainnet operations", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir, { ASH_SERVER_PORT: "0" }) });
  try {
    for (const route of ["check", "keys", "payments", "dao-proposal"]) {
      assert.equal((await fetch(`${server.session.url}/api/mainnet/${route}`)).status, 401);
      assert.equal(
        (
          await fetch(`${server.session.url}/api/mainnet/${route}`, {
            headers: { Authorization: `Bearer ${server.session.token}` },
          })
        ).status,
        403,
      );
    }
    for (const route of ["quote", "verify", "preview"]) {
      assert.equal(
        (await fetch(`${server.session.url}/api/mainnet/${route}`, { method: "POST", body: "{}" })).status,
        401,
      );
      assert.equal(
        (
          await fetch(`${server.session.url}/api/mainnet/${route}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${server.session.token}` },
            body: "{}",
          })
        ).status,
        403,
      );
    }
    await assert.rejects(() => new MainnetService(testConfig(dir), client().client).check(), /disabled in demo/);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});
