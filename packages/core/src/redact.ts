const SECRET_KEY_PARTS = [
  "password",
  "token",
  "secret",
  "credential",
  "authorization",
  "cookie",
  "key",
  "encrypted_payload"
];

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

export function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactValue(value);
    }
  }
  return output;
}
