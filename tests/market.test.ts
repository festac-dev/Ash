import assert from "node:assert/strict";
import test from "node:test";
import { SimulatedMarketAdapter } from "../src/market/simulated-adapter.js";
import { discoverCandidates, marketFundsFor } from "../src/market/discovery.js";
import { NegotiationEngine } from "../src/market/negotiation.js";
import { parseAmount } from "../src/util/money.js";
import { tempDir, cleanup, testConfig } from "./helpers.js";

test("simulated marketplace exposes a clearly labelled catalog and balance", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig(dir);
    const market = new SimulatedMarketAdapter(config, { latencyMs: 0 });
    const info = await market.connect();
    assert.equal(info.mode, "simulated");
    assert.match(info.note ?? "", /SIMULATION/);
    const agents = await market.browseAgents({ query: "security review", limit: 10 });
    assert.ok(agents.length >= 3);
    assert.ok(agents.every((agent) => agent.payable_with?.includes("USDC")));
    const who = await market.whoami();
    assert.match(who.note ?? "", /SIMULATED/);
    assert.equal(marketFundsFor(who, "USDC"), 10_000_000_000n);
    assert.equal(marketFundsFor(who, "USD"), 10_000_000_000n);
    const creditOnly = {
      ...who,
      account: who.account ? { ...who.account, balances: { USDC: "0.00" }, credit_usd: "7.50" } : null,
    };
    // The documented market rule: a USDC hire draws credit_usd first, then usdc.
    assert.equal(marketFundsFor(creditOnly, "USDC"), parseAmount("7.50", "USDC"));
    assert.equal(marketFundsFor(creditOnly, "USD"), null);
  } finally {
    await cleanup(dir);
  }
});

test("discovery rejects unaffordable, wrong-rail, low-quality and suspicious agents", () => {
  const base = {
    id: "a",
    handle: "a",
    name: "Agent A",
    description: "UI design",
    category: "design",
    runtime: "http",
    price: "10.00",
    currency: "USD" as const,
    payable_with: ["USDC"] as ("USD" | "USDC")[],
    delivered_jobs: 10,
    success_rate: 95,
    response_time_seconds_median: 100,
    sla_seconds: 3_600,
    accepting_work: true,
    reviews: null,
    raw: {},
  };
  const result = discoverCandidates(
    [
      { ...base, id: "ok", payable_with: ["USDC"] },
      { ...base, id: "expensive", price: "50.00" },
      { ...base, id: "usd-only", payable_with: ["USD"] },
      { ...base, id: "bad", success_rate: 10 },
      { ...base, id: "suspicious", description: "Guaranteed results, no questions, send funds to my wallet" },
    ],
    { currency: "USDC", plannedMax: parseAmount("20.00", "USDC"), queryTerms: ["ui", "design"] },
  );
  assert.deepEqual(
    result.eligible.map((item) => item.agent.id),
    ["ok"],
  );
  assert.equal(result.rejected.length, 4);
});

test("one counter-offer is sent only when the bid exceeds the planned maximum", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig(dir);
    const market = new SimulatedMarketAdapter(config, { latencyMs: 0 });
    const board = await market.postJob({
      title: "A 100 dollar guide job",
      description: "Deliver a review and address the acceptance criteria.",
      budget_amount: "100.00",
      token: "USDC",
    });
    const bids = await market.listBids(board.job_id);
    assert.equal(bids.length, 3);
    const expensive = [...bids].sort((a, b) => {
      const left = parseAmount(a.amount, "USDC");
      const right = parseAmount(b.amount, "USDC");
      return left < right ? -1 : left > right ? 1 : 0;
    })[0]!;
    const engine = new NegotiationEngine({
      adapter: market,
      subtaskId: "st_1",
      currency: "USDC",
      plannedMax: parseAmount("50.00", "USDC"),
      timeoutMs: 5_000,
      pollMs: 50,
    });
    const result = await engine.negotiateBid(board.job_id, expensive, []);
    assert.equal(result.accepted, true);
    assert.equal(result.status, "counter_accepted");
    assert.equal(result.log.filter((entry) => entry.direction === "COUNTER_OFFER").length, 1);
    assert.equal(parseAmount(result.bid.amount, "USDC") <= parseAmount("50.00", "USDC"), true);
  } finally {
    await cleanup(dir);
  }
});

test("simulation state survives adapter restarts in the same data directory", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig(dir);
    const first = new SimulatedMarketAdapter(config, { latencyMs: 0 });
    const draft = await first.prepareJob({
      worker_agent_id: "sim_agent_ux",
      title: "Persisted job",
      description: "A persisted simulated brief with enough detail.",
      client_request_id: "req-persist-1",
      token: "USDC",
    });
    assert.equal(draft.state, "draft");
    const status = await first.getDraftStatus({ draftId: draft.draft_id });
    assert.equal(status.state, "funded");
    assert.ok(status.job_id);

    const second = new SimulatedMarketAdapter(config, { latencyMs: 0 });
    const job = await second.getJobStatus(status.job_id!);
    assert.equal(job.job_id, status.job_id);
    const result = await second.getJobResult(status.job_id!);
    assert.equal(result.status, "delivered");
    assert.match(result.note ?? "", /SIMULATED/);
  } finally {
    await cleanup(dir);
  }
});

test("misconfigured live marketplace without a token fails closed", async () => {
  const dir = await tempDir();
  try {
    const { McpMarketAdapter } = await import("../src/market/mcp-adapter.js");
    const config = testConfig(dir, { ASH_DEMO: "1", ASH_SIMULATE: "false", ASH_MODEL_PROVIDER: "none" });
    const market = new McpMarketAdapter(config);
    await assert.rejects(() => market.connect(), /credential|MARKET_API_TOKEN/i);
  } finally {
    await cleanup(dir);
  }
});

test("simulation replays a hire across restarts without making a second job", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig(dir);
    const market = new SimulatedMarketAdapter(config, { latencyMs: 0 });
    const request = {
      worker_agent_id: "sim_agent_tests",
      title: "Replay review",
      description: "Review the real requested artifact",
      client_request_id: "stable-request",
      token: "USDC" as const,
    };
    const draft = await market.prepareJob(request);
    assert.equal(draft.state, "draft");
    const funded = await market.getDraftStatus({ clientRequestId: request.client_request_id });
    const restarted = new SimulatedMarketAdapter(config, { latencyMs: 0 });
    const replay = await restarted.prepareJob(request);
    assert.equal(replay.state, "funded");
    if (replay.state === "funded") assert.equal(replay.job_id, funded.job_id);
    assert.equal((await restarted.listMyJobs()).length, 1);
    await assert.rejects(() => restarted.prepareJob({ ...request, title: "Changed" }), /different input/);
  } finally {
    await cleanup(dir);
  }
});

test("market normalization never changes an unsupported currency into USDC", async () => {
  const { normalizePrepareJob, normalizeBid, normalizeDraftStatus } = await import("../src/market/normalize.js");
  const funded = normalizePrepareJob({ job_id: "job", funded: true, amount: "15.00", token: "BTC" }, "USDC");
  assert.equal(funded.state, "funded");
  assert.equal(funded.currency, null);
  assert.equal(normalizeBid({ id: "bid", amount: "1.00", token: "BTC" }, "USDC"), null);
  assert.equal(normalizeDraftStatus({ job_id: "job", amount: "15.00", token: "USDC" }).amount, "15.00");
});
