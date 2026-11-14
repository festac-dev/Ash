import type { Currency } from "../util/money.js";

export interface MarketAgent {
  id: string;
  handle: string | null;
  name: string;
  description: string;
  category: string | null;
  runtime: string | null;
  price: string | null;
  currency: Currency;
  payable_with: Currency[] | null;
  delivered_jobs: number;
  success_rate: number | null;
  response_time_seconds_median: number | null;
  sla_seconds: number | null;
  accepting_work: boolean | null;
  reviews: unknown;
  raw: Record<string, unknown>;
}

export interface MarketAccount {
  id: string | null;
  handle: string | null;
  verification: string | null;
  balances: Partial<Record<Currency, string>>;
  credit_usd: string | null;
}

export interface WhoAmI {
  marketplace: string | null;
  user_handle: string | null;
  email_verified: boolean | null;
  account: MarketAccount | null;
  accounts: MarketAccount[];
  server_version: string | null;
  note: string | null;
  raw: Record<string, unknown>;
}

export interface MarketCapabilities {
  tools: string[];
  buyer: boolean;
  can_prepare_job: boolean;
  can_create_job: boolean;
  can_board: boolean;
  can_accept: boolean;
  can_request_changes: boolean;
  can_cancel: boolean;
  can_read_result: boolean;
  can_read_files: boolean;
  can_wait: boolean;
  can_message: boolean;
  can_award: boolean;
  server_version: string | null;
  instructions: string | null;
}

export interface MarketConnectionInfo {
  connected: boolean;
  mode: "live" | "simulated";
  endpoint: string;
  server_version: string | null;
  tool_count: number;
  capabilities: MarketCapabilities;
  note: string | null;
}

export interface BrowseAgentsInput {
  query?: string;
  category?: string;
  limit?: number;
}

export interface PrepareJobInput {
  worker_agent_id: string;
  title: string;
  description: string;
  client_request_id: string;
  token?: Currency;
  acceptance_window_days?: number;
}

export interface PrepareJobDraft {
  state: "draft";
  draft_id: string;
  approval_url: string | null;
  quoted_price: string;
  currency: Currency | null;
  payable_with: Currency[] | null;
  required_connections: string[];
  replayed: boolean;
  raw: Record<string, unknown>;
}

export interface PrepareJobFunded {
  state: "funded";
  job_id: string;
  job_url: string | null;
  assignment_id: string | null;
  funded: boolean;
  amount: string | null;
  currency: Currency | null;
  raw: Record<string, unknown>;
}

export type PrepareJobResult = PrepareJobDraft | PrepareJobFunded;

export interface DraftStatus {
  state: "draft" | "funded" | "deleted" | "unknown";
  draft_id: string | null;
  job_id: string | null;
  job_url: string | null;
  approval_url: string | null;
  funded: boolean;
  amount?: string | null;
  currency?: Currency | null;
  raw: Record<string, unknown>;
}

export interface JobAssignment {
  assignment_id: string | null;
  status: string | null;
  worker_state: string | null;
  result_available: boolean;
  submitted_at: string | null;
  auto_accept_at: string | null;
  progress_report: string | null;
  progress_percent: number | null;
  raw: Record<string, unknown>;
}

export interface JobStatus {
  job_id: string;
  status: string | null;
  worker_state: string | null;
  result_available: boolean;
  settled: boolean;
  amount?: string | null;
  currency?: Currency | null;
  expected_by: string | null;
  auto_accept_at: string | null;
  next_step: string | null;
  assignment_id: string | null;
  assignments: JobAssignment[];
  title: string | null;
  raw: Record<string, unknown>;
}

export interface DeliverableFile {
  file_id: string;
  filename: string;
  content_type: string | null;
  byte_size: number | null;
  sha256: string | null;
}

export interface JobResult {
  status: "delivered" | "external" | "unavailable";
  content: string | null;
  external_url: string | null;
  files: DeliverableFile[];
  assignment_id: string | null;
  awaiting_acceptance: boolean;
  version: number | null;
  note: string | null;
  bytes_total: number | null;
  truncated?: boolean;
  raw: Record<string, unknown>;
}

export interface ActionRequired {
  action_required: boolean;
  job_url: string;
  assignment_id: string | null;
  bid_id: string | null;
  amount: string | null;
  currency: Currency | null;
  note: string | null;
  raw: Record<string, unknown>;
}

export interface JobBid {
  bid_id: string;
  amount: string;
  currency: Currency;
  proposal: string;
  status: string;
  sla_seconds: number | null;
  bidder: {
    id: string | null;
    handle: string | null;
    name: string | null;
    delivered_jobs: number | null;
    reputation_overall: number | null;
    builder_verification: string | null;
  };
  raw: Record<string, unknown>;
}

export interface PostJobInput {
  title: string;
  description: string;
  budget_amount?: string;
  token?: Currency;
  tags?: string[];
  max_slots?: number;
  acceptance_window_days?: number;
  min_builder_verification?: "none" | "verified" | "identity_verified";
}

export interface PostJobResult {
  job_id: string;
  job_url: string | null;
  status: string;
  raw: Record<string, unknown>;
}

export interface AwardBidResult {
  action_required: boolean;
  job_url: string;
  amount: string | null;
  currency: Currency | null;
  raw: Record<string, unknown>;
}

export interface MessageWorkerInput {
  job_id: string;
  body: string;
  client_request_id?: string;
  bid_id?: string;
  assignment_id?: string;
}

export interface JobSummary {
  job_id: string;
  title: string | null;
  status: string | null;
  amount: string | null;
  currency: Currency | null;
  assignment_status: string | null;
  worker: string | null;
  raw: Record<string, unknown>;
}

export interface MarketAdapter {
  readonly mode: "live" | "simulated";
  readonly endpoint: string;
  connect(): Promise<MarketConnectionInfo>;
  capabilities(): MarketCapabilities;
  whoami(): Promise<WhoAmI>;
  browseAgents(input: BrowseAgentsInput): Promise<MarketAgent[]>;
  getAgent(idOrHandle: string): Promise<MarketAgent>;
  prepareJob(input: PrepareJobInput): Promise<PrepareJobResult>;
  createJob(input: PrepareJobInput): Promise<PrepareJobFunded>;
  getDraftStatus(input: { draftId?: string; clientRequestId?: string }): Promise<DraftStatus>;
  getJobStatus(jobId: string): Promise<JobStatus>;
  waitForJob(
    jobId: string,
    cursor?: string | null,
    waitSeconds?: number,
  ): Promise<JobStatus & { cursor: string | null; changed: boolean }>;
  getJobResult(jobId: string, assignmentId?: string | null): Promise<JobResult>;
  getFile(fileId: string): Promise<{ bytes: Buffer; filename: string | null; sha256: string | null }>;
  acceptResult(jobId: string, assignmentId?: string | null): Promise<ActionRequired>;
  requestChanges(jobId: string, feedback: string, assignmentId?: string | null): Promise<Record<string, unknown>>;
  cancelJob(jobId: string): Promise<Record<string, unknown>>;
  messageWorker(input: MessageWorkerInput): Promise<Record<string, unknown>>;
  postJob(input: PostJobInput): Promise<PostJobResult>;
  listBids(jobId: string): Promise<JobBid[]>;
  awardBid(jobId: string, bidId: string): Promise<AwardBidResult>;
  listMyJobs(limit?: number): Promise<JobSummary[]>;
  disconnect(): Promise<void>;
}
