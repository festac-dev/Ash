import { z } from "zod";
import type { TaskInput } from "./types.js";

export const CURRENCY_SCHEMA = z.enum(["USD", "USDC"]);
export const AMOUNT_SCHEMA = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/, "Amount must be a plain decimal with at most 6 decimals");
export const POSITIVE_AMOUNT_SCHEMA = AMOUNT_SCHEMA.refine(
  (value) => /[1-9]/.test(value),
  "Amount must be greater than zero",
);
export const ISO_SCHEMA = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Must be an ISO 8601 timestamp");
export const ID_SCHEMA = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/, "Invalid identifier");
export const SUBTASK_ID_SCHEMA = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/, "Invalid subtask id");
export const HASH_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/, "Must be a lowercase SHA-256 hex digest");
export const SHA_OR_GENESIS_SCHEMA = z.union([HASH_SCHEMA, z.literal("GENESIS")]);

export const ExecutionStrategySchema = z.enum(["autonomous", "plan_then_approve", "diy_first"]);
export const SubtaskExecutionSchema = z.enum(["DIY", "EXTERNAL"]);
export const ComplexitySchema = z.enum(["low", "medium", "high"]);
export const TaskStatusSchema = z.enum([
  "draft",
  "planned",
  "awaiting_plan_approval",
  "executing",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const CriterionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("deliverable_present"),
    description: z.string().min(3).max(500),
    min_chars: z.number().int().min(1).max(200_000),
  }),
  z.object({
    kind: z.literal("contains"),
    description: z.string().min(3).max(500),
    all: z.array(z.string().min(1).max(250)).min(1).max(20),
  }),
  z.object({
    kind: z.literal("json_valid"),
    description: z.string().min(3).max(500),
  }),
  z.object({
    kind: z.literal("file_exists"),
    description: z.string().min(3).max(500),
    path: z.string().min(1).max(300),
    min_bytes: z.number().int().min(0).max(20_000_000),
  }),
  z.object({
    kind: z.literal("llm_review"),
    description: z.string().min(3).max(500),
    rubric: z.string().min(10).max(3_000),
  }),
  z.object({
    kind: z.literal("human_approval"),
    description: z.string().min(3).max(500),
  }),
  z.object({
    kind: z.literal("test_command"),
    description: z.string().min(3).max(500),
    command: z.string().min(1).max(500),
    timeout_ms: z.number().int().min(1_000).max(600_000),
    expected_exit_code: z.number().int().min(0).max(255),
  }),
]);

/** Kinds a model may propose. Shell commands can only be added by a human. */
export const MODEL_CRITERION_KINDS = [
  "deliverable_present",
  "contains",
  "json_valid",
  "file_exists",
  "llm_review",
  "human_approval",
] as const;

export const ModelCriterionSchema = CriterionSchema.refine(
  (criterion) => (MODEL_CRITERION_KINDS as readonly string[]).includes(criterion.kind),
  "The model may not author shell commands; use human-approved test criteria.",
);

export const ModelSubtaskSchema = z
  .object({
    id: SUBTASK_ID_SCHEMA,
    title: z.string().min(3).max(160),
    description: z.string().min(10).max(4_000),
    execution: SubtaskExecutionSchema,
    dependencies: z.array(SUBTASK_ID_SCHEMA).max(12).default([]),
    complexity: ComplexitySchema,
    skills: z.array(z.string().min(1).max(80)).max(12).default([]),
    deliverable: z.string().min(5).max(1_500),
    acceptance_criteria: z.array(ModelCriterionSchema).min(1).max(10),
    planned_max: AMOUNT_SCHEMA,
    estimated_cost: AMOUNT_SCHEMA,
    rationale: z.string().min(5).max(1_500),
  })
  .passthrough();

export const PlannerOutputSchema = z
  .object({
    summary: z.string().min(10).max(2_000),
    final_outcome: z.string().min(10).max(2_000),
    assumptions: z.array(z.string().min(1).max(500)).max(20).default([]),
    risks: z.array(z.string().min(1).max(500)).max(20).default([]),
    contingency: AMOUNT_SCHEMA,
    subtasks: z.array(ModelSubtaskSchema).min(1).max(24),
  })
  .passthrough();

export const SubtaskPlanSchema = ModelSubtaskSchema.extend({
  acceptance_criteria: z.array(CriterionSchema).min(1).max(10),
});

