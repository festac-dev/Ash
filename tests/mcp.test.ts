import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpMarketAdapter } from "../src/market/mcp-adapter.js";
import { tempDir, cleanup, testConfig } from "./helpers.js";

test("live MCP adapter discovers buyer tools and maps documented calls", async () => {
  const dir = await tempDir();
  const server = new Server({ name: "fake-market", version: "8.0.0" }, { capabilities: { tools: {} } });
  const tools = [
    { name: "marketplace__whoami", description: "who", inputSchema: { type: "object", properties: {} } },
    {
      name: "marketplace__browse_agents",
      description: "browse",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
    },
    {
      name: "marketplace__get_agent",
      description: "agent",
      inputSchema: { type: "object", properties: { agent_id: { type: "string" } } },
    },
    {
      name: "marketplace__prepare_job",
      description: "hire",
      inputSchema: {
        type: "object",
        properties: {
          worker_agent_id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          client_request_id: { type: "string" },
          token: { type: "string" },
        },
        required: ["worker_agent_id", "title", "description", "client_request_id"],
      },
    },
    {
      name: "marketplace__get_draft_status",
      description: "draft",
      inputSchema: { type: "object", properties: { draft_id: { type: "string" } } },
    },
    {
      name: "marketplace__get_job_status",
      description: "status",
      inputSchema: { type: "object", properties: { job_id: { type: "string" } } },
    },
    {
      name: "marketplace__get_job_result",
      description: "result",
      inputSchema: { type: "object", properties: { job_id: { type: "string" }, offset: { type: "number" } } },
    },
    {
      name: "marketplace__accept_result",
      description: "accept",
      inputSchema: { type: "object", properties: { job_id: { type: "string" }, assignment_id: { type: "string" } } },
    },
    { name: "marketplace__withdraw_funds", description: "never call", inputSchema: { type: "object", properties: {} } },
  ];
  const calls: string[] = [];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push(request.params.name);
    const name = request.params.name;
    const respond = (payload: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
    });
    switch (name) {
      case "marketplace__whoami":
        return respond({
          marketplace: "fake",
          user: { handle: "buyer", email_verified: true },
          account: { id: "acct_1", balances: { usdc: "50.000000", credit_usd: "0.000000" }, verification: "verified" },
          server: { version: "8.0.0" },
        });
      case "marketplace__browse_agents":
        return respond({
          agents: [
            {
              agent_id: "agent_1",
              handle: "agent-one",
              name: "Agent One",
              description: "Security review",
              price: "12.00",
              price_token: "USD",
              payable_with: ["USDC"],
              delivered_jobs: 20,
              success_rate: 95,
            },
          ],
        });
      case "marketplace__prepare_job":
        return respond({
          draft_id: "draft_1",
          approval_url: "https://market.near.ai/jobs/draft_1",
          quoted_price: "12.00",
          payable_with: ["USDC"],
        });
      case "marketplace__get_draft_status":
        return respond({ job_id: "job_1", job_url: "https://market.near.ai/jobs/job_1", funded: true });
      case "marketplace__get_job_status":
        return respond({
          status: "in_progress",
          worker_state: "delivered — awaiting your review",
          result_available: true,
          assignment_id: "assign_1",
        });
      case "marketplace__get_job_result":
        return respond({
          status: "delivered",
          content_chunk: "A complete deliverable",
          assignment_id: "assign_1",
          awaiting_acceptance: true,
        });
      case "marketplace__accept_result":
        return respond({
          action_required: true,
          job_url: "https://market.near.ai/jobs/job_1",
          assignment_id: "assign_1",
        });
      default:
        throw new Error(`unexpected tool ${name}`);
    }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const config = testConfig(dir, {
      ASH_DEMO: "1",
      ASH_SIMULATE: "false",
      ASH_MODEL_PROVIDER: "none",
      MARKET_API_TOKEN: "aat_test_token_1234567890",
    });
    const market = new McpMarketAdapter(config, { client });
    const info = await market.connect();
    assert.equal(info.mode, "live");
    assert.equal(info.server_version, "8.0.0");
    assert.equal(info.capabilities.buyer, true);
    assert.equal(info.capabilities.tools.includes("withdraw_funds"), false);

    const who = await market.whoami();
    assert.equal(who.user_handle, "buyer");
    assert.equal(who.account?.balances.USDC, "50.00");
    const agents = await market.browseAgents({ query: "security", limit: 5 });
    assert.equal(agents[0]?.id, "agent_1");
    assert.deepEqual(agents[0]?.payable_with, ["USDC"]);

    const draft = await market.prepareJob({
      worker_agent_id: "agent_1",
      title: "Review",
      description: "Review the deliverable against the criteria.",
      client_request_id: "req_1",
      token: "USDC",
    });
    assert.equal(draft.state, "draft");
    assert.equal(draft.state === "draft" ? draft.quoted_price : null, "12.00");
    const funded = await market.getDraftStatus({ draftId: "draft_1" });
    assert.equal(funded.state, "funded");
    assert.equal(funded.job_id, "job_1");
    const status = await market.getJobStatus("job_1");
    assert.equal(status.result_available, true);
    const result = await market.getJobResult("job_1");
    assert.equal(result.status, "delivered");
    assert.equal(result.content, "A complete deliverable");
    const accept = await market.acceptResult("job_1", "assign_1");
    assert.equal(accept.action_required, true);
    assert.match(accept.job_url, /^https:\/\/market\.near\.ai\//);
    assert.ok(calls.includes("marketplace__prepare_job"));
    assert.equal(calls.includes("marketplace__withdraw_funds"), false);
    await market.disconnect();
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await cleanup(dir);
  }
});

