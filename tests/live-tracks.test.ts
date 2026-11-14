import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MainnetClient, loadMainnetConfig, type TransferProof } from "../src/providers/mainnet.js";
import { LiveTracks, runLiveWorkflow } from "../src/trackflows/live.js";
import { sha256Text } from "../src/journey/core.js";
import { TaskStore } from "../src/state/store.js";
import { TaskInputSchema } from "../src/domain/schemas.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

const HASH = "EFWy1YAmbQQMBPCheirp6oVSwEV6EVNfX7isCeE8nsoL";
const TOKEN = "usdc.near";
const proof: TransferProof = {
  tx_hash: HASH,
  signer_account: "buyer.near",
  sender_account: "buyer.near",
  recipient_account: "seller.near",
  token_account: TOKEN,
  amount_atomic: "1000000",
};

function mockProvider(transfer = proof) {
  const transfers = new Map([[transfer.tx_hash, transfer]]);
  let balance = "10000000";
  let registered = true;
  let approved = true;
  let proposalId = 7;
  const calls: string[] = [];
  const fetcher = (async (url, init) => {
    if (String(url).endsWith("/tokens"))
      return Response.json([
        { assetId: `nep141:${TOKEN}`, contractAddress: TOKEN, decimals: 6, blockchain: "near", symbol: "USDC" },
      ]);
    const body = JSON.parse(String(init!.body));
    calls.push(body.method);
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
    else if (body.method === "tx") {
      const txTransfer = transfers.get(body.params.tx_hash) ?? transfer;
      result = {
        final_execution_status: "FINAL",
        status: { SuccessValue: "" },
        transaction: {
          hash: txTransfer.tx_hash,
          signer_id: txTransfer.signer_account,
          receiver_id: "community.sputnik-dao.near",
          actions: [
            {
              FunctionCall: {
                method_name: "act_proposal",
                args: Buffer.from(JSON.stringify({ id: proposalId, action: "VoteApprove" })).toString("base64"),
              },
            },
          ],
        },
        transaction_outcome: {
          id: HASH,
          block_hash: HASH,
          outcome: { executor_id: txTransfer.signer_account, logs: [], status: { SuccessReceiptId: HASH } },
        },
        receipts_outcome: [
          {
            id: "token-receipt",
            block_hash: HASH,
            outcome: {
              executor_id: TOKEN,
              logs: [
                `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: txTransfer.sender_account, new_owner_id: txTransfer.recipient_account, amount: txTransfer.amount_atomic }] })}`,
              ],
              status: { SuccessValue: "" },
            },
          },
        ],
      };
    } else if (body.params.request_type === "view_account")
      result = {
        amount: "1000000000000000000000000",
        locked: "0",
        code_hash: "1".repeat(32),
        storage_usage: 0,
        block_height: 1,
        block_hash: HASH,
      };
    else {
      const value =
        body.params.method_name === "ft_balance_of"
          ? balance
          : body.params.method_name === "storage_balance_of"
            ? registered
              ? { total: "1250000000000000000000", available: "0" }
              : null
            : {
                id: 7,
                proposer: "member.near",
                status: approved ? "Approved" : "InProgress",
                kind: {
                  Transfer: {
                    token_id: TOKEN,
                    receiver_id: transfer.recipient_account,
                    amount: transfer.amount_atomic,
                  },
                },
              };
      result = { result: [...Buffer.from(JSON.stringify(value))], block_height: 1, block_hash: HASH };
    }
    return Response.json({ jsonrpc: "2.0", id: "ash-mainnet", result });
  }) as typeof fetch;
  return {
    client: new MainnetClient(loadMainnetConfig({}), fetcher),
    setTransfer: (value: TransferProof) => {
      transfer = value;
      transfers.set(value.tx_hash, value);
    },
    calls,
    setBalance: (value: string) => {
      balance = value;
    },
    setRegistered: (value: boolean) => {
      registered = value;
    },
    setApproved: (value: boolean) => {
      approved = value;
    },
    setProposalId: (value: number) => {
      proposalId = value;
    },
  };
}

