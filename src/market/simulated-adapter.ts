import path from "node:path";
import { AshError } from "../errors.js";
import type { AppConfig } from "../config.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { clip } from "../util/strings.js";
import { formatMinor, parseAmount, type Currency } from "../util/money.js";
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
import { normalizeActionRequired } from "./normalize.js";
import { atomicWriteJson, ensurePrivateDir, readJsonIfExists } from "../util/fs.js";

interface SimAgentSeed {
  id: string;
  name: string;
  handle: string;
  description: string;
  price: string;
  success: number | null;
  delivered: number;
  response: number;
}

interface SimJob {
  job_id: string;
  assignment_id: string;
  agent_id: string;
  agent_name: string;
  title: string;
  description: string;
  price: string;
  currency: Currency;
  created_at: number;
  funded_at: number | null;
  delivered_at: number | null;
  accepted_at: number | null;
  completed_at: number | null;
  cancelled_at: number | null;
  revision_feedback: string | null;
  version: number;
  draft_id: string | null;
  approval_url: string | null;
  bid_id: string | null;
}

interface SimDraft {
  draft_id: string;
  job: SimJob;
  approval_url: string;
  created_at: number;
  client_request_id?: string;
  request_hash?: string;
}

interface SimBoardJob {
  job_id: string;
  title: string;
  description: string;
  budget: string;
  currency: Currency;
  created_at: number;
  bids_ready_at: number;
  bids: SimBid[];
}

interface SimBid {
  bid_id: string;
  amount: string;
  proposal: string;
  status: string;
  sla_seconds: number | null;
  bidder: { name: string; handle: string; delivered_jobs: number; reputation_overall: number };
  counter_at: number | null;
}

const AGENT_SEEDS: SimAgentSeed[] = [
  {
    id: "sim_agent_ux",
    name: "Lumen UX Lab",
    handle: "lumen-ux",
    description: "Product UI, UX systems and polished interface design.",
    price: "18.00",
    success: 96,
    delivered: 142,
    response: 480,
  },
  {
    id: "sim_agent_security",
    name: "Sentinel Security",
    handle: "sentinel-sec",
    description: "Application security review, threat modelling and secure code audit.",
    price: "24.00",
    success: 98,
    delivered: 87,
    response: 720,
  },
  {
    id: "sim_agent_tests",
    name: "Testwright",
    handle: "testwright",
    description: "Automated test suites, CI checks and quality engineering.",
    price: "14.00",
    success: 93,
    delivered: 210,
    response: 300,
  },
  {
    id: "sim_agent_research",
    name: "Atlas Research",
    handle: "atlas-research",
    description: "Market research, source verification and analyst reports.",
    price: "20.00",
    success: 91,
    delivered: 64,
    response: 900,
  },
  {
    id: "sim_agent_data",
    name: "Quanta Data",
    handle: "quanta-data",
    description: "Data collection, validation, ETL and dataset quality checks.",
    price: "16.00",
    success: 89,
    delivered: 53,
    response: 600,
  },
  {
    id: "sim_agent_budget",
    name: "QuickTask Generalist",
    handle: "quicktask",
    description: "General delivery. Guaranteed results, no questions, lowest price.",
    price: "4.00",
    success: 21,
    delivered: 2,
    response: 60,
  },
];

/**
 * Simulation-only marketplace. It never opens a socket and never spends real
 * funds. Every stage is labelled simulated in the UI and receipts.
 */
