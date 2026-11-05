import { AshError } from "../errors.js";

export const CURRENCIES = ["USD", "USDC"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Both supported rails use six decimal places on the market. */
export const MINOR_SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(MINOR_SCALE);
const AMOUNT_PATTERN = /^(0|[0-9]+)(?:\.([0-9]{1,6}))?$/;

export type Minor = bigint;

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/**
 * Parse a human decimal amount into integer minor units without ever using
 * floating point. Negative amounts are rejected; signed adjustments are made
 * by the caller choosing a debit/credit operation.
 */
export function parseAmount(input: string, currency: Currency): Minor {
  const text = String(input).trim();
  const match = AMOUNT_PATTERN.exec(text);
  if (!match) {
    throw new AshError(
      "VALIDATION_FAILED",
      `Invalid ${currency} amount "${text}". Use a positive decimal with at most ${MINOR_SCALE} decimal places.`,
    );
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(MINOR_SCALE, "0");
  return BigInt(whole) * SCALE_FACTOR + BigInt(fraction);
}

export function tryParseAmount(input: string, currency: Currency): Minor | null {
  try {
    return parseAmount(input, currency);
  } catch {
    return null;
  }
}

/**
 * Convert minor units to the canonical decimal string used in records:
 * always at least two decimals, up to six when fractions of a cent exist.
 */
export function formatMinor(minor: Minor, _currency?: Currency): string {
  if (minor < 0n) {
    throw new AshError("BUDGET_INVARIANT", "Money values must not be negative in a receipt or ledger.");
  }
  const whole = minor / SCALE_FACTOR;
  const fraction = (minor % SCALE_FACTOR).toString().padStart(MINOR_SCALE, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return `${whole.toString()}.${trimmed.padEnd(2, "0")}`;
}

/** A short human display, e.g. "$150.00" or "150.00 USDC". */
export function displayMoney(minor: Minor, currency: Currency): string {
  const amount = formatMinor(minor, currency);
  return currency === "USD" ? `$${amount}` : `${amount} USDC`;
}

export function addMoney(a: Minor, b: Minor): Minor {
  return a + b;
}

export function subtractMoney(a: Minor, b: Minor): Minor {
  if (b > a) {
    throw new AshError("BUDGET_INVARIANT", "Refusing to subtract more money than is available.");
  }
  return a - b;
}

export function sumMoney(values: readonly Minor[]): Minor {
  return values.reduce((total, value) => total + value, 0n);
}

export function percentOf(value: Minor, ratio: number): Minor {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new AshError("VALIDATION_FAILED", "A percentage must be between 0 and 1.");
  }
  // Integer arithmetic on a per-million ratio avoids float drift.
  const millionths = BigInt(Math.round(ratio * 1_000_000));
  return (value * millionths) / 1_000_000n;
}

export function isZero(value: Minor): boolean {
  return value === 0n;
}

export function minMoney(a: Minor, b: Minor): Minor {
  return a < b ? a : b;
}