function liveConfig(dir: string) {
  return testConfig(dir, { ASH_DEMO: "0", ASH_SIMULATE: "false", ASH_MODEL_PROVIDER: "none" });
}

test("live invoice creation and exact settlement preserve unpaid/paid transitions", async () => {
  const dir = await tempDir();
  try {
    const mock = mockProvider();
    const tracks = new LiveTracks(liveConfig(dir), mock.client);
    const initial = await tracks.payments.evidence();
    assert.equal(initial.tracks.length, 6);
    assert.ok(initial.tracks.every((row) => row.verification_status === "UNVERIFIED"));
    assert.equal(initial.all_six_live_verified, false);
    const input = {
      reference: "invoice-1",
      client: "Northwind",
      recipient_account: "seller.near",
      token_account: TOKEN,
      amount_atomic: "1000000",
    };
    assert.equal((await tracks.createInvoice(input)).status, "UNPAID");
    assert.equal((await tracks.createInvoice(input)).status, "UNPAID");
    await assert.rejects(() => tracks.createInvoice({ ...input, amount_atomic: "2000000" }), /different payment terms/);
    await assert.rejects(
      () => tracks.settleInvoice({ reference: input.reference, transfer: { ...proof, amount_atomic: "2" } }),
      /invoice terms/,
    );
    assert.equal((await tracks.settleInvoice({ reference: input.reference, transfer: proof })).status, "PAID");
    assert.equal((await tracks.settleInvoice({ reference: input.reference, transfer: proof })).tx_hash, HASH);
    const checked = await tracks.payments.evidence();
    assert.equal(checked.tracks.find((row) => row.id === "realworld")!.verification_status, "LIVE_VERIFIED");
    assert.equal(checked.tracks.filter((row) => row.verification_status === "LIVE_VERIFIED").length, 1);
    assert.ok(mock.calls.every((method) => ["status", "query", "tx"].includes(method)));
  } finally {
    await cleanup(dir);
  }
});

test("sale-bound contributor settlement requires every exact payout and rechecks evidence", async () => {
  const dir = await tempDir();
  try {
    const mock = mockProvider();
    const tracks = new LiveTracks(liveConfig(dir), mock.client);
    await tracks.payments.verifyPayment({ purpose: "sale", reference: "sale-1", transfer: proof });
    const terms = {
      sale_reference: "sale-1",
      treasury_account: "seller.near",
      split: [
        { account: "author.near", percent: 70 },
        { account: "reviewer.near", percent: 30 },
      ],
    };
    await tracks.revenueAllocation(terms);
    await assert.rejects(
      () => tracks.revenueAllocation({ ...terms, split: [{ account: "other.near", percent: 100 }] }),
      /different revenue allocation/,
    );
    const payouts = [
      {
        ...proof,
        tx_hash: `F${HASH.slice(1)}`,
        signer_account: "seller.near",
        sender_account: "seller.near",
        recipient_account: "author.near",
        amount_atomic: "700000",
      },
      {
        ...proof,
        tx_hash: `G${HASH.slice(1)}`,
        signer_account: "seller.near",
        sender_account: "seller.near",
        recipient_account: "reviewer.near",
        amount_atomic: "300000",
      },
    ];
    payouts.forEach(mock.setTransfer);
    await assert.rejects(
      () => tracks.settleRevenue({ sale_reference: "sale-1", transfers: [payouts[0]] }),
      /Each allocated/,
    );
    await assert.rejects(
      () =>
        tracks.settleRevenue({
          sale_reference: "sale-1",
          transfers: [{ ...payouts[0], amount_atomic: "699999" }, payouts[1]],
        }),
      /differs/,
    );
    assert.equal((await tracks.settleRevenue({ sale_reference: "sale-1", transfers: payouts })).status, "PAID");
    assert.equal((await tracks.settleRevenue({ sale_reference: "sale-1", transfers: payouts })).status, "PAID");
    assert.equal(
      (await tracks.payments.evidence()).tracks.find((row) => row.id === "business")!.verification_status,
      "LIVE_VERIFIED",
    );
    const file = path.join(dir, "mainnet", "revenue-allocations.json");
    const rows = JSON.parse(await fs.readFile(file, "utf8"));
    rows[0].payouts[0].amount_atomic = "700001";
    await fs.writeFile(file, JSON.stringify(rows));
    assert.equal(
      (await tracks.payments.evidence()).tracks.find((row) => row.id === "business")!.verification_status,
      "UNVERIFIED",
    );
  } finally {
    await cleanup(dir);
  }
});

