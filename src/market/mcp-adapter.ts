import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { AshError, errorMessage } from "../errors.js";
import type { AppConfig } from "../config.js";
import { APP_NAME, APP_VERSION } from "../version.js";
import { logger } from "../logger.js";
import { RateLimiter, withRetries } from "../util/async.js";
import { hashJson } from "../util/json.js";
import { containsSecretLike, redact } from "../util/redact.js";
import { clip } from "../util/strings.js";
import type { Currency } from "../util/money.js";
import { parseAmount } from "../util/money.js";
import { assertMarketToolAllowed, assertSpendToolAllowed } from "../security/guard.js";
import type {
  ActionRequired,
  AwardBidResult,
  BrowseAgentsInput,
  DraftStatus,
  JobBid,
  JobResult,
  JobStatus,
  JobSummary,
  MarketAdapter,
  MarketAgent,
  MarketCapabilities,
  MarketConnectionInfo,
  MessageWorkerInput,
  PostJobInput,
  PostJobResult,
  PrepareJobFunded,
  PrepareJobInput,
  PrepareJobResult,
  WhoAmI,
} from "./types.js";
import {
  asRecord,
  normalizeActionRequired,
  normalizeAgent,
  normalizeBid,
  normalizeDraftStatus,
  normalizeJobResult,
  normalizeJobStatus,
  normalizeJobSummary,
  normalizePostJob,
  normalizePrepareJob,
  normalizeWhoAmI,
  pickString,
} from "./normalize.js";

interface McpTool {
  name: string;
  base: string;
  inputSchema: { type: "object"; properties?: Record<string, object>; required?: string[] };
}

const MAX_RESULT_BYTES = 5 * 1024 * 1024;

export class McpMarketAdapter implements MarketAdapter {
  readonly mode = "live" as const;
  readonly endpoint: string;
  private readonly config: AppConfig;
  private readonly limiter: RateLimiter;
  private client: Client | null = null;
  private tools = new Map<string, McpTool>();
  private caps: MarketCapabilities = emptyCapabilities();
  private connection: MarketConnectionInfo | null = null;
  private connecting: Promise<MarketConnectionInfo> | null = null;
  private readonly injectedClient: Client | null;

  constructor(config: AppConfig, options: { client?: Client } = {}) {
    this.config = config;
    this.endpoint = config.market.mcpUrl;
    this.limiter = new RateLimiter(config.market.rateLimitPerMinute);
    this.injectedClient = options.client ?? null;
  }

  capabilities(): MarketCapabilities {
    return this.caps;
  }

