import { redactObject } from "@aibroker/core";

export interface AuditEventInput {
  requestId: string;
  eventType: string;
  actorUserId?: string;
  actorTokenId?: string;
  serverId?: string;
  toolName?: string;
  status: "success" | "failure" | "denied";
  input?: Record<string, unknown>;
  errorCode?: string;
  durationMs?: number;
  clientIp?: string;
  userAgent?: string;
  // Pre-encrypted full-fidelity body ({ input, result | error }), already run
  // through the crypto vault by the caller. Written verbatim to the existing
  // audit_events.encrypted_payload column. Only supplied when body capture
  // (AIBROKER_MCP_CAPTURE_BODIES) is on; omit to leave the column null.
  encryptedPayload?: unknown;
  // Phase 1.7 normalized audit metadata. All optional so existing call servers keep
  // working; later phases populate operation/session ids for durable work and sessions.
  executorKind?: string;
  operationId?: string;
  sessionId?: string;
  // Optional audit context. Never required to proceed (WPB-ACCESS decision 19).
  reason?: string;
  // Point-in-time snapshot of the tool's catalog classification.
  toolDomain?: string;
  toolAction?: string;
  toolRisk?: string;
  // Structured error classification, distinct from the free-form errorCode.
  errorClass?: string;
}

export interface AuditDb {
  query<T = unknown>(sql: string, params: unknown[]): Promise<{ rows: T[] }>;
}

export async function writeAuditEvent(db: AuditDb, input: AuditEventInput): Promise<void> {
  const summary = input.input ? redactObject(input.input) : {};
  await db.query(
    `insert into audit_events (
      request_id, event_type, actor_user_id, actor_token_id, server_id, tool_name,
      status, input_summary, encrypted_payload, error_code, duration_ms, client_ip, user_agent,
      executor_kind, operation_id, session_id, reason, tool_domain, tool_action, tool_risk, error_class
    ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      input.requestId,
      input.eventType,
      input.actorUserId ?? null,
      input.actorTokenId ?? null,
      input.serverId ?? null,
      input.toolName ?? null,
      input.status,
      JSON.stringify(summary),
      input.encryptedPayload == null ? null : JSON.stringify(input.encryptedPayload),
      input.errorCode ?? null,
      input.durationMs ?? null,
      input.clientIp ?? null,
      input.userAgent ?? null,
      input.executorKind ?? null,
      input.operationId ?? null,
      input.sessionId ?? null,
      input.reason ?? null,
      input.toolDomain ?? null,
      input.toolAction ?? null,
      input.toolRisk ?? null,
      input.errorClass ?? null
    ]
  );
}
