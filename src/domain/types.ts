import type { Currency, Minor } from "../util/money.js";

export type TaskStatus =
  "draft" | "planned" | "awaiting_plan_approval" | "executing" | "paused" | "completed" | "failed" | "cancelled";

export type ExecutionStrategy = "autonomous" | "plan_then_approve" | "diy_first";
export type SubtaskExecution = "DIY" | "EXTERNAL";
export type Complexity = "low" | "medium" | "high";

export type SubtaskPhase =
  | "pending"
  | "ready"
  | "running_diy"
  | "discovering"
  | "awaiting_hire_approval"
  | "preparing_draft"
  | "awaiting_market_approval"
  | "waiting_bids"
  | "awaiting_market_award"
  | "waiting_job"
  | "verifying"
  | "awaiting_human_review"
  | "awaiting_acceptance_approval"
  | "awaiting_market_acceptance"
  | "revision_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export type Criterion =
  | { kind: "deliverable_present"; description: string; min_chars: number }
  | { kind: "contains"; description: string; all: string[] }
  | { kind: "json_valid"; description: string }
  | { kind: "file_exists"; description: string; path: string; min_bytes: number }
  | { kind: "llm_review"; description: string; rubric: string }
  | { kind: "human_approval"; description: string }
  | { kind: "test_command"; description: string; command: string; timeout_ms: number; expected_exit_code: number };

export interface SubtaskPlan {
  id: string;
  title: string;
  description: string;
  execution: SubtaskExecution;
  dependencies: string[];
  complexity: Complexity;
  skills: string[];
  deliverable: string;
  acceptance_criteria: Criterion[];
  planned_max: string;
  estimated_cost: string;
  rationale: string;
}

export interface Plan {
  schema_version: 1;
  summary: string;
  final_outcome: string;
  assumptions: string[];
  risks: string[];
  currency: Currency;
  authorized_budget: string;
  contingency: string;
  external_planned: string;
  subtasks: SubtaskPlan[];
}

export interface MoneyAmount {
  amount: string;
  currency: Currency;
}

export interface TaskInput {
  description: string;
  budget: string;
  currency: Currency;
  deadline: string | null;
  quality_requirements: string | null;
  preferred_agents: string[];
  execution_strategy: ExecutionStrategy;
  allow_external: boolean;
  diy_first: boolean;
  require_hiring_approval: boolean;
  max_parallel_jobs: number | null;
  additional_instructions: string | null;
  track_id?: string | null;
  project_scopes?: string[];
  track_inputs?: Record<string, string>;
}

export interface MarketSnapshot {
  at: string;
  source: "whoami" | "simulated" | "unavailable";
  account_id: string | null;
  handle: string | null;
  balances: Partial<Record<Currency, string>>;
  credit_usd: string | null;
  note: string | null;
}

export interface NegotiationEntry {
  at: string;
  direction: "COUNTER_OFFER" | "VENDOR_REPLY" | "NOTE";
  vendor_id: string | null;
  vendor_name: string | null;
  amount: string | null;
  currency: Currency;
  reason: string;
}

export type VerificationStatus = "passed" | "failed" | "needs_human" | "error";

export interface CriterionResult {
  criterion: string;
  kind: Criterion["kind"];
  passed: boolean;
  details: string;
}

export interface VerificationResult {
  passed: boolean;
  status: VerificationStatus;
  checked_at: string;
  details: string;
  results: CriterionResult[];
  injection_flags: string[];
  reviewed_by: "ASH" | "HUMAN";
}

export interface DeliveryRecord {
  text_path: string | null;
  files: Array<{ path: string; filename: string; bytes: number; sha256: string | null }>;
  external_url: string | null;
  received_at: string;
  source: string;
  sha256: string;
  suspicious: boolean;
  injection_signals: string[];
  truncated: boolean;
}

export type AttemptStatus = "running" | "waiting" | "verifying" | "passed" | "failed" | "cancelled";

export interface VendorRef {
  id: string;
  name: string;
  handle: string | null;
}

export interface AttemptRecord {
  attempt: number;
  kind: SubtaskExecution;
  status: AttemptStatus;
  started_at: string;
  market_posted_at?: string | null;
  funded_at?: string | null;
  funding_evidence?: { amount: string | null; currency: string | null; observed_at: string };
  board_post_attempted_at?: string | null;
  completed_at: string | null;
  vendor: VendorRef | null;
  job_id: string | null;
  draft_id: string | null;
  assignment_id: string | null;
  approval_url: string | null;
  client_request_id: string | null;
  card_id: string | null;
  hiring_mode: "direct" | "board" | null;
  candidate_index: number;
  bid_id: string | null;
  approval_ref: string | null;
  acceptance_approval_ref: string | null;
  revision_feedback: string | null;
  quoted_price: string | null;
  negotiated_price: string | null;
  agreed_price: string | null;
  currency: Currency;
  negotiation_log: NegotiationEntry[];
  delivery: DeliveryRecord | null;
  verification: VerificationResult | null;
  revision_requested: boolean;
  market_state: string | null;
  payment_status: string | null;
  last_error: string | null;
}