export const PlanSchema = z
  .object({
    schema_version: z.literal(1),
    summary: z.string().min(10).max(2_000),
    final_outcome: z.string().min(10).max(2_000),
    assumptions: z.array(z.string().min(1).max(500)).max(20),
    risks: z.array(z.string().min(1).max(500)).max(20),
    currency: CURRENCY_SCHEMA,
    authorized_budget: AMOUNT_SCHEMA,
    contingency: AMOUNT_SCHEMA,
    external_planned: AMOUNT_SCHEMA,
    subtasks: z.array(SubtaskPlanSchema).min(1).max(24),
  })
  .passthrough();

export const TaskInputSchema = z.object({
  description: z.string().trim().min(3).max(10_000),
  budget: POSITIVE_AMOUNT_SCHEMA,
  currency: CURRENCY_SCHEMA,
  deadline: ISO_SCHEMA.nullable().default(null),
  quality_requirements: z.string().trim().max(4_000).nullable().default(null),
  preferred_agents: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  execution_strategy: ExecutionStrategySchema.default("plan_then_approve"),
  allow_external: z.boolean().default(true),
  diy_first: z.boolean().default(true),
  require_hiring_approval: z.boolean().default(true),
  max_parallel_jobs: z.number().int().min(1).max(8).nullable().default(null),
  additional_instructions: z.string().trim().max(4_000).nullable().default(null),
  track_id: z.string().trim().max(40).nullable().default(null),
  project_scopes: z.array(z.string().trim().max(40)).max(6).default([]),
  track_inputs: z.record(z.string(), z.string().trim().max(500)).default({}),
});

export const MarketSnapshotSchema = z
  .object({
    at: ISO_SCHEMA,
    source: z.enum(["whoami", "simulated", "unavailable"]),
    account_id: z.string().nullable(),
    handle: z.string().nullable(),
    balances: z.object({ USD: AMOUNT_SCHEMA.optional(), USDC: AMOUNT_SCHEMA.optional() }).partial(),
    credit_usd: AMOUNT_SCHEMA.nullable(),
    note: z.string().max(1_000).nullable(),
  })
  .passthrough();

export const VendorRefSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  handle: z.string().max(200).nullable(),
});

export const NegotiationEntrySchema = z.object({
  at: ISO_SCHEMA,
  direction: z.enum(["COUNTER_OFFER", "VENDOR_REPLY", "NOTE"]),
  vendor_id: z.string().max(200).nullable(),
  vendor_name: z.string().max(300).nullable(),
  amount: AMOUNT_SCHEMA.nullable(),
  currency: CURRENCY_SCHEMA,
  reason: z.string().min(1).max(2_000),
});

export const CriterionResultSchema = z.object({
  criterion: z.string().max(500),
  kind: z.enum([
    "deliverable_present",
    "contains",
    "json_valid",
    "file_exists",
    "llm_review",
    "human_approval",
    "test_command",
  ]),
  passed: z.boolean(),
  details: z.string().max(4_000),
});

export const VerificationResultSchema = z.object({
  passed: z.boolean(),
  status: z.enum(["passed", "failed", "needs_human", "error"]),
  checked_at: ISO_SCHEMA,
  details: z.string().max(8_000),
  results: z.array(CriterionResultSchema).max(20),
  injection_flags: z.array(z.string().max(100)).max(20),
  reviewed_by: z.enum(["ASH", "HUMAN"]),
});

export const DeliveryRecordSchema = z.object({
  text_path: z.string().max(1_000).nullable(),
  files: z
    .array(
      z.object({
        path: z.string().max(1_000),
        filename: z.string().max(300),
        bytes: z.number().int().min(0),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      }),
    )
    .max(50),
  external_url: z.string().max(2_000).nullable(),
  received_at: ISO_SCHEMA,
  source: z.string().max(300),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  suspicious: z.boolean(),
  injection_signals: z.array(z.string().max(100)).max(20),
  truncated: z.boolean(),
});

