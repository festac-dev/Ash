import { AshError } from "../errors.js";
import { formatMinor, parseAmount, isCurrency, type Currency } from "../util/money.js";
import type {
  ActionRequired,
  DeliverableFile,
  DraftStatus,
  JobAssignment,
  JobBid,
  JobResult,
  JobStatus,
  JobSummary,
  MarketAccount,
  MarketAgent,
  PostJobResult,
  PrepareJobDraft,
  PrepareJobFunded,
  PrepareJobResult,
  WhoAmI,
} from "./types.js";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

export function pickBool(record: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

export function pickArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function canonicalAmount(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const text = String(value);
    if (text.includes("e") || text.includes("E")) return null;
    try {
      return formatMinor(parseAmount(text, "USD"));
    } catch {
      return null;
    }
  }
  if (typeof value === "string") {
    try {
      return formatMinor(parseAmount(value, "USD"));
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeCurrency(value: unknown, fallback: Currency | null = null): Currency | null {
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if (isCurrency(upper)) return upper;
  }
  // Absence may use a contract default; an explicit unsupported rail must not.
  return value === undefined || value === null ? fallback : null;
}

export function normalizeCurrencyList(value: unknown): Currency[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return null;
  const currencies = value.map((item) => normalizeCurrency(item)).filter((item): item is Currency => item !== null);
  return [...new Set(currencies)];
}

export function normalizeSecureUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 2_000) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function requireAmount(value: unknown, label: string, fallback: string | null = null): string {
  const canonical = canonicalAmount(value);
  if (canonical) return canonical;
  if (fallback) return fallback;
  throw new AshError("MARKET_PROTOCOL_ERROR", `Marketplace response is missing ${label}.`);
}

export function normalizeAgent(raw: unknown, fallbackCurrency: Currency): MarketAgent {
  const record = asRecord(raw);
  const id = pickString(record, ["agent_id", "id", "handle"]);
  if (!id) throw new AshError("MARKET_PROTOCOL_ERROR", "Marketplace agent is missing an id.");
  const payable = normalizeCurrencyList(record.payable_with);
  const price = record.price === null || record.price === undefined ? null : canonicalAmount(record.price);
  const currency = normalizeCurrency(record.price_token, fallbackCurrency) ?? fallbackCurrency;
  if (
    record.price_token !== null &&
    record.price_token !== undefined &&
    normalizeCurrency(record.price_token) === null
  ) {
    throw new AshError("MARKET_PROTOCOL_ERROR", "Agent price uses an unsupported currency.");
  }
  return {
    id,
    handle: pickString(record, ["handle"]),
    name: pickString(record, ["name", "title"]) ?? id,
    description: pickString(record, ["description", "bio_markdown", "bio"]) ?? "",
    category: pickString(record, ["category"]),
    runtime: pickString(record, ["runtime"]),
    price,
    currency,
    payable_with: payable,
    delivered_jobs: pickNumber(record, ["delivered_jobs", "deliveredJobs"]) ?? 0,
    success_rate: pickNumber(record, ["success_rate", "successRate"]),
    response_time_seconds_median: pickNumber(record, ["response_time_seconds_median", "responseTimeSecondsMedian"]),
    sla_seconds: pickNumber(record, ["sla_seconds", "slaSeconds"]),
    accepting_work: pickBool(record, ["accepting_work", "acceptingWork"]),
    reviews: record.reviews ?? null,
    raw: record,
  };
}

export function normalizeAccount(raw: unknown, fallbackCurrency: Currency): MarketAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const record = asRecord(raw);
  const balancesRaw = asRecord(record.balances);
  const balances: Partial<Record<Currency, string>> = {};
  for (const currency of ["USD", "USDC"] as const) {
    const value = canonicalAmount(balancesRaw[currency.toLowerCase()] ?? balancesRaw[currency]);
    if (value) balances[currency] = value;
  }
  return {
    id: pickString(record, ["id", "account_id"]),
    handle: pickString(record, ["handle", "name"]),
    verification: pickString(record, ["verification", "level"]),
    balances,
    credit_usd: canonicalAmount(record.credit_usd ?? balancesRaw.credit_usd),
  };
}

export function normalizeWhoAmI(raw: unknown, fallbackCurrency: Currency = "USDC"): WhoAmI {
  const record = asRecord(raw);
  const user = asRecord(record.user);
  const account = normalizeAccount(record.account, fallbackCurrency);
  return {
    marketplace: pickString(record, ["marketplace", "host"]),
    user_handle: pickString(user, ["handle", "name"]) ?? pickString(record, ["handle"]),
    email_verified: pickBool(user, ["email_verified", "emailVerified"]),
    account,
    accounts: pickArray(record, ["accounts"])
      .map((item) => normalizeAccount(item, fallbackCurrency))
      .filter((item): item is MarketAccount => item !== null),
    server_version: pickString(asRecord(record.server), ["version"]),
    note: pickString(record, ["note"]),
    raw: record,
  };
}