test("an arbitrary payment purpose cannot verify an invoice or DAO workflow", async () => {
  const dir = await tempDir();
  try {
    const tracks = new LiveTracks(liveConfig(dir), mockProvider().client);
    await tracks.payments.verifyPayment({ purpose: "bounty", reference: "arbitrary-label", transfer: proof });
    const evidence = await tracks.payments.evidence();
    assert.equal(evidence.tracks.find((row) => row.id === "social")!.verification_status, "UNVERIFIED");
    assert.equal(evidence.all_six_live_verified, false);
  } finally {
    await cleanup(dir);
  }
});

test("autonomous business allocates verified revenue exactly and refuses unpaid sales", async () => {
  const dir = await tempDir();
  try {
    const tracks = new LiveTracks(liveConfig(dir), mockProvider().client);
    const input = {
      sale_reference: "sale-1",
      treasury_account: "seller.near",
      split: [
        { account: "seller.near", percent: 70 },
        { account: "contributor.near", percent: 30 },
      ],
    };
    await assert.rejects(() => tracks.revenueAllocation(input), /verified sale/);
    await tracks.payments.verifyPayment({ purpose: "sale", reference: "sale-1", transfer: proof });
    const split = await tracks.revenueAllocation(input);
    assert.deepEqual(
      split.payouts.map((line) => line.amount_atomic),
      ["700000", "300000"],
    );
    assert.equal(split.paid, false);
    await assert.rejects(
      () => tracks.revenueAllocation({ ...input, split: [{ account: "contributor.near", percent: 99 }] }),
      /100%/,
    );
  } finally {
    await cleanup(dir);
  }
});

test("agent earnings are capped by verified revenue, actual token balance and spending policy", async () => {
  const dir = await tempDir();
  try {
    const mock = mockProvider();
    const tracks = new LiveTracks(liveConfig(dir), mock.client);
    const input = { agent_account: "seller.near", token_account: TOKEN, spending_limit_atomic: "500000" };
    assert.equal((await tracks.agentBalance(input)).spendable_atomic, "0");
    await tracks.payments.verifyPayment({ purpose: "sale", reference: "sale-1", transfer: proof });
    assert.equal((await tracks.agentBalance(input)).spendable_atomic, "500000");
    mock.setBalance("100000");
    assert.equal((await tracks.agentBalance(input)).spendable_atomic, "100000");
  } finally {
    await cleanup(dir);
  }
});