  async connect(): Promise<MarketConnectionInfo> {
    if (!this.connecting)
      this.connecting = this.connectOnce().finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private async connectOnce(): Promise<MarketConnectionInfo> {
    if (this.connection) return this.connection;
    if (!this.config.market.apiToken) {
      throw new AshError("MARKET_AUTH_REQUIRED", "No marketplace credential is configured.", {
        hint: "Authorize an MCP client with the market's OAuth consent flow, then set MARKET_API_TOKEN (or MARKET_API_TOKEN_FILE) to the bearer token.",
      });
    }
    if (
      !this.config.market.apiToken.startsWith("aat_") &&
      !this.config.market.apiToken.includes(".") &&
      this.config.market.apiToken.length < 20
    ) {
      throw new AshError("MARKET_AUTH_REQUIRED", "MARKET_API_TOKEN does not look like a valid bearer token.");
    }

    const transport = this.injectedClient
      ? null
      : new StreamableHTTPClientTransport(new URL(this.endpoint), {
          requestInit: {
            headers: {
              Authorization: `Bearer ${this.config.market.apiToken}`,
              "User-Agent": `${APP_NAME.replace(/\s+/g, "-")}/${APP_VERSION}`,
            },
          },
        });
    const client = this.injectedClient ?? new Client({ name: "ash", version: APP_VERSION }, { capabilities: {} });
    try {
      if (transport) {
        await withTimeout(client.connect(transport), this.config.market.timeoutMs + 5_000, "Marketplace connection");
      }
      this.client = client;
      await this.loadTools(client);
      const serverVersion = client.getServerVersion();
      this.caps = capabilitiesFromTools(this.tools, serverVersion?.version ?? null, client.getInstructions() ?? null);
      this.connection = {
        connected: true,
        mode: "live",
        endpoint: this.endpoint,
        server_version: serverVersion?.version ?? null,
        tool_count: this.tools.size,
        capabilities: this.caps,
        note: this.caps.buyer
          ? "Buyer tools are available. Standard /mcp mode requires human approval on the market page for hires and acceptances."
          : "Connected, but no buyer hiring tools were advertised. Check that the token was authorized as the person, not an agent.",
      };
      await logger.audit("market.connected", {
        endpoint: this.endpoint,
        server_version: serverVersion?.version ?? null,
        tool_count: this.tools.size,
        buyer: this.caps.buyer,
        tools: [...this.tools.keys()],
      });
      return this.connection;
    } catch (error) {
      await client.close().catch(() => undefined);
      this.client = null;
      const wrapped = wrapConnectionError(error);
      logger.error("Marketplace connection failed", { error: redact(wrapped.message), code: wrapped.code });
      throw wrapped;
    }
  }

  async whoami(): Promise<WhoAmI> {
    const raw = await this.call("whoami", {});
    return normalizeWhoAmI(raw, "USDC");
  }

  async browseAgents(input: BrowseAgentsInput): Promise<MarketAgent[]> {
    const args: Record<string, unknown> = {};
    if (input.query?.trim()) args.query = clip(input.query.trim(), 200);
    if (input.category?.trim()) args.category = clip(input.category.trim(), 100);
    args.limit = Math.min(50, Math.max(1, input.limit ?? 20));
    const raw = await this.call("browse_agents", args);
    const record = asRecord(raw);
    const rows = Array.isArray(raw) ? raw : Array.isArray(record.agents) ? record.agents : [];
    const agents: MarketAgent[] = [];
    for (const row of rows) {
      try {
        agents.push(normalizeAgent(row, "USDC"));
      } catch (error) {
        logger.warn("Ignoring malformed marketplace agent row", { error: redact(errorMessage(error)) });
      }
    }
    return agents;
  }

  async getAgent(idOrHandle: string): Promise<MarketAgent> {
    const raw = await this.call("get_agent", { agent_id: idOrHandle, handle: idOrHandle });
    const record = asRecord(raw);
    const agent = asRecord(record.agent ?? raw);
    return normalizeAgent(agent, "USDC");
  }

  async prepareJob(input: PrepareJobInput): Promise<PrepareJobResult> {
    this.validateBrief(input.title, input.description);
    const args: Record<string, unknown> = {
      worker_agent_id: input.worker_agent_id,
      title: clip(input.title, 160),
      description: clip(input.description, 8_000),
      client_request_id: input.client_request_id,
      token: input.token,
      acceptance_window_days: input.acceptance_window_days,
    };
    const raw = await this.call("prepare_job", args, {
      idempotent: true,
      mustSupport: ["worker_agent_id", "title", "description", "client_request_id", ...(input.token ? ["token"] : [])],
    });
    const result = normalizePrepareJob(raw, input.token ?? "USDC");
    if (result.state === "draft" && !result.approval_url) {
      throw new AshError(
        "MARKET_PROTOCOL_ERROR",
        "The marketplace created a draft without an approval URL, so Ash cannot hand you a safe approval link.",
      );
    }
    return result;
  }

  async createJob(_input: PrepareJobInput): Promise<PrepareJobFunded> {
    throw new AshError(
      "UNSAFE_OPERATION",
      "create_job has no supported binding price ceiling. Use prepare_job and approve the final price on the marketplace page.",
    );
  }

  async getDraftStatus(input: { draftId?: string; clientRequestId?: string }): Promise<DraftStatus> {
    const tool = this.tools.get("get_draft_status");
    if (!tool) {
      throw new AshError(
        "MARKET_CAPABILITY_MISSING",
        "This marketplace does not expose get_draft_status; replay prepare_job to check the draft.",
      );
    }
    const props = tool.inputSchema.properties ?? {};
    const args: Record<string, unknown> = {};
    if (input.draftId && "draft_id" in props) args.draft_id = input.draftId;
    if (input.clientRequestId && "client_request_id" in props) args.client_request_id = input.clientRequestId;
    if (Object.keys(args).length === 0) {
      throw new AshError("MARKET_PROTOCOL_ERROR", "get_draft_status has no usable identifier parameter.");
    }
    const raw = await this.call("get_draft_status", args, { idempotent: true });
    return normalizeDraftStatus(raw);
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const raw = await this.call("get_job_status", { job_id: jobId }, { idempotent: true });
    return normalizeJobStatus(raw, jobId);
  }

  async waitForJob(
    jobId: string,
    cursor?: string | null,
    waitSeconds = 20,
  ): Promise<JobStatus & { cursor: string | null; changed: boolean }> {
    const seconds = Math.min(90, Math.max(1, waitSeconds));
    const raw = await this.call(
      "wait_for_job",
      { job_id: jobId, ...(cursor ? { cursor } : {}), wait_seconds: seconds },
      { idempotent: true, timeoutMs: (seconds + 15) * 1_000 },
    );
    const record = asRecord(raw);
    const status = normalizeJobStatus(raw, jobId);
    return {
      ...status,
      cursor: pickString(record, ["cursor"]),
      changed: record.changed === true,
    };
  }

  async getJobResult(jobId: string, assignmentId?: string | null): Promise<JobResult> {
    let combined = "";
    let first: JobResult | null = null;
    let offset: number | null = null;
    for (let page = 0; page < 80; page += 1) {
      const args: Record<string, unknown> = { job_id: jobId };
      if (offset !== null) args.offset = offset;
      if (assignmentId) args.assignment_id = assignmentId;
      const raw = await this.call("get_job_result", args, { idempotent: true });
      const result = normalizeJobResult(raw);
      if (first && (result.version !== first.version || result.assignment_id !== first.assignment_id)) {
        throw new AshError(
          "MARKET_PROTOCOL_ERROR",
          "Deliverable changed during pagination; retry the complete download.",
        );
      }
      first ??= result;
      if (result.status !== "delivered") {
        return result;
      }
      combined += result.content ?? "";
      if (Buffer.byteLength(combined, "utf8") > MAX_RESULT_BYTES) {
        return {
          ...result,
          content: Buffer.from(combined).subarray(0, MAX_RESULT_BYTES).toString("utf8"),
          truncated: true,
          note: "Deliverable exceeded the safety limit and was truncated.",
        };
      }
      const next = asRecord(raw).next_offset;
      if (next === undefined || next === null) break;
      if (!Number.isSafeInteger(next) || Number(next) <= (offset ?? -1) || page === 79) {
        return { ...first, content: combined, truncated: true, note: "Deliverable pagination was incomplete." };
      }
      offset = Number(next);
    }
    if (!first) throw new AshError("MARKET_PROTOCOL_ERROR", "The marketplace returned no deliverable result.");
    return { ...first, content: combined };
  }

  async getFile(fileId: string): Promise<{ bytes: Buffer; filename: string | null; sha256: string | null }> {
    const tool = this.tools.get("get_file");
    if (!tool) {
      throw new AshError("MARKET_CAPABILITY_MISSING", "This marketplace deployment does not expose get_file.");
    }
    const props = tool.inputSchema.properties ?? {};
    const fileKey = "file" in props ? "file" : "file_id" in props ? "file_id" : null;
    if (!fileKey) throw new AshError("MARKET_PROTOCOL_ERROR", "get_file has no file identifier parameter.");
    const chunks: Buffer[] = [];
    let offset: number | null = null;
    let total = 0;
    let filename: string | null = null;
    let expectedHash: string | null = null;
    for (let page = 0; page < 200; page += 1) {
      const args: Record<string, unknown> = { [fileKey]: fileId };
      if (offset !== null) args.offset = offset;
      const raw = asRecord(await this.call("get_file", args, { idempotent: true }));
      const base64 = pickString(raw, ["content_base64", "content"]);
      if (!base64) throw new AshError("MARKET_PROTOCOL_ERROR", "get_file returned no base64 content.");
      if (base64.length > 8_000_000)
        throw new AshError("VALIDATION_FAILED", "get_file chunk exceeds the safety limit.");
      const chunk = Buffer.from(base64, "base64");
      const encoded = base64.replace(/\s/g, "");
      if (
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
        encoded.replace(/=+$/, "") !== chunk.toString("base64").replace(/=+$/, "")
      ) {
        throw new AshError("MARKET_PROTOCOL_ERROR", "get_file returned malformed base64 content.");
      }
      total += chunk.byteLength;
      if (total > MAX_RESULT_BYTES)
        throw new AshError("VALIDATION_FAILED", "Delivered file exceeds the 5 MiB safety limit.");
      chunks.push(chunk);
      const nextFilename = pickString(raw, ["filename"]);
      const nextHash = pickString(raw, ["sha256"]);
      if (
        (filename && nextFilename && filename !== nextFilename) ||
        (expectedHash && nextHash && expectedHash.toLowerCase() !== nextHash.toLowerCase())
      ) {
        throw new AshError("MARKET_PROTOCOL_ERROR", "Delivered file changed during pagination.");
      }
      filename ??= nextFilename;
      expectedHash ??= nextHash;
      const next = raw.next_offset;
      if (next === undefined || next === null) break;
      if (!Number.isSafeInteger(next) || Number(next) <= (offset ?? -1) || page === 199) {
        throw new AshError("MARKET_PROTOCOL_ERROR", "Delivered file pagination was incomplete.");
      }
      offset = Number(next);
    }
    const bytes = Buffer.concat(chunks);
    if (expectedHash) {
      const { sha256Hex } = await import("../util/json.js");
      if (sha256Hex(bytes) !== expectedHash.toLowerCase()) {
        throw new AshError("VERIFICATION_FAILED", "Delivered file failed its SHA-256 integrity check.");
      }
    }
    return { bytes, filename, sha256: expectedHash };
  }

  async acceptResult(jobId: string, assignmentId?: string | null): Promise<ActionRequired> {
    const raw = await this.call("accept_result", {
      job_id: jobId,
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
    });
    const action = normalizeActionRequired(raw, "USDC");
    await logger.audit("market.acceptance_link", {
      job_id: jobId,
      job_url: action.job_url,
      assignment_id: action.assignment_id,
    });
    return action;
  }

  async requestChanges(
    jobId: string,
    feedback: string,
    assignmentId?: string | null,
  ): Promise<Record<string, unknown>> {
    if (!feedback.trim()) throw new AshError("VALIDATION_FAILED", "Revision feedback cannot be empty.");
    const raw = await this.call("request_changes", {
      job_id: jobId,
      feedback: clip(feedback, 10_000),
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
    });
    return asRecord(raw);
  }

  async cancelJob(jobId: string): Promise<Record<string, unknown>> {
    return asRecord(await this.call("cancel_job", { job_id: jobId }));
  }

  async messageWorker(input: MessageWorkerInput): Promise<Record<string, unknown>> {
    if (!input.body.trim()) throw new AshError("VALIDATION_FAILED", "Message cannot be empty.");
    if (containsSecretLike(input.body)) {
      throw new AshError("UNSAFE_INPUT", "Refusing to send a message that looks like it contains a credential.");
    }
    const args: Record<string, unknown> = {
      job_id: input.job_id,
      body: clip(input.body, 4_000),
    };
    if (input.bid_id) {
      args.bid_id = input.bid_id;
    } else {
      if (input.client_request_id) args.client_request_id = input.client_request_id;
      if (input.assignment_id) args.assignment_id = input.assignment_id;
    }
    return asRecord(
      await this.call("message_worker", args, {
        idempotent: !input.bid_id && Boolean(input.client_request_id),
        mustSupport: !input.bid_id && input.client_request_id ? ["client_request_id"] : [],
      }),
    );
  }

  async postJob(input: PostJobInput): Promise<PostJobResult> {
    this.validateBrief(input.title, input.description);
    if (input.budget_amount) parseAmount(input.budget_amount, input.token ?? "USDC");
    const raw = await this.call("post_job", {
      title: clip(input.title, 160),
      description: clip(input.description, 8_000),
      ...(input.budget_amount ? { budget_amount: input.budget_amount } : {}),
      ...(input.token ? { token: input.token } : {}),
      ...(input.tags ? { tags: input.tags.slice(0, 10).map((tag) => clip(tag, 40)) } : {}),
      ...(input.max_slots ? { max_slots: Math.max(1, Math.min(20, input.max_slots)) } : {}),
      ...(input.acceptance_window_days ? { acceptance_window_days: input.acceptance_window_days } : {}),
      ...(input.min_builder_verification ? { min_builder_verification: input.min_builder_verification } : {}),
    });
    return normalizePostJob(raw);
  }

  async listBids(jobId: string): Promise<JobBid[]> {
    const raw = await this.call("list_bids", { job_id: jobId }, { idempotent: true });
    const record = asRecord(raw);
    const rows = Array.isArray(raw) ? raw : Array.isArray(record.bids) ? record.bids : [];
    return rows.map((row) => normalizeBid(row, "USDC")).filter((bid): bid is JobBid => bid !== null);
  }

  async awardBid(jobId: string, bidId: string): Promise<AwardBidResult> {
    if (this.config.market.mode === "pro") {
      throw new AshError(
        "UNSAFE_OPERATION",
        "Pro award_bid can charge without a binding price ceiling. Use standard mode and the marketplace award page.",
      );
    }
    const raw = await this.call("award_bid", { job_id: jobId, bid_id: bidId });
    const action = normalizeActionRequired(raw, "USDC");
    return {
      action_required: action.action_required,
      job_url: action.job_url,
      amount: action.amount,
      currency: action.currency,
      raw: action.raw,
    };
  }

  async listMyJobs(limit = 20): Promise<JobSummary[]> {
    const raw = await this.call("list_my_jobs", { limit: Math.max(1, Math.min(50, limit)) }, { idempotent: true });
    const record = asRecord(raw);
    const rows = Array.isArray(raw) ? raw : Array.isArray(record.jobs) ? record.jobs : [];
    return rows.map((row) => normalizeJobSummary(row, "USDC")).filter((job): job is JobSummary => job !== null);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => undefined);
      this.client = null;
      this.connection = null;
      this.caps = emptyCapabilities();
      this.tools = new Map();
    }
  }

  private async loadTools(client: Client): Promise<void> {
    this.tools = new Map();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : {}, { timeout: this.config.market.timeoutMs });
      for (const tool of result.tools) {
        let base: string;
        try {
          base = assertMarketToolAllowed(tool.name);
        } catch (error) {
          logger.debug("Ignoring non-buyer marketplace tool", {
            tool: tool.name,
            reason: redact(errorMessage(error)),
          });
          continue;
        }
        const previous = this.tools.get(base);
        if (!previous || (tool.name.includes("marketplace__") && !previous.name.includes("marketplace__"))) {
          this.tools.set(base, {
            name: tool.name,
            base,
            inputSchema: tool.inputSchema as McpTool["inputSchema"],
          });
        }
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor) break;
    }
  }

  private async call(
    base: string,
    desiredArgs: Record<string, unknown>,
    options: { idempotent?: boolean; timeoutMs?: number; mustSupport?: string[] } = {},
  ): Promise<unknown> {
    if (!this.client) await this.connect();
    const tool = this.tools.get(base);
    if (!tool) {
      throw new AshError(
        "MARKET_CAPABILITY_MISSING",
        `This marketplace deployment does not expose the "${base}" tool.`,
        { hint: "Run `market` to inspect the advertised buyer tools for this connection." },
      );
    }
    assertMarketToolAllowed(tool.name);
    if (base === "create_job") {
      assertSpendToolAllowed(base, this.config.market.mode, this.config.market.allowInCallSpend);
    }

    const properties = tool.inputSchema.properties ?? {};
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(desiredArgs)) {
      if (value === undefined) continue;
      if (Object.keys(properties).length === 0 || key in properties) filtered[key] = value;
    }
    for (const required of options.mustSupport ?? []) {
      if (!(required in filtered)) {
        throw new AshError(
          "MARKET_CAPABILITY_MISSING",
          `The market's "${base}" tool does not accept the required "${required}" argument. Refusing to guess.`,
        );
      }
    }
    for (const required of tool.inputSchema.required ?? []) {
      if (!(required in filtered)) {
        throw new AshError(
          "MARKET_CAPABILITY_MISSING",
          `The market's "${base}" tool requires "${required}", which Ash does not have.`,
        );
      }
    }

    const timeoutMs = options.timeoutMs ?? this.config.market.timeoutMs;
    const canRetry = options.idempotent === true;
    const started = Date.now();
    const invoke = async (): Promise<unknown> => {
      await this.limiter.take();
      try {
        const result = await this.client!.callTool({ name: tool.name, arguments: filtered }, undefined, {
          timeout: timeoutMs,
        });
        return parseToolResult(tool.base, result);
      } catch (error) {
        throw wrapCallError(error, base);
      }
    };

    let value: unknown;
    try {
      value = canRetry
        ? await withRetries(invoke, {
            attempts: Math.max(1, Math.min(this.config.market.maxRetries, 3)),
            retryable: (error) =>
              error instanceof AshError &&
              (error.code === "MARKET_UNAVAILABLE" || error.code === "RATE_LIMITED") &&
              error.retryable,
            onRetry: (error, attempt, delay) => {
              logger.warn("Marketplace call retrying", {
                tool: base,
                attempt,
                delay_ms: delay,
                error: redact(errorMessage(error)),
              });
            },
          })
        : await invoke();
    } finally {
      await logger.audit("market.call", {
        tool: base,
        duration_ms: Date.now() - started,
        args_hash: hashJson(Object.keys(filtered).sort()),
        tool_name: tool.name,
      });
    }
    return value;
  }

  private validateBrief(title: string, description: string): void {
    if (!title.trim() || title.length > 160)
      throw new AshError("VALIDATION_FAILED", "Marketplace title must be 1-160 characters.");
    if (!description.trim() || description.length > 8_000) {
      throw new AshError("VALIDATION_FAILED", "Marketplace brief must be 1-8000 characters.");
    }
    if (containsSecretLike(`${title}\n${description}`)) {
      throw new AshError(
        "UNSAFE_INPUT",
        "Refusing to send a brief that looks like it contains a credential or private key.",
      );
    }
  }
}

