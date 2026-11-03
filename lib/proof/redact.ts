// Bodies are redacted before they are written to a trace. Card data and credentials never reach the
// database, the report or the analyst.

const SECRET_KEYS = new Set([
  "number",
  "security_code",
  "expiry",
  "access_token",
  "refresh_token",
  "id_token",
  "authorization",
  "client_secret",
  "password",
  "runkey",
]);

export const REDACTED = "[REDACTED]";

/** A copy of `value` with every secret field replaced, at any depth. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : redact(field),
    ]),
  );
}

/** Parses a JSON body for the trace. Anything else is kept as a short note, not as raw text. */
export function traceBody(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return redact(JSON.parse(text));
  } catch {
    return { unparsed: `${text.length} bytes, not JSON` };
  }
}