test("concurrent task/API obligations reserve verified earnings once and release explicitly", async () => {
  const dir = await tempDir();
  try {
    const tracks = new LiveTracks(liveConfig(dir), mockProvider().client);
    await tracks.payments.verifyPayment({ purpose: "sale", reference: "earned", transfer: proof });
    const store = new TaskStore(liveConfig(dir));
    const task = await store.create(
      TaskInputSchema.parse({ description: "Reserve reviewed API work", budget: "1.00", currency: "USDC" }),
    );
    const obligation = {
      reference: "api-1",
      task_id: task.id,
      agent_account: "seller.near",
      token_account: TOKEN,
      amount_atomic: "600000",
    };
    const attempts = await Promise.allSettled([
      tracks.reserveObligation(obligation),
      tracks.reserveObligation({ ...obligation, reference: "api-2" }),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    const winner = attempts[0].status === "fulfilled" ? "api-1" : "api-2";
    const query = { agent_account: "seller.near", token_account: TOKEN, spending_limit_atomic: "1000000" };
    assert.equal((await tracks.agentBalance(query)).spendable_atomic, "400000");
    assert.equal((await tracks.reserveObligation({ ...obligation, reference: winner })).replayed, true);
    await tracks.releaseObligation({ reference: winner });
    assert.equal((await tracks.agentBalance(query)).spendable_atomic, "1000000");
    await assert.rejects(
      () => tracks.reserveObligation({ ...obligation, reference: winner, amount_atomic: "1" }),
      /different terms/,
    );
    await store.update(task.id, (row) => {
      row.status = "cancelled";
    });
    await assert.rejects(() => tracks.reserveObligation({ ...obligation, reference: "closed-task" }), /Closed tasks/);
  } finally {
    await cleanup(dir);
  }
});

test("swarm allocation verifies committed bids, funding and one-round reservation", async () => {
  const dir = await tempDir();
  try {
    const poolProof = { ...proof, recipient_account: "pool.near" };
    const mock = mockProvider(poolProof);
    const tracks = new LiveTracks(liveConfig(dir), mock.client);
    const bid = {
      seller: "vendor.near",
      unit_price_atomic: "400000",
      capacity: 2,
      nonce: "private-reveal-nonce",
      commitment: "",
    };
    bid.commitment = sha256Text(
      JSON.stringify(["round-1", bid.seller, bid.unit_price_atomic, bid.capacity, bid.nonce]),
    );
    const round = {
      round_reference: "round-1",
      pool_account: "pool.near",
      token_account: TOKEN,
      quantity: 2,
      max_unit_price_atomic: "500000",
      funding_references: ["contribution-1"],
      bids: [bid],
    };
    await assert.rejects(() => tracks.swarmAllocation(round), /verified mainnet funding/);
    await tracks.payments.verifyPayment({ purpose: "swarm", reference: "contribution-1", transfer: poolProof });
    const allocation = await tracks.swarmAllocation(round);
    assert.equal(allocation.cost_atomic, "800000");
    assert.equal(allocation.remainder_atomic, "200000");
    assert.equal((await tracks.swarmAllocation(round)).replayed, true);
    await assert.rejects(
      () => tracks.swarmAllocation({ ...round, bids: [{ ...bid, nonce: "changed-private-nonce" }] }),
      /commitment|different allocation/,
    );
    const second = {
      ...round,
      round_reference: "round-2",
      bids: [
        {
          ...bid,
          commitment: sha256Text(
            JSON.stringify(["round-2", bid.seller, bid.unit_price_atomic, bid.capacity, bid.nonce]),
          ),
        },
      ],
    };
    await assert.rejects(() => tracks.swarmAllocation(second), /reserved for another round/);
    const payout = {
      ...poolProof,
      tx_hash: "1".repeat(31) + "2",
      sender_account: "pool.near",
      recipient_account: "vendor.near",
      amount_atomic: "800000",
    };
    await assert.rejects(
      () => tracks.settleSwarm({ round_reference: "round-1", transfer: poolProof }),
      /selected swarm payout/,
    );
    mock.setTransfer(payout);
    assert.equal((await tracks.settleSwarm({ round_reference: "round-1", transfer: payout })).paid, true);
    assert.equal((await tracks.settleSwarm({ round_reference: "round-1", transfer: payout })).replayed, true);
    assert.equal(
      (await tracks.payments.evidence()).tracks.find((row) => row.id === "swarms")!.verification_status,
      "LIVE_VERIFIED",
    );
    mock.setBalance("200000");
    assert.equal(
      (await tracks.swarmAllocation(round)).status,
      "PAID",
      "Settled rounds replay their paid result after the balance falls",
    );
  } finally {
    await cleanup(dir);
  }
});

test("social payout binds the approved proposal and credits reputation once", async () => {
  const dir = await tempDir();
  try {
    const transfer = { ...proof, sender_account: "community.sputnik-dao.near" };
    const mock = mockProvider(transfer);
    const tracks = new LiveTracks(liveConfig(dir), mock.client);
    const request = { reference: "bounty-1", dao_account: "community.sputnik-dao.near", proposal_id: 7, transfer };
    mock.setApproved(false);
    await assert.rejects(() => tracks.settleBounty(request), /approved Sputnik/);
    mock.setApproved(true);
    mock.setProposalId(8);
    await assert.rejects(() => tracks.settleBounty(request), /expected DAO proposal/);
    mock.setProposalId(7);
    const first = await tracks.settleBounty(request);
    assert.equal(first.status, "PAID");
    assert.equal(first.reputation_event.total_points, 1);
    const second = await tracks.settleBounty(request);
    assert.equal(second.reputation_event.total_points, 1);
    assert.equal(second.reputation_event.replayed, true);
    assert.equal(
      (await tracks.payments.evidence()).tracks.find((row) => row.id === "social")!.verification_status,
      "LIVE_VERIFIED",
    );
    mock.setApproved(false);
    assert.equal(
      (await tracks.payments.evidence()).tracks.find((row) => row.id === "social")!.verification_status,
      "UNVERIFIED",
    );
  } finally {
    await cleanup(dir);
  }
});

test("security policy refuses unsafe transfers and produces only an unsigned wallet plan", async () => {
  const dir = await tempDir();
  try {
    const mock = mockProvider();
    const tracks = new LiveTracks(liveConfig(dir), mock.client);
    const input = {
      sender_account: "buyer.near",
      recipient_account: "seller.near",
      token_account: TOKEN,
      amount_atomic: "1000000",
      spending_limit_atomic: "1000000",
      allowed_recipients: ["seller.near"],
      killed: false,
    };
    await assert.rejects(() => tracks.transferPlan({ ...input, killed: true }), /policy blocks/);
    await assert.rejects(() => tracks.transferPlan({ ...input, allowed_recipients: ["other.near"] }), /policy blocks/);
    await assert.rejects(() => tracks.transferPlan({ ...input, amount_atomic: "1000001" }), /policy blocks/);
    assert.equal(mock.calls.length, 0, "Denied requests never reach a provider or wallet boundary");
    mock.setRegistered(false);
    await assert.rejects(() => tracks.transferPlan(input), /register token storage/);
    mock.setRegistered(true);
    const plan = await tracks.transferPlan(input);
    assert.equal(plan.signed, false);
    assert.equal(plan.status, "AWAITING_WALLET_APPROVAL");
    assert.equal(plan.transaction.actions[0]!.params.methodName, "ft_transfer");
    assert.equal(plan.transaction.actions[0]!.params.deposit, "1");
    assert.ok(mock.calls.every((method) => ["status", "query"].includes(method)));
  } finally {
    await cleanup(dir);
  }
});

test("unknown live operations and demo mode fail without a fallback", async () => {
  const dir = await tempDir();
  try {
    const mock = mockProvider();
    await assert.rejects(() => runLiveWorkflow(liveConfig(dir), "sign", {}, mock.client), /Unknown live workflow/);
    await assert.rejects(() => new LiveTracks(testConfig(dir), mock.client).createInvoice({}), /demo mode/);
    assert.equal(mock.calls.length, 0);
  } finally {
    await cleanup(dir);
  }
});

test("live stores reject malformed records and demo data before contacting a provider", async () => {
  const dir = await tempDir();
  try {
    const mock = mockProvider();
    const tracks = new LiveTracks(liveConfig(dir), mock.client);
    await tracks.payments.initialize();
    const folder = path.join(dir, "mainnet");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "invoices.json"), "[{}]");
    await assert.rejects(() => tracks.settleInvoice({ reference: "invoice-1", transfer: proof }), /store is invalid/);
    await fs.writeFile(path.join(folder, "payments.json"), "[{}]");
    await assert.rejects(() => tracks.payments.payments(), /store is invalid/);
    assert.equal(mock.calls.length, 0);
  } finally {
    await cleanup(dir);
  }
  const demoDir = await tempDir();
  try {
    const mock = mockProvider();
    const { TaskStore } = await import("../src/state/store.js");
    await new TaskStore(testConfig(demoDir)).init();
    await assert.rejects(
      () => new LiveTracks(liveConfig(demoDir), mock.client).createInvoice({}),
      /mode|simulation|live/i,
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    await cleanup(demoDir);
  }
});
