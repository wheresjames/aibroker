import React from "react";
import type {
  User, Server, Group, GroupMembership, Token, ToolDefinition, Policy, PolicyPermission, Binding,
  EffectiveAccess, AuditEvent, MyActivity, ThemeMode, ToastTone, ToastItem, SelectItem, ComboboxOption, ZxcvbnModule, Api, Runner
} from "./types.js";

export const toolNames = [
  "wordpress.list_sites",
  "wordpress.get_site_summary",
  "wordpress.list_pages",
  "wordpress.get_page",
  "wordpress.create_draft_page",
  "wordpress.update_draft_page",
  "wordpress.publish_page",
  "wordpress.list_posts",
  "wordpress.get_post",
  "wordpress.list_media",
  "wordpress.get_media",
  "wordpress.list_taxonomies",
  "wordpress.list_terms",
  "wordpress.list_custom_post_types",
  "wordpress.list_plugins",
  "wordpress.list_themes",
  "wordpress.get_active_theme",
  "wordpress.run_health_check"
];

// Persist the server-signed session token with the displayed user so a refresh can
// restore the session. The API verifies the signature, expiry, and current user
// state on every request.

export const SESSION_KEY = "wpb:session";

export const SESSION_TTL_MS = 6 * 24 * 60 * 60 * 1000; // 6 days


export function readSession(): User | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { user?: User; expiresAt?: number };
    if (
      !parsed.user ||
      typeof parsed.user.session_token !== "string" ||
      parsed.user.session_token.length === 0 ||
      !parsed.expiresAt ||
      parsed.expiresAt <= Date.now()
    ) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed.user;
  } catch {
    return null;
  }
}


export function writeSession(user: User): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ user, expiresAt: Date.now() + SESSION_TTL_MS }));
  } catch { /* ignore */ }
}


export function clearSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}


export function activityLabel(event: AuditEvent): string {
  switch (event.event_type) {
    case "admin_login":
      return "Signed in";
    case "mcp_tool_call":
      return event.tool_name ? `Tool call: ${event.tool_name}` : "Tool call";
    case "token_create":
      return "Token created";
    case "token_revoke":
      return "Token revoked";
    case "admin_password_change":
      return "Password changed";
    default:
      return event.event_type;
  }
}


export function tokenStoreKey(userId: string) {
  return `wpb:tokenSecrets:${userId}`;
}

export function readTokenSecrets(userId: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(tokenStoreKey(userId)) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function rememberTokenSecret(userId: string, tokenId: string, secret: string) {
  try {
    const map = readTokenSecrets(userId);
    map[tokenId] = secret;
    localStorage.setItem(tokenStoreKey(userId), JSON.stringify(map));
  } catch {
    /* ignore */
  }
}


export let zxcvbnLoader: Promise<ZxcvbnModule | null> | null = null;


export const themeOptions: Array<{ value: ThemeMode; label: string; icon: string }> = [
  { value: "auto", label: "Auto", icon: "▣" },
  { value: "light", label: "Light", icon: "☼" },
  { value: "dark", label: "Dark", icon: "☾" }
];


export function initialTheme(): ThemeMode {
  const stored = globalThis.localStorage?.getItem("zetsec:theme");
  return stored === "light" || stored === "dark" ? stored : "auto";
}


export function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
  if (theme === "auto") {
    localStorage.removeItem("zetsec:theme");
  } else {
    localStorage.setItem("zetsec:theme", theme);
  }
}


export async function scorePassword(password: string): Promise<number> {
  const module = await loadZxcvbn();
  const scorer = module?.default;
  if (scorer) return clampScore(scorer(password).score);
  return fallbackPasswordScore(password);
}


export async function loadZxcvbn(): Promise<ZxcvbnModule | null> {
  if (!zxcvbnLoader) {
    zxcvbnLoader = new Function("return import('zxcvbn')")()
      .then((module: ZxcvbnModule) => module)
      .catch(() => null);
  }
  return zxcvbnLoader;
}


