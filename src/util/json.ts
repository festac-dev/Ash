import { createHash } from "node:crypto";
import { AshError } from "../errors.js";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Deterministic JSON serialization: object keys sorted at every depth, no
 * whitespace. Used for receipt hashing, so a receipt must never contain
 * undefined, bigint, functions or non-finite numbers.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function sortJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AshError("VALIDATION_FAILED", "Cannot canonicalize a non-finite number.");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // __proto__ is valid JSON data; assigning it to {} would silently drop it
    // from hashes by invoking Object.prototype's legacy setter.
    const result: Record<string, JsonValue> = Object.create(null);
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      result[key] = sortJson(item);
    }
    return result;
  }
  throw new AshError(
    "VALIDATION_FAILED",
    `Cannot canonicalize a value of type ${typeof value}; receipts may only contain JSON data.`,
  );
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Parse JSON with a size guard and a useful, non-leaking error. */
export function parseJson<T = unknown>(text: string, label = "JSON"): T {
  if (Buffer.byteLength(text, "utf8") > 16 * 1024 * 1024) {
    throw new AshError("VALIDATION_FAILED", `${label} is larger than the 16 MiB limit.`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new AshError("VALIDATION_FAILED", `${label} is not valid JSON.`, { cause: error });
  }
}

/**
 * Models often wrap JSON in prose or fences. Extract the outermost object and
 * then let the caller validate it strictly.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new AshError("MODEL_RESPONSE_INVALID", "The model did not return a JSON object.");
    }
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch (error) {
      throw new AshError("MODEL_RESPONSE_INVALID", "The model returned malformed JSON.", { cause: error });
    }
  }
}
