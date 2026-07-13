import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface GeneratedApiToken {
  token: string;
  prefix: string;
  hash: string;
}

export function generateApiToken(prefix = "wpb"): GeneratedApiToken {
  const suffix = randomBytes(32).toString("base64url");
  const token = `${prefix}_${suffix}`;
  return {
    token,
    prefix: token.slice(0, 12),
    hash: hashApiToken(token)
  };
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function verifyApiToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiToken(token));
  const expected = Buffer.from(expectedHash);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
