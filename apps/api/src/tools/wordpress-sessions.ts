import type pg from "pg";
import type { AIBrokerConfig } from "@aibroker/core";
import { decryptJson, encryptJson, loadEncryptionKey, type EncryptedPayload } from "@aibroker/crypto";
import {
  completeTwoFactorLogin, loginWordPress, sessionFromBrowserState, WordPressSessionClient, type PendingTwoFactor, type WordPressSessionState
} from "@aibroker/wordpress-rest";
import type { SnapshotRecord, SnapshotStore } from "@aibroker/page-builders";

// Per-user WordPress login sessions (AB-ELEMENTOR D1, D2, D14) and page-builder
// snapshots. A session credential belongs to one AIBroker user; its cookies are
// encrypted like every other credential and never leave the broker.

type Db = Pick<pg.Pool, "query">;
const SNAPSHOT_RETENTION = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVILEGED_CAPABILITIES = ["manage_options", "install_plugins", "activate_plugins", "edit_users"];

export interface SessionMetadata {
  wp_user_id: number;
  wp_user_name: string;
  wp_user_slug: string;
  roles: string[];
  privileged: boolean;
  connected_at: string;
}

export interface SessionTarget {
  id: string;
  config: Record<string, unknown>;
  server: { base_url: string };
}

function key(config: AIBrokerConfig) {
  return loadEncryptionKey(config.encryptionKeyBase64);
}

export async function loadWordPressSession(db: Db, config: AIBrokerConfig, target: SessionTarget, userId: string): Promise<{ credentialId: string; client: WordPressSessionClient } | null> {
  const found = await db.query<{ id: string; encrypted_payload: EncryptedPayload }>(
    `select id, encrypted_payload from server_credentials
     where server_plugin_id=$1 and owner_user_id=$2 and kind='wordpress_session' and status='active'
       and (expires_at is null or expires_at > now())
     order by created_at desc limit 1`, [target.id, userId]);
  const row = found.rows[0];
  if (!row) return null;
  const state = decryptJson<WordPressSessionState>(row.encrypted_payload, key(config));
  // A session is bound to the site it was created on; a changed base URL retires it.
  if (state.version !== 1 || state.baseUrl.replace(/\/$/, "") !== target.server.base_url.replace(/\/$/, "")) return null;
  return { credentialId: row.id, client: new WordPressSessionClient({ state, allowPrivateTargets: config.allowPrivateConnectorTargets }) };
}

export async function markSessionExpired(db: Db, credentialId: string): Promise<void> {
  await db.query("update server_credentials set status='expired' where id=$1 and status='active'", [credentialId]);
}

export class SessionConnectError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

// Background login (capture flow A). The password is used for the login request and
// then dropped — except for a Wordfence 2FA pause, where the pending state (which then
// includes it) is stored encrypted in credential_captures for at most five minutes.
export async function connectWordPressSession(
  db: pg.Pool, config: AIBrokerConfig, target: SessionTarget, userId: string, credentials: { username: string; password: string }
): Promise<{ credentialId: string; expiresAt: Date | null; metadata: SessionMetadata }> {
  const { state, expiresAt } = await loginWordPress({
    baseUrl: target.server.base_url,
    ...(typeof target.config.login_path === "string" ? { loginPath: target.config.login_path } : {}),
    username: credentials.username,
    password: credentials.password,
    allowPrivateTargets: config.allowPrivateConnectorTargets
  });
  return storeWordPressSession(db, config, target, userId, state, expiresAt);
}

export async function completeWordPressTwoFactor(
  db: pg.Pool, config: AIBrokerConfig, target: SessionTarget, userId: string, pending: PendingTwoFactor, code: string
): Promise<{ credentialId: string; expiresAt: Date | null; metadata: SessionMetadata }> {
  const { state, expiresAt } = await completeTwoFactorLogin(pending, code, { allowPrivateTargets: config.allowPrivateConnectorTargets });
  return storeWordPressSession(db, config, target, userId, state, expiresAt);
}

export async function storeBrowserCapturedSession(
  db: pg.Pool, config: AIBrokerConfig, target: SessionTarget, userId: string, storageState: Record<string, unknown>
): Promise<{ credentialId: string; expiresAt: Date | null; metadata: SessionMetadata }> {
  const { state, expiresAt } = await sessionFromBrowserState(target.server.base_url, storageState as Parameters<typeof sessionFromBrowserState>[1],
    { allowPrivateTargets: config.allowPrivateConnectorTargets });
  return storeWordPressSession(db, config, target, userId, state, expiresAt);
}

