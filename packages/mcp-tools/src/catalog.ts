// Shared vocabulary for the AIBroker permission catalog. These identifiers are the
// stable authorization surface: they are stored on tool_definitions, expanded into
// explicit policy_permissions rows, and rendered by the permission-matrix UI. Keep
// them in sync with the migration that backfills tool metadata and with WPB-ACCESS.md.

// Resource domains — the "what part of WordPress/host is affected" axis (matrix rows).
export const TOOL_DOMAINS = [
  "content",
  "media",
  "taxonomy",
  "comments",
  "navigation_design",
  "site_settings",
  "users_roles",
  "plugins",
  "themes",
  "files_code",
  "wordpress_core",
  "database",
  "backups_recovery",
  "diagnostics_logs",
  "cache_runtime",
  "multisite",
  "hosting_deployment",
  "host_access"
] as const;
// Plugins contribute these open identifiers. TOOL_DOMAINS remains the built-in WordPress
// vocabulary used by the Phase 1 policy editor.
export type ToolDomain = string;

// Human labels for the matrix. Internal identifiers stay stable; labels are UI-only.
export const DOMAIN_LABELS: Record<string, string> = {
  content: "Content",
  media: "Media",
  taxonomy: "Taxonomy",
  comments: "Comments",
  navigation_design: "Navigation & Design",
  site_settings: "Server Settings",
  users_roles: "Users & Roles",
  plugins: "Plugins",
  themes: "Themes",
  files_code: "Files & Code",
  wordpress_core: "WordPress Core",
  database: "Database",
  backups_recovery: "Backups & Recovery",
  diagnostics_logs: "Diagnostics & Logs",
  cache_runtime: "Cache & Runtime",
  multisite: "Multisite Network",
  hosting_deployment: "Hosting & Deployment",
  host_access: "Host Access"
};

// Action classes — the "what kind of change" axis (matrix columns). Stable ids per
// WPB-ACCESS.md decision 2; the UI displays the labels below.
export const TOOL_ACTIONS = ["read", "create", "change", "remove", "operate"] as const;
export type ToolAction = (typeof TOOL_ACTIONS)[number];

export const ACTION_LABELS: Record<ToolAction, string> = {
  read: "Read",
  create: "Create",
  change: "Change",
  remove: "Remove",
  operate: "Operate"
};

export const TOOL_RISKS = ["low", "medium", "high", "critical"] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];

// Executor kinds — which connector actually runs the operation. Availability of the
// executor is reported by capability discovery and is independent of authorization.
export const EXECUTOR_KINDS = [
  "rest",
  "wp_cli",
  "workspace",
  "host_session",
  "database",
  "hosting",
  "internal"
] as const;
export type ExecutorKind = string;

// Credential kinds referenced by tool metadata; mirrors server_credentials.kind plus the
// implicit "none" for internal broker tools that need no serverPlugin credential.
export const CREDENTIAL_KINDS = [
  "wordpress_rest_application_password",
  "ssh_private_key",
  "deploy_key",
  "git_provider_token",
  "hosting_provider_token"
] as const;
export type CredentialKind = string;

export interface ToolCatalogMetadata {
  domain: ToolDomain;
  action: ToolAction;
  risk: ToolRisk;
  reversible: boolean;
  executorKind: ExecutorKind;
  credentialKinds: CredentialKind[];
  supportsDryRun: boolean;
  isLongRunning: boolean;
  description: string;
  constraintsSchema?: Record<string, unknown>;
}

const ACTION_SET = new Set<string>(TOOL_ACTIONS);
const RISK_SET = new Set<string>(TOOL_RISKS);

// Validate one tool's catalog metadata. Returns the list of problems (empty == valid).
// Used to reject enabling a tool with incomplete metadata (cross-phase rule).
export function validateToolMetadata(name: string, meta: Partial<ToolCatalogMetadata> | undefined): string[] {
  const problems: string[] = [];
  if (!meta) return [`${name}: missing catalog metadata`];
  if (!meta.domain || !/^[a-z][a-z0-9_]*$/.test(meta.domain)) problems.push(`${name}: invalid domain "${String(meta.domain)}"`);
  if (!meta.action || !ACTION_SET.has(meta.action)) problems.push(`${name}: invalid action "${String(meta.action)}"`);
  if (!meta.risk || !RISK_SET.has(meta.risk)) problems.push(`${name}: invalid risk "${String(meta.risk)}"`);
  if (typeof meta.reversible !== "boolean") problems.push(`${name}: reversible must be boolean`);
  if (!meta.executorKind || !/^[a-z][a-z0-9_]*$/.test(meta.executorKind)) problems.push(`${name}: invalid executor_kind "${String(meta.executorKind)}"`);
  if (!Array.isArray(meta.credentialKinds)) {
    problems.push(`${name}: credential_kinds must be an array`);
  } else {
    for (const kind of meta.credentialKinds) if (!/^[a-z][a-z0-9_]*$/.test(kind)) problems.push(`${name}: invalid credential kind "${String(kind)}"`);
  }
  if (typeof meta.supportsDryRun !== "boolean") problems.push(`${name}: supports_dry_run must be boolean`);
  if (typeof meta.isLongRunning !== "boolean") problems.push(`${name}: is_long_running must be boolean`);
  if (!meta.description || !meta.description.trim()) problems.push(`${name}: description is required`);
  return problems;
}
