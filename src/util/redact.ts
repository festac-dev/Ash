const secrets = new Set<string>();

const SECRET_PATTERNS: RegExp[] = [
  /\b[A-F0-9]{4}(?:-[A-F0-9]{4}){3}\b/g,
  /[#?](?:ticket|code)=[^\s&]+/g,
  /aat_[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bnvapi-[A-Za-z0-9_-]{16,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(MARKET_API_TOKEN|ASH_MODEL_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN)\s*[=:]\s*["']?[^\s"']{6,}/g,
  /"?(api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|secret)"?\s*:\s*"[^"]{6,}"/gi,
];

/** Register a runtime secret so it is scrubbed from every log line. */
export function registerSecret(value: string | undefined | null): void {
  if (!value || value.length < 6) return;
  secrets.add(value);
}

export function clearRegisteredSecrets(): void {
  secrets.clear();
}

export function redact(input: unknown): string {
  let text = typeof input === "string" ? input : String(input);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => {
      const key = match.match(/^[A-Za-z_]+(?==|:)/);
      return key ? `${key[0]}=[REDACTED]` : "[REDACTED]";
    });
  }
  return text;
}

const SENSITIVE_KEYS = /(token|secret|password|api[_-]?key|private[_-]?key|authorization|cookie|credential)/i;

/** Redact values of sensitive keys for diagnostics, recursively. */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEYS.test(key) ? "[REDACTED]" : redactObject(item, depth + 1);
    }
    return result;
  }
  return value;
}

/** True when a string still contains something that looks like a credential. */
export function containsSecretLike(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
