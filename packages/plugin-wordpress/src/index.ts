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
      base_url: { type: "string", format: "uri", title: "Base URL", default: "http://${server.address}" },
      wordpress_path: { type: "string", title: "WordPress path" },
      wp_cli_path: { type: "string", title: "WP-CLI path", default: "wp" }
    },
    required: ["base_url"]
  },
  credentialKinds: ["wordpress_rest_application_password", "ssh_private_key"],
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