export function fallbackPasswordScore(password: string): number {
  let score = 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (classes >= 2) score += 1;
  if (classes >= 3 && password.length >= 12) score += 1;
  return clampScore(score);
}


export function clampScore(score: number): number {
  return Math.max(0, Math.min(4, Math.trunc(score)));
}


export function formatToastTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}


export async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `Request failed: ${response.status}`);
  return body as T;
}


export function renderCell(value: unknown, column = ""): React.ReactNode {
  if (value == null) return "";
  // Empty optional values should remain empty. In particular, an active token's
  // empty revoked_at value must not become an empty warning-status chip.
  if (value === "") return "";
  if (typeof value === "object" && !React.isValidElement(value)) return JSON.stringify(value);
  if (typeof value === "string" && isStatusColumn(column)) {
    return <span className={`chip ${statusTone(value)}`}>{value}</span>;
  }
  if (["id", "subject_id", "server_id", "token_prefix", "slug"].includes(column)) {
    return <code>{value as React.ReactNode}</code>;
  }
  return value as React.ReactNode;
}


export function flattenUserTree(users: User[], collapsed: Set<string>): Array<{ user: User; depth: number }> {
  const byOwner = new Map<string, User[]>();
  for (const user of users) {
    const key = user.owner_user_id ?? "";
    byOwner.set(key, [...(byOwner.get(key) ?? []), user]);
  }
  for (const children of byOwner.values()) {
    children.sort((a, b) => a.display_name.localeCompare(b.display_name));
  }
  const rows: Array<{ user: User; depth: number }> = [];
  const visit = (ownerId: string, depth: number) => {
    for (const user of byOwner.get(ownerId) ?? []) {
      rows.push({ user, depth });
      if (!collapsed.has(user.id)) visit(user.id, depth + 1);
    }
  };
  visit("", 0);
  return rows;
}


export function ownerLabel(users: User[], ownerUserId?: string | null): string {
  if (!ownerUserId) return "Root owner";
  const owner = users.find((user) => user.id === ownerUserId);
  return owner ? `${owner.display_name} (${owner.email})` : "Unknown owner";
}


export function ownerPath(users: User[], user: User): string {
  const path: string[] = [];
  let ownerId = user.owner_user_id;
  const seen = new Set<string>();
  while (ownerId && !seen.has(ownerId)) {
    seen.add(ownerId);
    const owner = users.find((candidate) => candidate.id === ownerId);
    if (!owner) break;
    path.unshift(owner.display_name);
    ownerId = owner.owner_user_id;
  }
  return path.length ? path.join(" > ") : "Root";
}


export function roleRankUi(role: string): number {
  return { user: 1, auditor: 2, team_admin: 3, global_admin: 4 }[role] ?? 0;
}


export function canOwnRoleUi(ownerRole: string, targetRole: string): boolean {
  return ["team_admin", "global_admin"].includes(ownerRole) && roleRankUi(ownerRole) >= roleRankUi(targetRole);
}


export function isStatusColumn(column: string): boolean {
  return ["status", "connection", "effect", "revoked_at", "error_code"].includes(column);
}


export function statusTone(value: string): string {
  const normalized = value.toLowerCase();
  if (["active", "ok", "success", "succeeded", "allow", "approved", "executed", "production"].includes(normalized)) return "chip-success";
  if (["requested", "pending", "waiting", "staging", "local", "throwaway", "untested", ""].includes(normalized)) return "chip-warning";
  if (["disabled", "error", "failure", "failed", "deny", "rejected", "revoked"].includes(normalized) || normalized.includes("invalid")) return "chip-danger";
  return "chip-muted";
}


// --- Permission matrix (Phase 1.3) ---------------------------------------------------
// Grouping is driven entirely by server-provided catalog metadata (domain/action), never
// inferred from tool names in the browser.