export const AttemptRecordSchema = z
  .object({
    attempt: z.number().int().min(1).max(10),
    kind: SubtaskExecutionSchema,
    status: z.enum(["running", "waiting", "verifying", "passed", "failed", "cancelled"]),
    started_at: ISO_SCHEMA,
    market_posted_at: ISO_SCHEMA.nullable().optional(),
    funded_at: ISO_SCHEMA.nullable().optional(),
    funding_evidence: z
      .object({
        amount: z.string().max(300).nullable(),
        currency: z.string().max(100).nullable(),
        observed_at: ISO_SCHEMA,
      })
      .optional(),
    board_post_attempted_at: ISO_SCHEMA.nullable().optional(),
    completed_at: ISO_SCHEMA.nullable(),
    vendor: VendorRefSchema.nullable(),
    job_id: z.string().max(300).nullable(),
    draft_id: z.string().max(300).nullable(),
    assignment_id: z.string().max(300).nullable(),
    approval_url: z.string().max(2_000).nullable(),
    client_request_id: z.string().max(200).nullable(),
    card_id: z.string().max(300).nullable(),
    hiring_mode: z.enum(["direct", "board"]).nullable(),
    candidate_index: z.number().int().min(0).max(100).default(0),
    bid_id: z.string().max(300).nullable(),
    approval_ref: z.string().max(200).nullable(),
    acceptance_approval_ref: z.string().max(200).nullable(),
    revision_feedback: z.string().max(4_000).nullable(),
    quoted_price: AMOUNT_SCHEMA.nullable(),
    negotiated_price: AMOUNT_SCHEMA.nullable(),
    agreed_price: AMOUNT_SCHEMA.nullable(),
    currency: CURRENCY_SCHEMA,
    negotiation_log: z.array(NegotiationEntrySchema).max(30),
    delivery: DeliveryRecordSchema.nullable(),
    verification: VerificationResultSchema.nullable(),
    revision_requested: z.boolean(),
    market_state: z.string().max(300).nullable(),
    payment_status: z.string().max(100).nullable(),
    last_error: z.string().max(2_000).nullable(),
  })
  .passthrough();

export const SubtaskStateSchema = z.object({
  id: SUBTASK_ID_SCHEMA,
  phase: z.enum([
    "pending",
    "ready",
    "running_diy",
    "discovering",
    "awaiting_hire_approval",
    "preparing_draft",
    "awaiting_market_approval",
    "waiting_bids",
    "awaiting_market_award",
    "waiting_job",
    "verifying",
    "awaiting_human_review",
    "awaiting_acceptance_approval",
    "awaiting_market_acceptance",
    "revision_requested",
    "completed",
    "failed",
    "cancelled",
    "blocked",
  ]),
  attempts: z.array(AttemptRecordSchema).max(10),
  active_attempt: z.number().int().min(0).max(10),
  receipt_id: z.string().max(200).nullable(),
  last_error: z.string().max(2_000).nullable(),
  blocked_reason: z.string().max(2_000).nullable(),
  started_at: ISO_SCHEMA.nullable(),
  completed_at: ISO_SCHEMA.nullable(),
  updated_at: ISO_SCHEMA,
  next_check_at: ISO_SCHEMA.nullable(),
});

export const TaskRecordSchema = z
  .object({
    schema_version: z.literal(1),
    id: ID_SCHEMA,
    revision: z.number().int().min(0),
    created_at: ISO_SCHEMA,
    updated_at: ISO_SCHEMA,
    description: z.string().min(3).max(10_000),
    quality_requirements: z.string().max(4_000).nullable(),
    additional_instructions: z.string().max(4_000).nullable(),
    track_id: z.string().max(40).nullable().default(null),
    project_scopes: z.array(z.string().max(40)).max(6).default([]),
    track_inputs: z.record(z.string(), z.string().max(500)).default({}),
    deadline: ISO_SCHEMA.nullable(),
    preferred_agents: z.array(z.string().max(120)).max(10),
    execution_strategy: ExecutionStrategySchema,
    allow_external: z.boolean(),
    diy_first: z.boolean(),
    require_hiring_approval: z.boolean(),
    max_parallel_jobs: z.number().int().min(1).max(8),
    authorized_budget: POSITIVE_AMOUNT_SCHEMA,
    currency: CURRENCY_SCHEMA,
    status: TaskStatusSchema,
    status_detail: z.string().max(2_000).nullable(),
    plan: PlanSchema.nullable(),
    plan_approved_at: ISO_SCHEMA.nullable(),
    plan_approval_ref: z.string().max(200).nullable(),
    subtasks: z.array(SubtaskStateSchema).max(24),
    market_snapshot: MarketSnapshotSchema.nullable(),
    last_receipt_hash: z.string().max(200).nullable(),
    last_receipt_file: z.string().max(300).nullable(),
    cancel_reason: z.string().max(2_000).nullable(),
  })
  .passthrough();

export const LedgerEntrySchema = z.object({
  id: ID_SCHEMA,
  at: ISO_SCHEMA,
  kind: z.enum(["AUTHORIZE", "COMMIT", "RELEASE", "REFUND", "ADJUST_UP", "ADJUST_DOWN"]),
  amount: AMOUNT_SCHEMA,
  currency: CURRENCY_SCHEMA,
  reference: z.string().min(1).max(300),
  description: z.string().min(1).max(1_000),
  approval_ref: z.string().max(200).nullable(),
  metadata: z.record(z.string(), z.string().max(500)).default({}),
});

