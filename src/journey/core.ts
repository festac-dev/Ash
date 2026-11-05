import { createHash } from "node:crypto";
import path from "node:path";
import { AshError } from "../errors.js";
import { atomicWriteJson, ensurePrivateDir } from "../util/fs.js";
import { newId } from "../util/ids.js";
import { hashJson } from "../util/json.js";
import { formatMinor, parseAmount, type Currency, type Minor } from "../util/money.js";
import { containsSecretLike } from "../util/redact.js";
import { nowIso } from "../util/time.js";

export const TRACK_IDS = ["realworld", "business", "security", "privacy", "swarms", "social"] as const;
export type TrackId = (typeof TRACK_IDS)[number];

export interface TrackCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface TrackIntegration {
  status: "local-simulation";
  authoritative_provider_evidence: false;
  note: string;
}

export interface TrackRun<T> {
  schema_version: 1;
  run_id: string;
  track_id: TrackId;
  title: string;
  mode: "SIMULATION";
  created_at: string;
  summary: string;
  integration: TrackIntegration;
  checks: TrackCheck[];
  evidence: T;
  evidence_sha256: string;
}

export interface TrackRunDraft<T> {
  track_id: TrackId;
  title: string;
  summary: string;
  integrationNote: string;
  checks: TrackCheck[];
  evidence: T;
}

export function isTrackId(value: string): value is TrackId {
  return (TRACK_IDS as readonly string[]).includes(value);
}

export function assertText(
  value: unknown,
  label: string,
  maxChars = 500,
  options: { allowCredentialLike?: boolean } = {},
): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new AshError("VALIDATION_FAILED", `${label} is required.`);
  if (text.length > maxChars)
    throw new AshError("VALIDATION_FAILED", `${label} must be at most ${maxChars} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new AshError("VALIDATION_FAILED", `${label} contains control characters.`);
  }
  if (!options.allowCredentialLike) assertNoSecretLike(text, label);
  return text;
}

export function assertNoSecretLike(value: string, label: string): void {
  if (containsSecretLike(value)) {
    throw new AshError(
      "UNSAFE_INPUT",
      `${label} contains something that looks like a credential. Never paste keys or tokens.`,
    );
  }
}

export function assertAccount(value: unknown, label: string): string {
  const account = assertText(value, label, 64);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(account)) {
    throw new AshError("VALIDATION_FAILED", `${label} must be a lowercase NEAR account name; never a private key.`);
  }
  return account;
}

export function parseMoney(value: string | number | bigint, label: string, currency: Currency): Minor {
  const text = typeof value === "string" ? value.trim() : String(value);
  try {
    return parseAmount(text, currency);
  } catch (error) {
    throw new AshError("VALIDATION_FAILED", `${label} is not a valid ${currency} amount.`, { cause: error });
  }
}

export function parsePositiveMoney(value: string | number | bigint, label: string, currency: Currency): Minor {
  const amount = parseMoney(value, label, currency);
  if (amount <= 0n) throw new AshError("VALIDATION_FAILED", `${label} must be greater than zero.`);
  return amount;
}

export function parseCount(
  value: string | number,
  label: string,
  options: { min?: number; max?: number } = {},
): number {
  const number = typeof value === "number" ? value : Number(value.trim());
  const min = options.min ?? 1;
  const max = options.max ?? 1_000;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AshError("VALIDATION_FAILED", `${label} must be a whole number between ${min} and ${max}.`);
  }
  return number;
}

export function percentWeight(percent: number, label: string): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new AshError("VALIDATION_FAILED", `${label} must be between 0% and 100%.`);
  }
  const scaled = percent * 10_000;
  const weight = Math.round(scaled);
  if (Math.abs(scaled - weight) > 1e-7) {
    throw new AshError("VALIDATION_FAILED", `${label} supports at most four decimal places.`);
  }
  return weight;
}

export interface AllocationPart {
  label: string;
  weight: number;
}

export interface AllocationLine {
  label: string;
  amount: Minor;
}

export function allocateMinor(total: Minor, parts: readonly AllocationPart[]): AllocationLine[] {
  if (total < 0n) throw new AshError("BUDGET_INVARIANT", "Allocation total must not be negative.");
  if (parts.length === 0) throw new AshError("VALIDATION_FAILED", "At least one allocation part is required.");
  const weightSum = parts.reduce((sum, part) => {
    if (!Number.isInteger(part.weight) || part.weight < 0) {
      throw new AshError("VALIDATION_FAILED", `Allocation weight for ${part.label} must be a non-negative integer.`);
    }
    return sum + part.weight;
  }, 0);
  if (weightSum !== 1_000_000) {
    throw new AshError("VALIDATION_FAILED", `Allocation weights must total exactly 100% (got ${weightSum / 10_000}%).`);
  }
  const rows = parts.map((part, index) => {
    const numerator = total * BigInt(part.weight);
    return {
      label: part.label,
      amount: numerator / 1_000_000n,
      remainder: numerator % 1_000_000n,
      index,
    };
  });
  const assigned = rows.reduce((sum, row) => sum + row.amount, 0n);
  const leftover = total - assigned;
  if (leftover < 0n || leftover > BigInt(parts.length)) {
    throw new AshError("BUDGET_INVARIANT", "Allocation remainder is outside the expected range.");
  }
  const order = [...rows].sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });
  for (let index = 0; index < Number(leftover); index += 1) {
    const row = order[index];
    if (row) row.amount += 1n;
  }
  return rows.map((row) => ({ label: row.label, amount: row.amount }));
}

export function equalWeights(count: number): number[] {
  const normalized = parseCount(count, "Split count", { max: 100 });
  const base = Math.floor(1_000_000 / normalized);
  const weights = Array.from({ length: normalized }, () => base);
  for (let index = 0; index < 1_000_000 - base * normalized; index += 1) {
    weights[index] = (weights[index] ?? 0) + 1;
  }
  return weights;
}

export function formatAmount(amount: Minor, currency: Currency): string {
  return formatMinor(amount, currency);
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function seededRandom(seed: string): () => number {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  let state = digest.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvEscape).join(",");
}

export function finalizeTrackRun<T>(draft: TrackRunDraft<T>): TrackRun<T> {
  return {
    schema_version: 1,
    run_id: newId("track"),
    track_id: draft.track_id,
    title: draft.title,
    mode: "SIMULATION",
    created_at: nowIso(),
    summary: draft.summary,
    integration: {
      status: "local-simulation",
      authoritative_provider_evidence: false,
      note: draft.integrationNote,
    },
    checks: draft.checks,
    evidence: draft.evidence,
    evidence_sha256: hashJson(draft.evidence),
  };
}

export async function persistTrackRun(dataDir: string, run: TrackRun<unknown>): Promise<string> {
  const dir = path.join(dataDir, "track-runs");
  await ensurePrivateDir(dir);
  const file = path.join(dir, `${run.track_id}-${run.run_id}.json`);
  await atomicWriteJson(file, run);
  return file;
}

export function allChecksPass(checks: readonly TrackCheck[]): boolean {
  return checks.every((check) => check.passed);
}
