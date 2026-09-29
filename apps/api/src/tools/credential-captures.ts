import type pg from "pg";
import type { AIBrokerConfig } from "@aibroker/core";
import { decryptJson, encryptJson, loadEncryptionKey, type EncryptedPayload } from "@aibroker/crypto";

// Shared capture service (AB-ELEMENTOR Phase 2): logins in progress for any plugin —
// a WordPress login paused at its second factor, or a live remote-browser login for
// WordPress sessions or Playwright's stored browser state. One owner, short TTL, and
// the payload is wiped as soon as the capture ends.

type Db = Pick<pg.Pool, "query">;
export type CaptureKind = "wordpress_two_factor" | "wordpress_browser" | "playwright_browser";
export const CAPTURE_TTL_MS = 5 * 60_000;
export const MAX_TWO_FACTOR_ATTEMPTS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Capture<T = Record<string, unknown>> {
  id: string;
  serverPluginId: string;
  ownerUserId: string;
  kind: CaptureKind;
  attempts: number;
  expiresAt: Date;
  payload: T;
}

// Common CAPTCHA and bot-check providers a login page may embed; the live browser may
// load them in addition to the site itself and any configured login origins.
export const CHALLENGE_PROVIDER_ORIGINS = [
  "https://www.google.com", "https://www.gstatic.com", "https://www.recaptcha.net", "https://recaptcha.net",
  "https://hcaptcha.com", "https://js.hcaptcha.com", "https://newassets.hcaptcha.com", "https://api.hcaptcha.com", "https://imgs.hcaptcha.com",
  "https://challenges.cloudflare.com"
];

function key(config: AIBrokerConfig) {
  return loadEncryptionKey(config.encryptionKeyBase64);
}

export async function createCapture(db: Db, config: AIBrokerConfig, input: {
  serverPluginId: string; ownerUserId: string; kind: CaptureKind; payload?: Record<string, unknown>;
}): Promise<string> {
  // A user has at most one open capture per plugin and kind; starting again replaces it.
  await db.query(
    `update credential_captures set status='cancelled', finished_at=now(), encrypted_payload='{}'::jsonb
     where server_plugin_id=$1 and owner_user_id=$2 and kind=$3 and status='pending'`, [input.serverPluginId, input.ownerUserId, input.kind]);
  const inserted = await db.query<{ id: string }>(
    `insert into credential_captures(server_plugin_id, owner_user_id, kind, encrypted_payload, expires_at)
     values ($1,$2,$3,$4::jsonb, now() + ($5::text || ' milliseconds')::interval) returning id`,
    [input.serverPluginId, input.ownerUserId, input.kind, JSON.stringify(encryptJson(input.payload ?? {}, key(config))), String(CAPTURE_TTL_MS)]);
  return inserted.rows[0]!.id;
}

// Only the owner can see or drive a capture; expired ones are closed on access.
export async function loadCapture<T = Record<string, unknown>>(db: Db, config: AIBrokerConfig, id: string, ownerUserId: string, kinds?: CaptureKind[]): Promise<Capture<T> | null> {
  if (!UUID.test(id)) return null;
  const found = await db.query<{ id: string; server_plugin_id: string; owner_user_id: string; kind: CaptureKind; attempts: number; expires_at: string; encrypted_payload: EncryptedPayload; expired: boolean }>(
    `select id, server_plugin_id, owner_user_id, kind, attempts, expires_at, encrypted_payload, expires_at <= now() as expired
     from credential_captures where id=$1 and owner_user_id=$2 and status='pending'`, [id, ownerUserId]);
  const row = found.rows[0];
  if (!row || (kinds && !kinds.includes(row.kind))) return null;
  if (row.expired) { await finishCapture(db, id, "expired"); return null; }
  return {
    id: row.id, serverPluginId: row.server_plugin_id, ownerUserId: row.owner_user_id, kind: row.kind, attempts: row.attempts,
    expiresAt: new Date(row.expires_at),
    // Browser captures carry no payload; never try to decrypt an empty one.
    payload: Object.keys(row.encrypted_payload ?? {}).length ? decryptJson<T>(row.encrypted_payload, key(config)) : ({} as T)
  };
}

export async function updateCapturePayload(db: Db, config: AIBrokerConfig, id: string, payload: Record<string, unknown>, incrementAttempts: boolean): Promise<void> {
  await db.query("update credential_captures set encrypted_payload=$2::jsonb, attempts=attempts+$3 where id=$1 and status='pending'",
    [id, JSON.stringify(encryptJson(payload, key(config))), incrementAttempts ? 1 : 0]);
}

export async function finishCapture(db: Db, id: string, status: "completed" | "cancelled" | "expired" | "failed"): Promise<void> {
  await db.query("update credential_captures set status=$2, finished_at=now(), encrypted_payload='{}'::jsonb where id=$1 and status='pending'", [id, status]);
}

// Origins the live login browser may load for a site: the site, CAPTCHA providers, and
// any admin-configured extra login origins (e.g. an SSO provider).
export function captureOrigins(baseUrl: string, extra: unknown): string[] {
  const configured = Array.isArray(extra) ? extra.map(String) : [];
  return [...new Set([new URL(baseUrl).origin, ...CHALLENGE_PROVIDER_ORIGINS, ...configured])].slice(0, 20);
}
