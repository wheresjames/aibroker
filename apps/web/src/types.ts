export type User = {
  id: string;
  owner_user_id?: string | null;
  owner_display_name?: string | null;
  email: string;
  display_name: string;
  role: string;
  status: string;
  password_change_required: boolean;
  session_token: string;
  child_count?: number;
  descendant_count?: number;
  created_at?: string;
  updated_at?: string;
};


export type Server = {
  id: string;
  name: string;
  slug: string;
  address: string;
  status: string;
  metadata: Record<string, unknown>;
  plugin_count?: number;
  base_url?: string;
  capabilities?: Record<string, unknown>;
  client_name?: string | null;
  tags?: string[];
  multisite_network_slug?: string | null;
  wordpress_path?: string | null;
  wp_cli_path?: string | null;
  last_connection_test?: { status: string; tested_at: string; error_message?: string };
  rest_credential_status?: "none" | "active" | "expired";
};

export type PluginType = {
  key: string; name: string; version: number; description: string; cardinality: "singleton" | "multi";
  config_schema: { properties?: Record<string, { title?: string; type?: string | string[]; default?: unknown; enum?: string[]; items?: { type?: string } }> };
  credential_kinds: string[];
  domains?: Array<{ key: string; label: string }>;
  access_levels?: Record<AccessLevel, { label: string; description: string; riskCeiling: ToolRisk | null; toolNames: string[] }>;
};

export type ServerPlugin = {
  id: string; server_id: string; plugin_key: string; plugin_name: string; instance_name: string;
  status: "enabled" | "disabled" | "removed"; config: Record<string, unknown>; last_probe_at?: string | null;
  capability_count?: number;
  has_active_credential?: boolean;
  active_credential_created_at?: string | null;
  provisioning_status?: "pending" | "provisioning" | "provisioned" | "failed" | "deprovisioned" | null;
  provisioning_profile?: Record<string, unknown> | null;
};

export type SandboxTarget = {
  id: string; plugin_key: string; name: string; status: "running" | "stopped" | "removed";
  connection_config: Record<string, unknown>; secrets: Record<string, unknown>;
  registered_server_id?: string | null; created_at: string; expires_at?: string | null; torn_down_at?: string | null;
};


export type Group = {
  id: string;
  name: string;
  description?: string;
  owner_user_id?: string | null;
  owner_display_name?: string | null;
  member_count?: number;
  server_count?: number;
};

export type GroupMembership = { group_id: string; user_id: string; display_name?: string; email?: string };

export type Token = {
  id: string;
  user_id: string;
  email: string;
  name: string;
  token_prefix: string;
  expires_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
};

export type ToolAction = "read" | "create" | "change" | "remove" | "operate";
export type ToolRisk = "low" | "medium" | "high" | "critical";
export type AccessLevel = "none" | "read" | "contribute" | "manage" | "full";

export type PolicyPluginIntent = {
  id?: string;
  plugin_key: string;
  instance_name?: string | null;
  mode: "simple" | "advanced";
  access_level: AccessLevel;
  risk_ceiling: ToolRisk | null;
  grants: Record<string, ToolAction[]>;
  denied_tools: string[];
  constraints: Record<string, Record<string, unknown>>;
};

export type ToolDefinition = {
  name: string;
  category: "read" | "write" | "diagnostic";
  is_write: boolean;
  // Phase 1 catalog metadata — drives the permission matrix (never inferred from names).
  domain: string;
  action: ToolAction;
  risk: ToolRisk;
  reversible?: boolean;
  executor_kind?: string;
  credential_kinds?: string[];
  description?: string;
  reviewed?: boolean;
};

export type ServerCapability = {
  capability: string;
  plugin_key?: string;
  instance_name?: string;
  status: "available" | "unavailable" | "unknown";
  executor_kind?: string | null;
  details?: Record<string, unknown>;
  discovered_at?: string;
  expires_at?: string | null;
  stale?: boolean;
  error_code?: string | null;
  error_message?: string | null;
};

export type Policy = {
  id: string;
  name: string;
  description?: string | null;
  built_in: boolean;
  permission_count?: number;
  binding_count?: number;
};

export type PolicyPermission = {
  id?: string;
  policy_id?: string;
  tool_name: string;
  effect: "allow" | "deny";
  constraints?: Record<string, unknown>;
};

export type Binding = {
  id: string;
  subject_type: "user" | "group";
  subject_id: string;
  subject_name?: string;
  subject_email?: string;
  server_id: string;
  server_name?: string;
  policy_id: string;
  policy_name?: string;
};

export type EffectiveAccess = {
  matched_bindings?: Array<{
    bindingId?: string;
    policyName?: string;
    subjectType?: string;
    subjectId?: string;
    effect?: string;
    effectiveConstraints?: Record<string, unknown>;
  }>;
  effective_constraints?: Record<string, unknown>;
  tool?: {
    name: string;
    is_write?: boolean;
    domain?: string;
    action?: string;
    risk?: string;
    executor_kind?: string;
    credential_kinds?: string[];
  };
  connector?: {
    required_executor: string | null;
    required_credentials: string[];
    credential_status: "present" | "missing" | "not_required";
    executor_status: "available" | "unavailable" | "unknown";
    connector_mode?: string | null;
  };
  // Folded final explanation: allowed / not_granted / risk_ceiling / constraint_failed / server_disabled /
  // credential_missing / executor_unavailable.
  final?: string;
  decision?: {
    allowed: boolean;
    reason: string;
    matchedBindings?: unknown[];
    effectiveConstraints?: Record<string, unknown>;
  };
};

export type AuditEvent = {
  id: string;
  event_type: string;
  status: string;
  actor_user_id?: string;
  server_id?: string;
  tool_name?: string;
  error_code?: string;
  input_summary: Record<string, unknown>;
  created_at: string;
};

export type McpSession = {
  session_id: string;
  token_id: string;
  token_name?: string | null;
  token_prefix?: string | null;
  owner_email?: string | null;
  owner_name?: string | null;
  client_ip?: string | null;
  user_agent?: string | null;
  started_at: string;
  last_seen: string;
  duration_ms: number;
  calls: number;
  errors: number;
  servers: number;
  state: "live" | "active" | "ended";
  transport?: string;
};

export type McpTrafficEvent = {
  id: string;
  created_at: string;
  tool?: string | null;
  status: string;
  error_code?: string | null;
  duration_ms?: number | null;
  server_id?: string | null;
  server_name?: string | null;
  client_ip?: string | null;
  user_agent?: string | null;
  token_id?: string | null;
  token_prefix?: string | null;
  token_name?: string | null;
  owner_email?: string | null;
  input_summary?: Record<string, unknown>;
  has_body?: boolean;
  // populated by the per-event reveal (/admin/mcp/events/:id)
  body?: unknown;
  request_id?: string;
  actor_user_id?: string;
};

export type MyActivity = {
  events: AuditEvent[];
  last_login_at?: string | null;
  active_tokens: number;
  recent_calls: number;
};

export type ThemeMode = "auto" | "light" | "dark";

export type ToastTone = "success" | "warning" | "error" | "info";

export type ToastItem = {
  id: number;
  text: string;
  tone: ToastTone;
  createdAt: Date;
};


export type SelectItem = { id: string; name?: string; email?: string; display_name?: string };


export type ComboboxOption = {
  value: string;
  label: string;
  detail?: string;
  depth?: number;
};


export type ZxcvbnModule = {
  default?: (password: string) => { score: number };
};


export type Api = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

export type Runner = (label: string, action: () => Promise<void>) => Promise<boolean>;