export class SimulatedMarketAdapter implements MarketAdapter {
  readonly mode = "simulated" as const;
  readonly endpoint = "simulation://near-agent-market";
  private readonly latencyMs: number;
  private readonly stateFile: string;
  private readonly drafts = new Map<string, SimDraft>();
  private readonly jobs = new Map<string, SimJob>();
  private readonly boards = new Map<string, SimBoardJob>();
  private spent = 0n;
  private loaded: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(config: AppConfig, options: { latencyMs?: number } = {}) {
    this.latencyMs = options.latencyMs ?? 2_000;
    this.stateFile = path.join(config.dataDir, "cache", "sim-market.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        const raw = await readJsonIfExists<Record<string, unknown>>(this.stateFile);
        if (!raw) return;
        try {
          this.spent = BigInt(String(raw.spent ?? "0"));
          for (const job of (raw.jobs as SimJob[]) ?? []) this.jobs.set(job.job_id, job);
          for (const draft of (raw.drafts as SimDraft[]) ?? []) {
            draft.job = this.jobs.get(draft.job.job_id) ?? draft.job;
            this.drafts.set(draft.draft_id, draft);
          }
          for (const board of (raw.boards as SimBoardJob[]) ?? []) this.boards.set(board.job_id, board);
        } catch (error) {
          throw new AshError("STATE_INVALID", "Simulation marketplace cache is corrupt.", { cause: error });
        }
      })();
    }
    await this.loaded;
  }

  private async persist(): Promise<void> {
    const snapshot = {
      schema_version: 1,
      spent: this.spent.toString(),
      drafts: [...this.drafts.values()],
      jobs: [...this.jobs.values()],
      boards: [...this.boards.values()],
    };
    const write = this.writes.then(async () => {
      await ensurePrivateDir(path.dirname(this.stateFile));
      await atomicWriteJson(this.stateFile, snapshot);
    });
    this.writes = write.catch(() => undefined);
    await write;
  }

  capabilities(): MarketCapabilities {
    return {
      tools: [
        "whoami",
        "browse_agents",
        "get_agent",
        "prepare_job",
        "get_draft_status",
        "get_job_status",
        "wait_for_job",
        "get_job_result",
        "accept_result",
        "request_changes",
        "cancel_job",
        "post_job",
        "list_bids",
        "message_worker",
        "award_bid",
        "list_my_jobs",
      ],
      buyer: true,
      can_prepare_job: true,
      can_create_job: false,
      can_board: true,
      can_accept: true,
      can_request_changes: true,
      can_cancel: true,
      can_read_result: true,
      can_read_files: false,
      can_wait: true,
      can_message: true,
      can_award: true,
      server_version: "simulation-1.0",
      instructions: "SIMULATION ONLY. No network, no real agents, no real funds.",
    };
  }

  async connect(): Promise<MarketConnectionInfo> {
    await this.ensureLoaded();
    return {
      connected: true,
      mode: "simulated",
      endpoint: this.endpoint,
      server_version: "simulation-1.0",
      tool_count: this.capabilities().tools.length,
      capabilities: this.capabilities(),
      note: "SIMULATION MODE — all agents, jobs, balances and payments are fake and never leave this process.",
    };
  }

  async whoami(): Promise<WhoAmI> {
    await this.ensureLoaded();
    const balance = formatMinor(10_000n * 1_000_000n - this.spent, "USDC");
    return {
      marketplace: "simulation",
      user_handle: "simulated-human",
      email_verified: true,
      account: {
        id: "sim_account",
        handle: "simulated-human",
        verification: "identity_verified",
        balances: { USD: balance, USDC: balance },
        credit_usd: "0.00",
      },
      accounts: [],
      server_version: "simulation-1.0",
      note: "SIMULATED BALANCE — not a real marketplace account.",
      raw: { simulated: true },
    };
  }

  async browseAgents(input: BrowseAgentsInput): Promise<MarketAgent[]> {
    await this.ensureLoaded();
    const query = (input.query ?? "").toLowerCase();
    const starts = AGENT_SEEDS.map((seed, index) => {
      const relevance = query
        .split(/\s+/)
        .filter((word) => word.length > 3)
        .filter((word) => `${seed.name} ${seed.description}`.toLowerCase().includes(word)).length;
      return { seed, relevance, index };
    });
    starts.sort((a, b) => b.relevance - a.relevance || a.index - b.index);
    return starts.slice(0, Math.min(50, input.limit ?? 20)).map(({ seed }) => this.toAgent(seed));
  }

  async getAgent(idOrHandle: string): Promise<MarketAgent> {
    await this.ensureLoaded();
    const seed = AGENT_SEEDS.find((candidate) => candidate.id === idOrHandle || candidate.handle === idOrHandle);
    if (!seed) throw new AshError("NOT_FOUND", "No such simulated agent.");
    return { ...this.toAgent(seed), description: `${seed.description} SIMULATION AGENT.` };
  }

  async prepareJob(input: PrepareJobInput): Promise<PrepareJobResult> {
    await this.ensureLoaded();
    const { hashJson } = await import("../util/json.js");
    const requestHash = hashJson(input);
    const replay = [...this.drafts.values()].find((draft) => draft.client_request_id === input.client_request_id);
    if (replay) {
      if (replay.request_hash !== requestHash)
        throw new AshError("CONFLICT", "A simulated hire request id was reused with different input.");
      if (replay.job.cancelled_at !== null) throw new AshError("MARKET_REFUSED", "This simulated job was cancelled.");
      if (replay.job.funded_at !== null)
        return {
          state: "funded",
          job_id: replay.job.job_id,
          assignment_id: replay.job.assignment_id,
          job_url: `https://simulation.ash.invalid/job/${replay.job.job_id}`,
          funded: true,
          amount: replay.job.price,
          currency: replay.job.currency,
          raw: { simulated: true },
        };
      return {
        state: "draft",
        draft_id: replay.draft_id,
        approval_url: replay.approval_url,
        quoted_price: replay.job.price,
        currency: replay.job.currency,
        payable_with: ["USD", "USDC"],
        required_connections: [],
        replayed: true,
        raw: { simulated: true },
      };
    }
    const seed = AGENT_SEEDS.find((candidate) => candidate.id === input.worker_agent_id);
    if (!seed) throw new AshError("NOT_FOUND", "Unknown simulated agent.");
    const now = Date.now();
    const jobId = newId("simjob");
    const draftId = newId("simdraft");
    const job: SimJob = {
      job_id: jobId,
      assignment_id: newId("simassign"),
      agent_id: seed.id,
      agent_name: seed.name,
      title: input.title,
      description: input.description,
      price: formatMinor(parseAmount(seed.price, input.token ?? "USDC"), input.token ?? "USDC"),
      currency: input.token ?? "USDC",
      created_at: now,
      funded_at: null,
      delivered_at: null,
      accepted_at: null,
      completed_at: null,
      cancelled_at: null,
      revision_feedback: null,
      version: 1,
      draft_id: draftId,
      approval_url: `https://simulation.ash.invalid/approve/${draftId}`,
      bid_id: null,
    };
    this.jobs.set(jobId, job);
    this.drafts.set(draftId, {
      draft_id: draftId,
      job,
      approval_url: job.approval_url!,
      created_at: now,
      client_request_id: input.client_request_id,
      request_hash: requestHash,
    });
    await this.persist();
    return {
      state: "draft",
      draft_id: draftId,
      approval_url: job.approval_url,
      quoted_price: job.price,
      currency: job.currency,
      payable_with: ["USD", "USDC"],
      required_connections: [],
      replayed: false,
      raw: { simulated: true, draft_id: draftId, approval_url: job.approval_url, quoted_price: job.price },
    };
  }

  async createJob(): Promise<PrepareJobFunded> {
    await this.ensureLoaded();
    throw new AshError("MARKET_CAPABILITY_MISSING", "Simulation mode uses prepare_job, not create_job.");
  }

  async getDraftStatus(input: { draftId?: string; clientRequestId?: string }): Promise<DraftStatus> {
    await this.ensureLoaded();
    const draft = [...this.drafts.values()].find((candidate) =>
      input.draftId ? candidate.draft_id === input.draftId : candidate.client_request_id === input.clientRequestId,
    );
    if (!draft || draft.job.cancelled_at !== null) {
      return {
        state: "deleted",
        draft_id: input.draftId ?? null,
        job_id: null,
        job_url: null,
        approval_url: null,
        funded: false,
        raw: { simulated: true },
      };
    }
    if (Date.now() - draft.created_at >= this.latencyMs) {
      if (draft.job.funded_at === null) {
        draft.job.funded_at = Date.now();
        const stored = this.jobs.get(draft.job.job_id);
        if (stored) stored.funded_at = draft.job.funded_at;
        await this.persist();
      }
      return {
        state: "funded",
        draft_id: draft.draft_id,
        job_id: draft.job.job_id,
        job_url: `https://simulation.ash.invalid/job/${draft.job.job_id}`,
        approval_url: draft.approval_url,
        funded: true,
        amount: draft.job.price,
        currency: draft.job.currency,
        raw: { simulated: true, job_id: draft.job.job_id, funded: true },
      };
    }
    return {
      state: "draft",
      draft_id: draft.draft_id,
      job_id: null,
      job_url: null,
      approval_url: draft.approval_url,
      funded: false,
      raw: { simulated: true, draft_id: draft.draft_id },
    };
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    await this.ensureLoaded();
    const job = this.requireJob(jobId);
    const before = job.delivered_at;
    this.advance(job);
    if (job.delivered_at !== before) await this.persist();
    const resultAvailable = job.delivered_at !== null && job.accepted_at === null && job.cancelled_at === null;
    const workerState = job.cancelled_at
      ? "cancelled — no result"
      : job.completed_at
        ? "finished"
        : resultAvailable
          ? "delivered — awaiting your review"
          : job.funded_at
            ? "still working"
            : "nobody hired yet";
    return {
      job_id: job.job_id,
      status: job.cancelled_at ? "closed" : job.completed_at ? "completed" : "in_progress",
      worker_state: workerState,
      result_available: resultAvailable,
      settled: Boolean(job.completed_at || job.cancelled_at),
      amount: job.price,
      currency: job.currency,
      expected_by: new Date((job.funded_at ?? job.created_at) + 60_000).toISOString(),
      auto_accept_at: job.delivered_at ? new Date(job.delivered_at + 3 * 86_400_000).toISOString() : null,
      next_step: resultAvailable ? "Review the simulated deliverable" : null,
      assignment_id: job.assignment_id,
      assignments: [
        {
          assignment_id: job.assignment_id,
          status: workerState,
          worker_state: workerState,
          result_available: resultAvailable,
          submitted_at: job.delivered_at ? new Date(job.delivered_at).toISOString() : null,
          auto_accept_at: job.delivered_at ? new Date(job.delivered_at + 3 * 86_400_000).toISOString() : null,
          progress_report: job.funded_at && !job.delivered_at ? "Simulated worker is preparing the deliverable." : null,
          progress_percent: job.funded_at && !job.delivered_at ? 45 : null,
          raw: { simulated: true },
        },
      ],
      title: job.title,
      raw: { simulated: true, status: job.completed_at ? "completed" : "in_progress" },
    };
  }

  async waitForJob(
    jobId: string,
    cursor?: string | null,
    waitSeconds = 2,
  ): Promise<JobStatus & { cursor: string | null; changed: boolean }> {
    await this.ensureLoaded();
    await sleep(Math.min(this.latencyMs, Math.max(10, waitSeconds * 1_000)));
    const status = await this.getJobStatus(jobId);
    return { ...status, cursor: null, changed: status.result_available || status.settled };
  }

  async getJobResult(jobId: string): Promise<JobResult> {
    await this.ensureLoaded();
    const job = this.requireJob(jobId);
    const before = job.delivered_at;
    this.advance(job);
    if (job.delivered_at !== before) await this.persist();
    if (job.delivered_at === null) {
      return {
        status: "unavailable",
        content: null,
        external_url: null,
        files: [],
        assignment_id: job.assignment_id,
        awaiting_acceptance: false,
        version: null,
        note: "The simulated worker has not delivered yet.",
        bytes_total: null,
        raw: { simulated: true },
      };
    }
    const content = simulatedDeliverable(job);
    return {
      status: "delivered",
      content,
      external_url: null,
      files: [],
      assignment_id: job.assignment_id,
      awaiting_acceptance: true,
      version: job.version,
      note: "SIMULATED DELIVERABLE — no real agent produced this.",
      bytes_total: Buffer.byteLength(content, "utf8"),
      raw: { simulated: true, awaiting_acceptance: true, version: job.version },
    };
  }

  async getFile(): Promise<{ bytes: Buffer; filename: string | null; sha256: string | null }> {
    await this.ensureLoaded();
    throw new AshError("MARKET_CAPABILITY_MISSING", "Simulation mode does not provide file downloads.");
  }

  async acceptResult(jobId: string): Promise<ActionRequired> {
    await this.ensureLoaded();
    const job = this.requireJob(jobId);
    this.advance(job);
    if (job.delivered_at === null || job.accepted_at !== null || job.cancelled_at !== null) {
      throw new AshError("MARKET_REFUSED", "Nothing awaits acceptance on this simulated job.");
    }
    job.accepted_at = Date.now();
    this.spent += parseAmount(job.price, job.currency);
    await this.persist();
    const raw = {
      simulated: true,
      action_required: true,
      job_url: `https://simulation.ash.invalid/job/${job.job_id}`,
      assignment_id: job.assignment_id,
      amount: job.price,
      token: job.currency,
    };
    return normalizeActionRequired(raw, job.currency);
  }

  async requestChanges(jobId: string, feedback: string): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const job = this.requireJob(jobId);
    if (job.delivered_at === null) throw new AshError("MARKET_REFUSED", "Nothing to revise yet.");
    job.revision_feedback = clip(feedback, 2_000);
    job.delivered_at = null;
    job.version += 1;
    await this.persist();
    return { simulated: true, status: "changes_requested", version: job.version };
  }

  async cancelJob(jobId: string): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const job = this.requireJob(jobId);
    if (job.completed_at) throw new AshError("MARKET_REFUSED", "The simulated job is already completed.");
    job.cancelled_at = Date.now();
    await this.persist();
    return { simulated: true, status: "closed", refunded: job.accepted_at === null };
  }

  async messageWorker(input: MessageWorkerInput): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    if (input.bid_id) {
      const board = [...this.boards.values()].find((job) => job.bids.some((bid) => bid.bid_id === input.bid_id));
      const bid = board?.bids.find((candidate) => candidate.bid_id === input.bid_id);
      if (!board || !bid) throw new AshError("MARKET_REFUSED", "No such simulated bid.");
      const match = /(?:counter[- ]offer|offer)[:\s]+([0-9]+(?:\.[0-9]{1,6})?)\s*(USD|USDC)/i.exec(input.body);
      if (match?.[1]) {
        bid.amount = formatMinor(parseAmount(match[1], board.currency), board.currency);
        bid.status = "countered";
        bid.counter_at = Date.now();
        await this.persist();
      }
      return { simulated: true, message: "sent to simulated bidder" };
    }
    return { simulated: true, message: "sent to simulated worker" };
  }

  async postJob(input: PostJobInput): Promise<PostJobResult> {
    await this.ensureLoaded();
    const now = Date.now();
    const jobId = newId("simboard");
    const currency = input.token ?? "USDC";
    const budget = input.budget_amount ?? "20.00";
    const board: SimBoardJob = {
      job_id: jobId,
      title: input.title,
      description: input.description,
      budget: formatMinor(parseAmount(budget, currency), currency),
      currency,
      created_at: now,
      bids_ready_at: now + this.latencyMs,
      bids: [],
    };
    this.boards.set(jobId, board);
    await this.persist();
    return {
      job_id: jobId,
      job_url: `https://simulation.ash.invalid/board/${jobId}`,
      status: "open",
      raw: { simulated: true, job_id: jobId, status: "open" },
    };
  }

  async listBids(jobId: string): Promise<JobBid[]> {
    await this.ensureLoaded();
    const board = this.boards.get(jobId);
    if (!board) throw new AshError("MARKET_REFUSED", "No such simulated board job.");
    if (Date.now() >= board.bids_ready_at && board.bids.length === 0) {
      const base = parseAmount(board.budget, board.currency);
      const amounts = [(base * 80n) / 100n, (base * 105n) / 100n, (base * 65n) / 100n];
      board.bids = amounts.map((amount, index) => ({
        bid_id: newId("sim_bid"),
        amount: formatMinor(amount, board.currency),
        proposal: `Simulated proposal ${index + 1}: we can deliver ${board.title} and will follow the acceptance criteria.`,
        status: "pending",
        sla_seconds: 3_600 * (index + 1),
        bidder: {
          name: ["Lumen UX Lab", "Sentinel Security", "Testwright"][index] ?? "Simulated bidder",
          handle: ["lumen-ux", "sentinel-sec", "testwright"][index] ?? "sim",
          delivered_jobs: [142, 87, 210][index] ?? 1,
          reputation_overall: [96, 98, 93][index] ?? 50,
        },
        counter_at: null,
      }));
      await this.persist();
    }
    return board.bids.map((bid) => ({
      bid_id: bid.bid_id,
      amount: bid.amount,
      currency: board.currency,
      proposal: bid.proposal,
      status: bid.counter_at && Date.now() - bid.counter_at >= this.latencyMs ? "pending" : bid.status,
      sla_seconds: bid.sla_seconds,
      bidder: {
        id: null,
        handle: bid.bidder.handle,
        name: bid.bidder.name,
        delivered_jobs: bid.bidder.delivered_jobs,
        reputation_overall: bid.bidder.reputation_overall,
        builder_verification: "verified",
      },
      raw: { simulated: true },
    }));
  }

  async awardBid(jobId: string, bidId: string): Promise<AwardBidResult> {
    await this.ensureLoaded();
    const board = this.boards.get(jobId);
    const bid = board?.bids.find((candidate) => candidate.bid_id === bidId);
    if (!board || !bid) throw new AshError("MARKET_REFUSED", "No such simulated bid.");
    if (bid.status === "awarded") throw new AshError("MARKET_REFUSED", "This simulated bid was already awarded.");
    // The market keeps the board job id; the award creates the assignment on
    // that same job. Do not invent a second job id.
    const job: SimJob = {
      job_id: jobId,
      assignment_id: newId("simassign"),
      agent_id: bid.bidder.handle ?? bid.bidder.name,
      agent_name: bid.bidder.name,
      title: board.title,
      description: board.description,
      price: bid.amount,
      currency: board.currency,
      created_at: Date.now(),
      funded_at: Date.now(),
      delivered_at: null,
      accepted_at: null,
      completed_at: null,
      cancelled_at: null,
      revision_feedback: null,
      version: 1,
      draft_id: null,
      approval_url: `https://simulation.ash.invalid/job/${jobId}`,
      bid_id: bidId,
    };
    this.jobs.set(jobId, job);
    bid.status = "awarded";
    await this.persist();
    return {
      action_required: true,
      job_url: job.approval_url!,
      amount: bid.amount,
      currency: board.currency,
      raw: { simulated: true, job_id: jobId, bid_id: bidId },
    };
  }

  async listMyJobs(limit = 20): Promise<JobSummary[]> {
    await this.ensureLoaded();
    const jobs: JobSummary[] = [];
    for (const job of this.jobs.values()) {
      jobs.push({
        job_id: job.job_id,
        title: job.title,
        status: job.completed_at ? "completed" : job.cancelled_at ? "closed" : "in_progress",
        amount: job.price,
        currency: job.currency,
        assignment_status: job.completed_at ? "accepted" : job.delivered_at ? "submitted" : "in_progress",
        worker: job.agent_name,
        raw: { simulated: true },
      });
    }
    return jobs.slice(0, limit);
  }

  async disconnect(): Promise<void> {}

  private toAgent(seed: SimAgentSeed): MarketAgent {
    return {
      id: seed.id,
      handle: seed.handle,
      name: seed.name,
      description: seed.description,
      category: "simulation",
      runtime: "simulated",
      price: seed.price,
      currency: "USD",
      payable_with: ["USD", "USDC"],
      delivered_jobs: seed.delivered,
      success_rate: seed.success,
      response_time_seconds_median: seed.response,
      sla_seconds: 3_600,
      accepting_work: true,
      reviews: {
        total: Math.max(1, Math.floor(seed.delivered / 3)),
        positive: Math.max(0, Math.floor(seed.delivered / 4)),
        recent: [],
      },
      raw: { simulated: true },
    };
  }

  private requireJob(jobId: string): SimJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new AshError("MARKET_REFUSED", "No such simulated job.");
    return job;
  }

  private advance(job: SimJob): void {
    const now = Date.now();
    if (job.funded_at && job.delivered_at === null && !job.cancelled_at && now - job.funded_at >= this.latencyMs) {
      job.delivered_at = now;
    }
    if (job.accepted_at && job.completed_at === null && now - job.accepted_at >= this.latencyMs) {
      job.completed_at = now;
    }
  }
}

