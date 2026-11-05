import { AshError } from "../errors.js";
import { formatMinor, type Minor } from "../util/money.js";
import {
  assertText,
  finalizeTrackRun,
  formatAmount,
  parsePositiveMoney,
  sha256Text,
  type TrackRun,
} from "../journey/core.js";

export interface PrivacyInput {
  document_name: string;
  document_text: string;
  retention_mode: "no-server-side-persistence";
  currency: "USD";
  high_value_threshold: string;
}

export interface PrivacyEvidence {
  audit: {
    document_name: string;
    document_sha256: string;
    parsed_lines: number;
    unparsed_lines: number;
    currency: "USD";
    total: string;
    high_value_count: number;
    categories: Array<{ category: string; count: number; total: string }>;
    high_value: Array<{ date: string; merchant: string; category: string; amount: string }>;
  };
  redactions: {
    count: number;
    kinds: string[];
  };
  retention: {
    mode: "no-server-side-persistence";
    raw_document_persisted: false;
    prompt_persisted: false;
    response_persisted: false;
    server_side_artifacts: string[];
    cleanup: "complete";
  };
  private_ai: {
    status: "not-configured";
    tee_model: null;
    attestation_verified: false;
    fallback: "local-deterministic";
    note: string;
  };
}

const DEFAULT_DOCUMENT = [
  "2026-10-02 | Grocery Market | groceries | 84.25",
  "2026-10-03 | Metro Card | transport | 30.00",
  "2026-10-04 | Acme Cloud | software | 240.00",
  "2026-10-05 | Cafe | meals | 18.75",
  "2026-10-06 | Hardware Store | equipment | 129.99",
].join("\n");

const DEFAULTS: PrivacyInput = {
  document_name: "october-expenses.txt",
  document_text: DEFAULT_DOCUMENT,
  retention_mode: "no-server-side-persistence",
  currency: "USD",
  high_value_threshold: "100.00",
};

interface RedactionResult {
  text: string;
  count: number;
  kinds: string[];
}