test("pro create_job refuses unbounded charges before making any network call", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig(dir, { ASH_MARKET_MODE: "pro", ASH_ALLOW_IN_CALL_SPEND: "true" });
    const market = new McpMarketAdapter(config);
    await assert.rejects(
      () =>
        market.createJob({
          worker_agent_id: "agent",
          title: "Review",
          description: "Review the requested deliverable",
          client_request_id: "request",
          token: "USDC",
        }),
      /binding price ceiling/,
    );
    await assert.rejects(() => market.awardBid("job", "bid"), /binding price ceiling/);
  } finally {
    await cleanup(dir);
  }
});

test("MCP pagination preserves whitespace and flags an unfinished response", async () => {
  const dir = await tempDir();
  try {
    const market = new McpMarketAdapter(testConfig(dir));
    let calls = 0;
    market["call"] = async () => ({
      status: "delivered",
      content_chunk: calls++ === 0 ? "hello " : " world\n",
      next_offset: calls === 1 ? 6 : null,
    });
    assert.equal((await market.getJobResult("job")).content, "hello  world\n");
    calls = 0;
    market["call"] = async () => ({ status: "delivered", content_chunk: "part", next_offset: ++calls });
    const partial = await market.getJobResult("job");
    assert.equal(partial.truncated, true);
    assert.equal(calls, 80);
  } finally {
    await cleanup(dir);
  }
});

test("MCP refuses to return a partial file as a complete artifact", async () => {
  const dir = await tempDir();
  try {
    const market = new McpMarketAdapter(testConfig(dir));
    market["tools"].set("get_file", {
      name: "get_file",
      base: "get_file",
      inputSchema: { type: "object", properties: { file_id: {} } },
    });
    market["call"] = async () => ({ content_base64: "eA==", next_offset: 1 });
    await assert.rejects(() => market.getFile("file"), /pagination was incomplete/);
  } finally {
    await cleanup(dir);
  }
});

test("MCP rejects malformed base64 and changing file identity", async () => {
  const dir = await tempDir();
  try {
    const market = new McpMarketAdapter(testConfig(dir));
    market["tools"].set("get_file", {
      name: "get_file",
      base: "get_file",
      inputSchema: { type: "object", properties: { file_id: {} } },
    });
    for (const content of ["???", "eA==garbage", "eB=="]) {
      market["call"] = async () => ({ content_base64: content });
      await assert.rejects(() => market.getFile("file"), /malformed base64/);
    }
    let calls = 0;
    market["call"] = async () => ({
      content_base64: "eA==",
      filename: `version-${calls++}`,
      next_offset: calls === 1 ? 1 : null,
    });
    await assert.rejects(() => market.getFile("file"), /changed during pagination/);
  } finally {
    await cleanup(dir);
  }
});