export type MatrixAction = "read" | "create" | "change" | "remove" | "operate";
export type PermState = Record<string, { allow: boolean; deny: boolean }>;

export const MATRIX_ACTIONS: MatrixAction[] = ["read", "create", "change", "remove", "operate"];

export const ACTION_LABELS: Record<MatrixAction, string> = {
  read: "Read",
  create: "Create",
  change: "Change",
  remove: "Remove",
  operate: "Operate"
};

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

export function domainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] ?? domain;
}

// Domains that actually have at least one tool, in the canonical order above.
export function domainsWithTools(tools: ToolDefinition[]): string[] {
  const present = new Set(tools.map((tool) => tool.domain));
  const ordered = Object.keys(DOMAIN_LABELS).filter((domain) => present.has(domain));
  // Include any domain not in the label map (forward compatibility) at the end.
  for (const domain of present) if (!ordered.includes(domain)) ordered.push(domain);
  return ordered;
}

export function cellTools(tools: ToolDefinition[], domain: string, action: string): ToolDefinition[] {
  return tools.filter((tool) => tool.domain === domain && tool.action === action);
}

// checked = every tool has the flag; unchecked = none; indeterminate = some.
export function tristate(tools: ToolDefinition[], perms: PermState, key: "allow" | "deny"): "checked" | "unchecked" | "indeterminate" {
  if (tools.length === 0) return "unchecked";
  const on = tools.filter((tool) => perms[tool.name]?.[key]).length;
  if (on === 0) return "unchecked";
  if (on === tools.length) return "checked";
  return "indeterminate";
}

// Bulk operations preserve explicit denies (WPB-ACCESS decision 4):
//   allow  → set allow=true for each tool (denies untouched)
//   clear  → set allow=false for each tool (denies untouched)
//   deny   → set deny=true for each tool (allows untouched)
//   undeny → set deny=false for each tool (allows untouched)
export function bulkApply(perms: PermState, tools: ToolDefinition[], op: "allow" | "clear" | "deny" | "undeny"): PermState {
  const next = { ...perms };
  for (const tool of tools) {
    const current = next[tool.name] ?? { allow: false, deny: false };
    if (op === "allow") next[tool.name] = { ...current, allow: true };
    else if (op === "clear") next[tool.name] = { ...current, allow: false };
    else if (op === "deny") next[tool.name] = { ...current, deny: true };
    else next[tool.name] = { ...current, deny: false };
  }
  return next;
}

// What changed between two permission states, as explicit tool lists for the save summary.
export function diffPermissions(before: PermState, after: PermState): {
  allowAdded: string[];
  allowRemoved: string[];
  denyAdded: string[];
  denyRemoved: string[];
} {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const result = { allowAdded: [] as string[], allowRemoved: [] as string[], denyAdded: [] as string[], denyRemoved: [] as string[] };
  for (const name of names) {
    const b = before[name] ?? { allow: false, deny: false };
    const a = after[name] ?? { allow: false, deny: false };
    if (!b.allow && a.allow) result.allowAdded.push(name);
    if (b.allow && !a.allow) result.allowRemoved.push(name);
    if (!b.deny && a.deny) result.denyAdded.push(name);
    if (b.deny && !a.deny) result.denyRemoved.push(name);
  }
  return result;
}

export function isHighRisk(risk: string | undefined): boolean {
  return risk === "high" || risk === "critical";
}


// Relative timestamp for dense lists ("3h ago", "12d ago"), per uxdesign.md. Falls
// back to the raw value if it is not a parseable date.
export function relativeTime(value: string | null | undefined): string {
  if (!value) return "";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return String(value);
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "ago" : "from now";
  const sec = Math.round(abs / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ${suffix}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ${suffix}`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ${suffix}`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon}mo ${suffix}`;
  return `${Math.round(mon / 12)}y ${suffix}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  if (min < 60) return `${min}m ${rem}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

export function nextDate(): string {
  const date = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 16);
}