function parseToolResult(base: string, result: unknown): unknown {
  const record = asRecord(result);
  if (record.isError === true) {
    const text = extractText(record);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // not JSON
    }
    const refusal = asRecord(parsed);
    const code = refusal.code ?? refusal.refused ?? "unknown";
    const message =
      pickString(refusal, ["message", "error", "refused"]) ?? text ?? "The marketplace refused the operation.";
    throw new AshError("MARKET_REFUSED", `${base} refused: ${clip(message, 1_500)}`, {
      details: { code, data: asRecord(refusal.data) },
      hint: refusalHint(code, message),
    });
  }
  if (record.structuredContent && typeof record.structuredContent === "object") {
    return record.structuredContent;
  }
  if (record.toolResult !== undefined) return record.toolResult;
  const text = extractText(record);
  if (!text) {
    throw new AshError("MARKET_PROTOCOL_ERROR", `${base} returned an empty tool result.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

function extractText(record: Record<string, unknown>): string {
  const content = Array.isArray(record.content) ? record.content : [];
  return content
    .map((item) =>
      asRecord(item).type === "text" && typeof asRecord(item).text === "string" ? String(asRecord(item).text) : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function refusalHint(code: unknown, message: string): string {
  const normalized = String(code);
  if (normalized === "-32003" || /email/i.test(message)) return "Confirm the marketplace account email, then retry.";
  if (normalized === "-32006") return "Choose a currency rail listed in the agent's payable_with.";
  if (normalized === "-32005") return "The agent is paused or suspended; try another agent.";
  if (normalized === "job_deleted")
    return "The draft's job was deleted and its escrow refunded. Do not re-hire automatically.";
  return "Read the refusal above. Ash never bypasses a marketplace refusal.";
}

function wrapConnectionError(error: unknown): AshError {
  const message = redact(errorMessage(error));
  if (
    error instanceof UnauthorizedError ||
    /\b401\b|unauthori[sz]ed|invalid[_ ]token|token.*(expired|revoked)/i.test(message)
  ) {
    return new AshError("MARKET_AUTH_REQUIRED", "The marketplace rejected Ash's credential.", {
      cause: error,
      hint: "Re-authorize the MCP connection and update MARKET_API_TOKEN / MARKET_API_TOKEN_FILE.",
    });
  }
  if (/\b403\b|forbidden/i.test(message)) {
    return new AshError("MARKET_AUTH_REQUIRED", "The marketplace credential lacks permission for this connection.", {
      cause: error,
      hint: "Authorize as the person (buyer), not as an agent, and check the token's scopes.",
    });
  }
  return new AshError("MARKET_UNAVAILABLE", `Could not connect to the marketplace: ${clip(message, 800)}`, {
    cause: error,
    retryable: true,
  });
}

function wrapCallError(error: unknown, base: string): AshError {
  if (error instanceof AshError) return error;
  const message = redact(errorMessage(error));
  if (error instanceof UnauthorizedError || /\b401\b|unauthori[sz]ed/i.test(message)) {
    return new AshError("MARKET_AUTH_REQUIRED", "The marketplace credential expired or was rejected.", {
      cause: error,
      hint: "Re-authorize the MCP connection and update MARKET_API_TOKEN.",
    });
  }
  if (/\b429\b|rate.?limit/i.test(message)) {
    return new AshError("RATE_LIMITED", `The marketplace rate-limited ${base}.`, { cause: error, retryable: true });
  }
  return new AshError("MARKET_UNAVAILABLE", `${base} failed: ${clip(message, 800)}`, {
    cause: error,
    retryable: /\b(408|409|5\d\d)\b|timeout|timed out|network|fetch failed|ECONN/i.test(message),
  });
}

function capabilitiesFromTools(
  tools: Map<string, McpTool>,
  serverVersion: string | null,
  instructions: string | null,
): MarketCapabilities {
  const has = (base: string): boolean => tools.has(base);
  const board = ["post_job", "list_my_jobs", "list_bids", "award_bid", "cancel_job"].every(has);
  return {
    tools: [...tools.keys()].sort(),
    buyer: has("whoami") && has("browse_agents") && (has("prepare_job") || has("create_job") || has("post_job")),
    can_prepare_job: has("prepare_job"),
    can_create_job: false, // Disabled until a binding price ceiling is supported.
    can_board: board,
    can_accept: has("accept_result"),
    can_request_changes: has("request_changes"),
    can_cancel: has("cancel_job"),
    can_read_result: has("get_job_result"),
    can_read_files: has("get_file"),
    can_wait: has("wait_for_job"),
    can_message: has("message_worker"),
    can_award: has("award_bid"),
    server_version: serverVersion,
    instructions,
  };
}

function emptyCapabilities(): MarketCapabilities {
  return {
    tools: [],
    buyer: false,
    can_prepare_job: false,
    can_create_job: false,
    can_board: false,
    can_accept: false,
    can_request_changes: false,
    can_cancel: false,
    can_read_result: false,
    can_read_files: false,
    can_wait: false,
    can_message: false,
    can_award: false,
    server_version: null,
    instructions: null,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new AshError("MARKET_UNAVAILABLE", `${label} timed out.`, { retryable: true })),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