export function normalizePrepareJob(raw: unknown, fallbackCurrency: Currency): PrepareJobResult {
  const record = asRecord(raw);
  if (record.job_id || record.funded === true) {
    const fundedJobId = pickString(record, ["job_id", "id"]);
    if (!fundedJobId) throw new AshError("MARKET_PROTOCOL_ERROR", "Funded job response is missing a job id.");
    return {
      state: "funded",
      job_id: fundedJobId,
      job_url: normalizeSecureUrl(record.job_url ?? record.url),
      assignment_id: pickString(record, ["assignment_id", "assignmentId"]),
      funded: record.funded !== false,
      amount: canonicalAmount(record.amount ?? record.quoted_price ?? record.price),
      currency: normalizeCurrency(record.token, fallbackCurrency),
      raw: record,
    } satisfies PrepareJobFunded;
  }
  const draftId = pickString(record, ["draft_id", "draftId", "id"]);
  if (!draftId) {
    throw new AshError("MARKET_PROTOCOL_ERROR", "prepare_job returned neither a draft nor a funded job.", {
      details: { keys: Object.keys(record) },
    });
  }
  return {
    state: "draft",
    draft_id: draftId,
    approval_url: normalizeSecureUrl(record.approval_url ?? record.url),
    quoted_price: requireAmount(record.quoted_price ?? record.price, "quoted_price"),
    currency: normalizeCurrency(record.token, fallbackCurrency),
    payable_with: normalizeCurrencyList(record.payable_with),
    required_connections: pickArray(record, ["required_connections"]).map((item) => {
      if (typeof item === "string") return item;
      const conn = asRecord(item);
      return pickString(conn, ["name", "slug", "capability"]) ?? "connection";
    }),
    replayed: record.replayed === true,
    raw: record,
  } satisfies PrepareJobDraft;
}

export function normalizeDraftStatus(raw: unknown): DraftStatus {
  const record = asRecord(raw);
  if (record.job_id || record.funded === true) {
    return {
      state: "funded",
      draft_id: pickString(record, ["draft_id", "draftId"]),
      job_id: pickString(record, ["job_id", "id"]),
      job_url: normalizeSecureUrl(record.job_url ?? record.url),
      approval_url: normalizeSecureUrl(record.approval_url),
      funded: true,
      amount: canonicalAmount(record.amount ?? record.price),
      currency: normalizeCurrency(record.token),
      raw: record,
    };
  }
  const status = (pickString(record, ["status", "state"]) ?? "").toLowerCase();
  if (status.includes("deleted")) {
    return {
      state: "deleted",
      draft_id: null,
      job_id: null,
      job_url: null,
      approval_url: null,
      funded: false,
      raw: record,
    };
  }
  return {
    state: "draft",
    draft_id: pickString(record, ["draft_id", "draftId"]),
    job_id: null,
    job_url: null,
    approval_url: normalizeSecureUrl(record.approval_url),
    funded: false,
    raw: record,
  };
}

function normalizeAssignment(raw: unknown): JobAssignment | null {
  const record = asRecord(raw);
  if (Object.keys(record).length === 0) return null;
  const progress = asRecord(record.progress_report);
  return {
    assignment_id: pickString(record, ["assignment_id", "id"]),
    status: pickString(record, ["status", "worker_state"]),
    worker_state: pickString(record, ["worker_state"]),
    result_available: pickBool(record, ["result_available"]) ?? false,
    submitted_at: pickString(record, ["submitted_at"]),
    auto_accept_at: pickString(record, ["auto_accept_at"]),
    progress_report: pickString(progress, ["message"]) ?? pickString(record, ["progress_report"]),
    progress_percent: pickNumber(progress, ["percent"]),
    raw: record,
  };
}

export function normalizeJobStatus(raw: unknown, jobId: string): JobStatus {
  const record = asRecord(raw);
  const assignments = pickArray(record, ["assignments"])
    .map(normalizeAssignment)
    .filter((item): item is JobAssignment => item !== null);
  const first = assignments[0] ?? null;
  return {
    job_id: pickString(record, ["job_id", "id"]) ?? jobId,
    status: pickString(record, ["status"]),
    worker_state: pickString(record, ["worker_state"]),
    result_available: pickBool(record, ["result_available"]) ?? first?.result_available ?? false,
    settled: pickBool(record, ["settled"]) ?? false,
    amount: canonicalAmount(record.amount ?? record.price),
    currency: normalizeCurrency(record.token),
    expected_by: pickString(record, ["expected_by"]),
    auto_accept_at: pickString(record, ["auto_accept_at"]) ?? first?.auto_accept_at ?? null,
    next_step: pickString(record, ["next_step"]),
    assignment_id: pickString(record, ["assignment_id"]) ?? first?.assignment_id ?? null,
    assignments,
    title: pickString(record, ["title"]),
    raw: record,
  };
}

