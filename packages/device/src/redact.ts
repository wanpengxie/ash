/** Best-effort display redaction, not a sandbox. Files on disk remain unchanged. */
export function redactText(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[private key redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=\-]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|authorization|password|secret|token|access_token|refresh_token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1"[redacted]"');
}
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, typeof item === "string" && /^(api[_-]?key|authorization|password|secret|token|access_token|refresh_token)$/i.test(key) ? "[redacted]" : redact(item)]));
  return value;
}
