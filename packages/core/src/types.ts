export type ServerEnvironment = "throwaway" | "local" | "staging" | "production";
export type RecordStatus = "active" | "disabled";

export type UserRole = "global_admin" | "team_admin" | "auditor" | "user";

export interface RequestContext {
  requestId: string;
  userId?: string;
  tokenId?: string;
  clientIp?: string;
  userAgent?: string;
}

export interface ServiceHealth {
  status: "ok" | "degraded" | "error";
  checks: Record<string, "ok" | "error" | "skipped">;
}
