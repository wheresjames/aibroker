import type { CapabilityRecord } from "@aibroker/plugin-sdk";

export interface CapabilityQueryHandle {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

const CAPABILITY_TTL_INTERVAL = "1 hour";

/** Persist the output of any plugin's probe without interpreting plugin-specific fields. */
export async function recordServerPluginCapabilities(
  db: CapabilityQueryHandle,
  serverPluginId: string,
  records: CapabilityRecord[]
): Promise<void> {
  const target = await db.query<{ id: string }>("select id from server_plugins where id=$1", [serverPluginId]);
  if (!target.rows[0]) throw new Error("server_plugin_not_found");
  for (const record of records) {
    await db.query(
      `insert into server_capabilities (server_plugin_id, capability, status, executor_kind, credential_id, details, discovered_at, expires_at, error_code, error_message)
       values ($1,$2,$3,$4,$5,$6::jsonb,now(),now() + interval '${CAPABILITY_TTL_INTERVAL}',$7,$8)
       on conflict (server_plugin_id, capability) do update set
         status=excluded.status, executor_kind=excluded.executor_kind, credential_id=excluded.credential_id,
         details=excluded.details, discovered_at=now(), expires_at=excluded.expires_at,
         error_code=excluded.error_code, error_message=excluded.error_message`,
      [serverPluginId, record.capability, record.status, record.executorKind ?? null,
       record.credentialId ?? null, JSON.stringify(record.details ?? {}), record.errorCode ?? null, record.errorMessage ?? null]
    );
  }
  await db.query("update server_plugins set last_probe_at=now(), updated_at=now() where id=$1", [serverPluginId]);
}