// Identify the WordPress user, apply the privileged-account policy (D2), and replace the
// caller's stored session with this one. Shared by every capture flow.
export async function storeWordPressSession(
  db: pg.Pool, config: AIBrokerConfig, target: SessionTarget, userId: string, state: WordPressSessionState, expiresAt: Date | null
): Promise<{ credentialId: string; expiresAt: Date | null; metadata: SessionMetadata }> {
  const client = new WordPressSessionClient({ state, allowPrivateTargets: config.allowPrivateConnectorTargets });
  const me = await client.whoAmI();
  const privileged = PRIVILEGED_CAPABILITIES.some((capability) => me.capabilities[capability] === true);
  if (privileged && target.config.block_privileged_sessions === true) {
    await client.logout();
    throw new SessionConnectError("privileged_session_blocked", 403,
      "This server only accepts WordPress sessions for accounts without administrator capabilities. Connect an Editor-level account instead.");
  }
  const metadata: SessionMetadata = {
    wp_user_id: me.id, wp_user_name: me.name, wp_user_slug: me.slug, roles: me.roles, privileged, connected_at: new Date().toISOString()
  };
  const encrypted = encryptJson(client.state(), key(config));
  const connection = await db.connect();
  try {
    await connection.query("begin");
    await connection.query(
      `update server_credentials set status='replaced', replaced_at=now(), encrypted_payload='{}'::jsonb
       where server_plugin_id=$1 and owner_user_id=$2 and kind='wordpress_session' and status in ('active','expired')`, [target.id, userId]);
    const inserted = await connection.query<{ id: string }>(
      `insert into server_credentials(server_plugin_id, kind, owner_user_id, encrypted_payload, expires_at, metadata)
       values ($1, 'wordpress_session', $2, $3::jsonb, $4, $5::jsonb) returning id`,
      [target.id, userId, JSON.stringify(encrypted), expiresAt, JSON.stringify(metadata)]);
    await connection.query("commit");
    return { credentialId: inserted.rows[0]!.id, expiresAt, metadata };
  } catch (err) {
    await connection.query("rollback");
    throw err;
  } finally {
    connection.release();
  }
}

// Disconnect: revoke the WordPress session server-side when still possible, then wipe
// the stored cookies (D14).
export async function disconnectWordPressSession(db: Db, config: AIBrokerConfig, target: SessionTarget, userId: string): Promise<boolean> {
  const session = await loadWordPressSession(db, config, target, userId);
  if (session) await session.client.logout();
  const result = await db.query(
    `update server_credentials set status='disabled', replaced_at=now(), encrypted_payload='{}'::jsonb
     where server_plugin_id=$1 and owner_user_id=$2 and kind='wordpress_session' and status in ('active','expired')`, [target.id, userId]);
  return Boolean(result.rowCount);
}

export function snapshotStore(db: Db, serverPluginId: string, actorUserId: string): SnapshotStore {
  const columns = "id, content_hash, byte_size, tool_name, actor_user_id, created_at";
  return {
    async save(entry) {
      const inserted = await db.query<{ id: string }>(
        `insert into page_builder_snapshots(server_plugin_id, builder, post_id, actor_user_id, tool_name, content_hash, data, byte_size)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [serverPluginId, entry.builder, entry.postId, actorUserId, entry.toolName, entry.hash, entry.data, Buffer.byteLength(entry.data)]);
      await db.query(
        `delete from page_builder_snapshots where id in (
           select id from page_builder_snapshots where server_plugin_id=$1 and builder=$2 and post_id=$3
           order by created_at desc offset $4)`, [serverPluginId, entry.builder, entry.postId, SNAPSHOT_RETENTION]);
      return inserted.rows[0]!.id;
    },
    async list(builder, postId, limit) {
      const rows = await db.query<SnapshotRecord>(
        `select ${columns} from page_builder_snapshots where server_plugin_id=$1 and builder=$2 and post_id=$3
         order by created_at desc limit $4`, [serverPluginId, builder, postId, limit]);
      return rows.rows;
    },
    async get(builder, postId, id) {
      if (!UUID.test(id)) return null;
      const rows = await db.query<SnapshotRecord & { data: string }>(
        `select ${columns}, data from page_builder_snapshots where id=$1 and server_plugin_id=$2 and builder=$3 and post_id=$4`,
        [id, serverPluginId, builder, postId]);
      return rows.rows[0] ?? null;
    }
  };
}