function normalizeFile(raw: unknown): DeliverableFile | null {
  const record = asRecord(raw);
  const fileId = pickString(record, ["file_id", "id", "fileId"]);
  if (!fileId) return null;
  return {
    file_id: fileId,
    filename: pickString(record, ["filename", "name"]) ?? "deliverable",
    content_type: pickString(record, ["content_type", "contentType"]),
    byte_size: pickNumber(record, ["byte_size", "byteSize", "size"]),
    sha256: pickString(record, ["sha256"]),
  };
}

export function normalizeJobResult(raw: unknown): JobResult {
  const record = asRecord(raw);
  const statusRaw = (pickString(record, ["status"]) ?? "").toLowerCase();
  const externalUrl = normalizeSecureUrl(record.deliverable_url ?? record.external_url);
  const content =
    ([record.content_chunk, record.content, record.deliverable, record.markdown].find(
      (value) => typeof value === "string",
    ) as string | undefined) ?? null;
  const files = pickArray(record, ["files"])
    .map(normalizeFile)
    .filter((item): item is DeliverableFile => item !== null);
  let status: JobResult["status"];
  if (statusRaw === "external" || (externalUrl && !content)) status = "external";
  else if (statusRaw === "unavailable" || (!content && !externalUrl && !files.length)) status = "unavailable";
  else status = "delivered";
  return {
    status,
    content,
    external_url: externalUrl,
    files,
    assignment_id: pickString(record, ["assignment_id"]),
    awaiting_acceptance: pickBool(record, ["awaiting_acceptance"]) ?? false,
    version: pickNumber(record, ["version"]),
    note: pickString(record, ["note"]),
    bytes_total: pickNumber(record, ["bytes_total"]),
    raw: record,
  };
}

export function normalizeActionRequired(raw: unknown, fallbackCurrency: Currency): ActionRequired {
  const record = asRecord(raw);
  const url = normalizeSecureUrl(record.job_url ?? record.url ?? record.approval_url);
  if (!url) {
    throw new AshError("MARKET_PROTOCOL_ERROR", "Marketplace action did not include a secure job URL.");
  }
  return {
    action_required: pickBool(record, ["action_required"]) ?? true,
    job_url: url,
    assignment_id: pickString(record, ["assignment_id"]),
    bid_id: pickString(record, ["bid_id"]),
    amount: canonicalAmount(record.amount),
    currency: normalizeCurrency(record.token, fallbackCurrency),
    note: pickString(record, ["note", "next_step"]),
    raw: record,
  };
}

export function normalizeBid(raw: unknown, fallbackCurrency: Currency): JobBid | null {
  const record = asRecord(raw);
  const bidId = pickString(record, ["bid_id", "id"]);
  const amount = canonicalAmount(record.amount ?? record.price);
  if (!bidId || !amount) return null;
  const currency = normalizeCurrency(record.token, fallbackCurrency);
  if (!currency) return null;
  const bidder = asRecord(record.bidder);
  return {
    bid_id: bidId,
    amount,
    currency,
    proposal: pickString(record, ["proposal", "description"]) ?? "",
    status: pickString(record, ["status"]) ?? "unknown",
    sla_seconds: pickNumber(record, ["sla_seconds"]),
    bidder: {
      id: pickString(bidder, ["agent_id", "id"]),
      handle: pickString(bidder, ["handle"]),
      name: pickString(bidder, ["name"]),
      delivered_jobs: pickNumber(bidder, ["delivered_jobs"]),
      reputation_overall: pickNumber(bidder, ["reputation_overall"]),
      builder_verification: pickString(asRecord(bidder.builder_verification), ["level"]),
    },
    raw: record,
  };
}

export function normalizePostJob(raw: unknown): PostJobResult {
  const record = asRecord(raw);
  const jobId = pickString(record, ["job_id", "id"]);
  if (!jobId) throw new AshError("MARKET_PROTOCOL_ERROR", "post_job did not return a job id.");
  return {
    job_id: jobId,
    job_url: normalizeSecureUrl(record.job_url ?? record.url),
    status: pickString(record, ["status"]) ?? "open",
    raw: record,
  };
}

export function normalizeJobSummary(raw: unknown, fallbackCurrency: Currency): JobSummary | null {
  const record = asRecord(raw);
  const jobId = pickString(record, ["job_id", "id"]);
  if (!jobId) return null;
  return {
    job_id: jobId,
    title: pickString(record, ["title"]),
    status: pickString(record, ["status"]),
    amount: canonicalAmount(record.amount ?? record.budget_amount),
    currency: normalizeCurrency(record.token, fallbackCurrency),
    assignment_status: pickString(record, ["assignment_status"]),
    worker: pickString(record, ["worker"]),
    raw: record,
  };
}
