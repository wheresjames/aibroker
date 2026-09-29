import { MVP_TOOL_DEFINITIONS } from "@aibroker/mcp-tools";
import { runtimeExecutor, runtimeProbe, type AccessLevelMap, type BrokerPlugin, type CapabilityRecord, type PluginExecutionContext, type PluginProbeContext } from "@aibroker/plugin-sdk";

type WordPressExecutor = (toolName: string, input: Record<string, unknown>, context: PluginExecutionContext) => Promise<unknown>;
type WordPressProbe = (context: PluginProbeContext) => Promise<CapabilityRecord[]>;

const domains = [
  ["content", "Content"], ["media", "Media"], ["taxonomy", "Taxonomy"], ["comments", "Comments"],
  ["navigation_design", "Navigation & Design"], ["site_settings", "Server Settings"], ["users_roles", "Users & Roles"],
  ["plugins", "Plugins"], ["themes", "Themes"], ["files_code", "Files & Code"], ["wordpress_core", "WordPress Core"],
  ["database", "Database"], ["backups_recovery", "Backups & Recovery"], ["diagnostics_logs", "Diagnostics & Logs"],
  ["cache_runtime", "Cache & Runtime"], ["multisite", "Multisite"], ["hosting_deployment", "Hosting & Deployment"]
] as const;

const tools = MVP_TOOL_DEFINITIONS.filter((tool) => tool.name.startsWith("wordpress."));
const names = (predicate: (tool: (typeof tools)[number]) => boolean) => tools.filter(predicate).map((tool) => tool.name);
const accessLevels: AccessLevelMap = {
  none: { label: "None", description: "No WordPress access.", riskCeiling: null, toolNames: [] },
  read: {
    label: "Read", description: "Look around without changing anything.", riskCeiling: "medium",
    toolNames: names((tool) => tool.action === "read" && ["low", "medium"].includes(tool.risk))
  },
  contribute: {
    label: "Contribute", description: "Explore and create new drafts without changing or removing existing work.", riskCeiling: "medium",
    toolNames: names((tool) => (tool.action === "read" || tool.action === "create") && ["low", "medium"].includes(tool.risk))
  },
  manage: {
    label: "Manage", description: "Manage the WordPress application, excluding host-level and critical operations.", riskCeiling: "high",
    toolNames: names((tool) => tool.action !== "operate" && tool.risk !== "critical")
  },
  full: {
    label: "Full", description: "Break-glass access including Operate and critical tools.", riskCeiling: "critical",
    toolNames: tools.map((tool) => tool.name)
  }
};

const BOOLEAN_CONFIG = ["elementor_default_publish", "block_privileged_sessions"];

// The admin form submits every field as a string; store booleans as booleans and keep
// the session login path site-relative so it can never point the login elsewhere.
export function normalizeWordPressConfig(config: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...config };
  for (const key of BOOLEAN_CONFIG) if (key in normalized) normalized[key] = normalized[key] === true || normalized[key] === "true";
  if (normalized.login_extra_origins !== undefined) {
    const raw = Array.isArray(normalized.login_extra_origins) ? normalized.login_extra_origins.map(String)
      : String(normalized.login_extra_origins).split(/[\n,]/);
    normalized.login_extra_origins = [...new Set(raw.map((value) => value.trim()).filter(Boolean).map((value) => {
      let url: URL;
      try { url = new URL(value); } catch { throw new Error("login_extra_origins must contain exact https origins without paths"); }
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error("login_extra_origins must contain exact https origins without paths");
      }
      return url.origin;
    }))];
  }
  if (typeof normalized.login_path === "string" && normalized.login_path.trim()) {
    const path = normalized.login_path.trim();
    if (!/^\/[A-Za-z0-9._~/-]*$/.test(path) || path.includes("..") || path.startsWith("//")) {
      throw new Error("login_path must be a site-relative path such as /wp-login.php");
    }
    normalized.login_path = path;
  } else {
    delete normalized.login_path;
  }
  return normalized;
}

export const wordpressPlugin: BrokerPlugin = {
  key: "wordpress",
  name: "WordPress",
  version: 1,
  description: "Manage WordPress content, configuration, media, themes, and diagnostics.",
  cardinality: "multi",
  minRoleToEnable: "team_admin",
  configVars: ["server.address"],
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      base_url: { type: "string", format: "uri", title: "Base URL", default: "https://${server.address}" },
      wordpress_path: { type: "string", title: "WordPress path" },
      wp_cli_path: { type: "string", title: "WP-CLI path", default: "wp" },
      login_path: { type: "string", title: "Login path", default: "/wp-login.php",
        description: "Where users' WordPress session logins are sent; change it if the site renamed its login page." },
      elementor_default_publish: { type: "boolean", title: "Elementor edits go live by default", default: false,
        description: "When off, Elementor changes to published pages need publish: true or are saved as the user's draft preview." },
      block_privileged_sessions: { type: "boolean", title: "Block administrator sessions", default: false,
        description: "Refuse WordPress sessions for accounts that can manage options or install plugins." },
      login_extra_origins: { type: "array", title: "Extra login origins", items: { type: "string" },
        description: "Exact origins the live login browser may also load, e.g. a single sign-on provider. Common CAPTCHA providers are always allowed." }
    },
    required: ["base_url"]
  },
  normalizeConfig(config) { return normalizeWordPressConfig(config); },
  credentialKinds: ["wordpress_rest_application_password", "ssh_private_key", "wordpress_session"],
  domains: domains.map(([key, label]) => ({ key, label })),
  tools,
  accessLevels,
  async probeCapabilities(context) {
    const probe = runtimeProbe(context, "wordpress") as WordPressProbe | undefined;
    if (!probe) throw new Error("wordpress_probe_unavailable");
    return probe(context);
  },
  async execute(tool, input, context) {
    const executor = runtimeExecutor(context, "wordpress") as WordPressExecutor | undefined;
    if (!executor) throw new Error("wordpress_executor_unavailable");
    return executor(tool.name, input, context);
  },
  async createTestInstance(context) {
    const factory = context.services.wordpressSandboxFactory as (() => Promise<Record<string, unknown>>) | undefined;
    if (!factory) throw new Error("wordpress_sandbox_unavailable");
    return factory();
  },
  auditDiff(before, after) { return { wordpress_instance: { before, after } }; }
};