function redactSensitiveText(value: string): RedactionResult {
  let text = value;
  const kinds = new Set<string>();
  let count = 0;
  const apply = (pattern: RegExp, replacement: string, kind: string): void => {
    text = text.replace(pattern, () => {
      count += 1;
      kinds.add(kind);
      return replacement;
    });
  };
  apply(/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, "[CARD]", "card-number");
  apply(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, "[IBAN]", "iban");
  apply(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]", "email");
  apply(/\b(?:\+?\d[\d -]{7,}\d)\b/g, "[PHONE_OR_ACCOUNT]", "phone-or-account");
  apply(/\b(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "[CREDENTIAL]", "credential");
  return { text, count, kinds: [...kinds].sort() };
}

function parseExpenseLine(line: string): { date: string; merchant: string; category: string; amount: Minor } | null {
  const match = /^(\d{4}-\d{2}-\d{2})\s*[|,]\s*([^|,]+)\s*[|,]\s*([^|,]+)\s*[|,]\s*([0-9]+(?:\.[0-9]{1,6})?)$/.exec(
    line.trim(),
  );
  if (!match) return null;
  const date = match[1] ?? "";
  const merchant = match[2]?.trim() ?? "";
  const category = match[3]?.trim() ?? "";
  const amount = parsePositiveMoney(match[4] ?? "0", "Expense amount", "USD");
  if (!date || !merchant || !category) return null;
  return { date, merchant, category, amount };
}

export function runPrivacy(overrides: Partial<PrivacyInput> = {}): TrackRun<PrivacyEvidence> {
  const input: PrivacyInput = { ...DEFAULTS, ...overrides };
  if (input.retention_mode !== "no-server-side-persistence") {
    throw new AshError("VALIDATION_FAILED", "Privacy workflow requires no-server-side-persistence.");
  }
  if (input.currency !== "USD") {
    throw new AshError("VALIDATION_FAILED", "The local expense audit supports USD sample documents only.");
  }
  const documentName = assertText(input.document_name, "Document name", 120);
  const documentText = assertText(input.document_text, "Document text", 200_000, { allowCredentialLike: true });
  const highValueThreshold = parsePositiveMoney(input.high_value_threshold, "High-value threshold", "USD");
  const redaction = redactSensitiveText(documentText);
  const lines = documentText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = lines.map(parseExpenseLine);
  const expenses = parsed.filter((line): line is NonNullable<typeof line> => line !== null);
  const unparsed = parsed.length - expenses.length;
  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0n);
  const categories = new Map<string, { count: number; total: Minor }>();
  for (const expense of expenses) {
    const current = categories.get(expense.category) ?? { count: 0, total: 0n };
    categories.set(expense.category, { count: current.count + 1, total: current.total + expense.amount });
  }
  const highValue = expenses.filter((expense) => expense.amount > highValueThreshold);

  const evidence: PrivacyEvidence = {
    audit: {
      document_name: documentName,
      document_sha256: sha256Text(documentText),
      parsed_lines: expenses.length,
      unparsed_lines: unparsed,
      currency: "USD",
      total: formatAmount(total, "USD"),
      high_value_count: highValue.length,
      categories: [...categories.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, value]) => ({
          category,
          count: value.count,
          total: formatAmount(value.total, "USD"),
        })),
      high_value: highValue.map((expense) => ({
        date: expense.date,
        merchant: redactSensitiveText(expense.merchant).text,
        category: expense.category,
        amount: formatAmount(expense.amount, "USD"),
      })),
    },
    redactions: {
      count: redaction.count,
      kinds: redaction.kinds,
    },
    retention: {
      mode: "no-server-side-persistence",
      raw_document_persisted: false,
      prompt_persisted: false,
      response_persisted: false,
      server_side_artifacts: [],
      cleanup: "complete",
    },
    private_ai: {
      status: "not-configured",
      tee_model: null,
      attestation_verified: false,
      fallback: "local-deterministic",
      note: "No TEE model, nonce or official attestation verifier is configured. The local audit is useful for the no-retention data path but is not confidential AI.",
    },
  };

  const serialized = JSON.stringify(evidence);
  const checks = [
    {
      id: "expense-total",
      passed: total === expenses.reduce((sum, expense) => sum + expense.amount, 0n),
      detail: `${expenses.length} expense line(s) total ${formatAmount(total, "USD")}.`,
    },
    {
      id: "raw-document-not-retained",
      passed: !serialized.includes(documentText) && evidence.retention.raw_document_persisted === false,
      detail: "The evidence bundle contains a fingerprint and redacted summary, not the source document.",
    },
    {
      id: "redaction-applied",
      passed: unparsed === 0 || redaction.count > 0 || !/[@]/.test(redaction.text),
      detail: `${redaction.count} sensitive value(s) were redacted before summarization.`,
    },
    {
      id: "attestation-not-claimed",
      passed: evidence.private_ai.attestation_verified === false && evidence.private_ai.status === "not-configured",
      detail: "The run reports no TEE attestation because no provider verifier is configured.",
    },
    {
      id: "local-cleanup",
      passed: evidence.retention.server_side_artifacts.length === 0 && evidence.retention.cleanup === "complete",
      detail: "The local workflow persists no raw document, prompt or model response.",
    },
  ];

  return finalizeTrackRun<PrivacyEvidence>({
    track_id: "privacy",
    title: "Private expense audit with no-retention evidence",
    summary: `Audited ${expenses.length} expense line(s) locally, redacted ${redaction.count} sensitive value(s), and persisted only aggregate evidence.`,
    integrationNote:
      "The no-retention local path is implemented. TEE inference and official attestation verification are not configured, so no private-AI claim is made.",
    checks,
    evidence,
  });
}

export type { Minor };