function simulatedDeliverable(job: SimJob): string {
  const keywords = job.description
    .replace(/[^A-Za-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4)
    .slice(0, 40)
    .join(", ");
  const revision = job.revision_feedback ? `\n\n## Revision addressed\n\n${job.revision_feedback}\n` : "";
  const wantsJson = /\bjson\b/i.test(job.description);
  if (wantsJson) {
    return JSON.stringify(
      {
        simulated: true,
        deliverable: job.title,
        summary: `SIMULATED deliverable for ${job.title}. It addresses: ${keywords}.`,
        acceptance: job.description,
        revision: job.revision_feedback,
      },
      null,
      2,
    );
  }
  return [
    `# ${job.title}`,
    "",
    "> SIMULATION DELIVERABLE — produced locally by Ash's simulation marketplace. No real agent ran and no real funds moved.",
    "",
    "## Summary",
    "",
    `This delivery responds to the brief for **${job.title}**. It covers the requested scope: ${keywords}.`,
    "",
    "## What was delivered",
    "",
    `The simulated specialist reviewed the brief and produced a complete response for ${job.title}. All acceptance-criteria topics named in the brief are addressed here so the verification pipeline can be exercised end to end.`,
    "",
    "## Acceptance criteria coverage",
    "",
    job.description,
    "",
    "## Handover",
    "",
    "1. Review the deliverable against the acceptance criteria.",
    "2. Approve or request one revision in the Ash prompt.",
    "3. In live mode, acceptance happens on the marketplace job page and payment releases only after the market confirms it.",
    revision,
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
