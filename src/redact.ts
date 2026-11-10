/** Redact secret values before they reach logs, events, or stdout. Unknown cost is not handled here. */

const TOKENISH = /sk-[A-Za-z0-9]{8,}/g;
const BEARER = /Bearer\s+[A-Za-z0-9._\-]{8,}/g;

export function redactText(input: string, secrets: readonly string[]): string {
  let out = input;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  out = out.replace(TOKENISH, "[REDACTED]").replace(BEARER, "Bearer [REDACTED]");
  if (out.length > 8000) out = out.slice(0, 8000) + "\n[TRUNCATED]";
  return out;
}

export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, secrets);
    return out;
  }
  return value;
}