export interface SubtaskState {
  id: string;
  phase: SubtaskPhase;
  attempts: AttemptRecord[];
  active_attempt: number;
  receipt_id: string | null;
  last_error: string | null;
  blocked_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  next_check_at: string | null;
}

export interface TaskRecord {
  schema_version: 1;
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  description: string;
  quality_requirements: string | null;
  additional_instructions: string | null;
  track_id: string | null;
  project_scopes: string[];
  track_inputs: Record<string, string>;
  deadline: string | null;
  preferred_agents: string[];
  execution_strategy: ExecutionStrategy;
  allow_external: boolean;
  diy_first: boolean;
  require_hiring_approval: boolean;
  max_parallel_jobs: number;
  authorized_budget: string;
  currency: Currency;
  status: TaskStatus;
  status_detail: string | null;
  plan: Plan | null;
  plan_approved_at: string | null;
  plan_approval_ref: string | null;
  subtasks: SubtaskState[];
  market_snapshot: MarketSnapshot | null;
  last_receipt_hash: string | null;
  last_receipt_file: string | null;
  cancel_reason: string | null;
}

export type LedgerEntryKind = "AUTHORIZE" | "COMMIT" | "RELEASE" | "REFUND" | "ADJUST_UP" | "ADJUST_DOWN";

export interface LedgerEntry {
  id: string;
  at: string;
  kind: LedgerEntryKind;
  amount: string;
  currency: Currency;
  reference: string;
  description: string;
  approval_ref: string | null;
  metadata: Record<string, string>;
}

export interface LedgerRecord {
  schema_version: 1;
  task_id: string;
  currency: Currency;
  initial_authorized: string;
  authorized_budget: string;
  created_at: string;
  updated_at: string;
  entries: LedgerEntry[];
}

export interface LedgerTotals {
  authorized: Minor;
  committed: Minor;
  paid: Minor;
  refunded: Minor;
  available: Minor;
}

export type ApprovalKind =
  | "plan"
  | "budget_increase"
  | "hire"
  | "award"
  | "accept_result"
  | "cancel_job"
  | "test_command"
  | "manual_verification"
  | "market_spend";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRequest {
  id: string;
  task_id: string;
  kind: ApprovalKind;
  summary: string;
  amount: string | null;
  currency: Currency;
  scope: Record<string, string>;
  nonce: string;
  created_at: string;
  expires_at: string;
  status: ApprovalStatus;
  decided_at: string | null;
  decided_by: "human" | null;
  reference: string | null;
  note: string | null;
}

export interface ApprovalRecord {
  schema_version: 1;
  task_id: string;
  requests: ApprovalRequest[];
}

export interface EngineEvent {
  at: string;
  task_id: string;
  subtask_id: string | null;
  level: "info" | "warn" | "error" | "success";
  code: string;
  message: string;
}

export interface TransactionReceipt {
  schema_version: "1.0";
  transaction_id: string;
  sequence: number;
  idempotency_key: string;
  task_id: string;
  subtask_id: string;
  task_description: string;
  item: string;
  subtask_description: string;
  status: "PAID" | "FAILED" | "CANCELLED" | "WALKED_AWAY" | "REJECTED" | "UNPAID" | "SIMULATED";
  vendor: VendorRef | null;
  planned_max: string;
  quoted_price: string | null;
  negotiated_price: string | null;
  agreed_price: string | null;
  currency: Currency;
  marketplace_job_id: string | null;
  payment_status:
    | "RELEASED"
    | "NOT_PAID"
    | "REFUNDED"
    | "REFUND_PENDING"
    | "ESCROWED"
    | "AWAITING_HUMAN_ACCEPTANCE"
    | "SIMULATED_RELEASED";
  check_result: {
    passed: boolean;
    status: VerificationStatus | "not_applicable";
    details: string;
    criteria: CriterionResult[];
    injection_flags: string[];
  };
  negotiation_log: NegotiationEntry[];
  approval_ref: string | null;
  timestamp: string;
  previous_hash: string;
  hash_algorithm: "SHA-256";
  hash: string;
  mode: "live" | "simulated";
  attempt: number;
  metadata: Record<string, string>;
}