export const LedgerRecordSchema = z
  .object({
    schema_version: z.literal(1),
    task_id: ID_SCHEMA,
    currency: CURRENCY_SCHEMA,
    initial_authorized: POSITIVE_AMOUNT_SCHEMA,
    authorized_budget: POSITIVE_AMOUNT_SCHEMA,
    created_at: ISO_SCHEMA,
    updated_at: ISO_SCHEMA,
    entries: z.array(LedgerEntrySchema).max(5_000),
  })
  .passthrough();

export const ApprovalRequestSchema = z
  .object({
    id: ID_SCHEMA,
    task_id: ID_SCHEMA,
    kind: z.enum([
      "plan",
      "budget_increase",
      "hire",
      "award",
      "accept_result",
      "cancel_job",
      "test_command",
      "manual_verification",
      "market_spend",
    ]),
    summary: z.string().min(1).max(2_000),
    amount: AMOUNT_SCHEMA.nullable(),
    currency: CURRENCY_SCHEMA,
    scope: z.record(z.string(), z.string().max(500)).default({}),
    nonce: z.string().min(16).max(200),
    created_at: ISO_SCHEMA,
    expires_at: ISO_SCHEMA,
    status: z.enum(["pending", "approved", "denied", "expired"]),
    decided_at: ISO_SCHEMA.nullable(),
    decided_by: z.literal("human").nullable(),
    reference: z.string().max(200).nullable(),
    note: z.string().max(1_000).nullable(),
  })
  .passthrough();

export const ApprovalRecordSchema = z
  .object({
    schema_version: z.literal(1),
    task_id: ID_SCHEMA,
    requests: z.array(ApprovalRequestSchema).max(2_000),
  })
  .passthrough();

export const EngineEventSchema = z.object({
  at: ISO_SCHEMA,
  task_id: ID_SCHEMA,
  subtask_id: z.string().max(100).nullable(),
  level: z.enum(["info", "warn", "error", "success"]),
  code: z.string().max(100),
  message: z.string().max(2_000),
});

export const TransactionReceiptSchema = z
  .object({
    schema_version: z.literal("1.0"),
    transaction_id: ID_SCHEMA,
    sequence: z.number().int().min(1),
    idempotency_key: z.string().min(1).max(300),
    task_id: ID_SCHEMA,
    subtask_id: SUBTASK_ID_SCHEMA,
    task_description: z.string().min(1).max(10_000),
    item: z.string().min(1).max(300),
    subtask_description: z.string().min(1).max(4_000),
    status: z.enum(["PAID", "FAILED", "CANCELLED", "WALKED_AWAY", "REJECTED", "UNPAID", "SIMULATED"]),
    vendor: VendorRefSchema.nullable(),
    planned_max: AMOUNT_SCHEMA,
    quoted_price: AMOUNT_SCHEMA.nullable(),
    negotiated_price: AMOUNT_SCHEMA.nullable(),
    agreed_price: AMOUNT_SCHEMA.nullable(),
    currency: CURRENCY_SCHEMA,
    marketplace_job_id: z.string().max(300).nullable(),
    payment_status: z.enum([
      "RELEASED",
      "NOT_PAID",
      "REFUNDED",
      "REFUND_PENDING",
      "ESCROWED",
      "AWAITING_HUMAN_ACCEPTANCE",
      "SIMULATED_RELEASED",
    ]),
    check_result: z.object({
      passed: z.boolean(),
      status: z.enum(["passed", "failed", "needs_human", "error", "not_applicable"]),
      details: z.string().max(8_000),
      criteria: z.array(CriterionResultSchema).max(20),
      injection_flags: z.array(z.string().max(100)).max(20),
    }),
    negotiation_log: z.array(NegotiationEntrySchema).max(30),
    approval_ref: z.string().max(200).nullable(),
    timestamp: ISO_SCHEMA,
    previous_hash: SHA_OR_GENESIS_SCHEMA,
    hash_algorithm: z.literal("SHA-256"),
    hash: HASH_SCHEMA,
    mode: z.enum(["live", "simulated"]),
    attempt: z.number().int().min(1).max(10),
    metadata: z.record(z.string(), z.string().max(2_000)).default({}),
  })
  .passthrough();

export function parseTaskInput(raw: unknown): TaskInput {
  return TaskInputSchema.parse(raw) as TaskInput;
}
