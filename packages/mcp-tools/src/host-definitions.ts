import type { ToolDefinition } from "./definitions.js";
import type { ToolAction, ToolDomain, ToolRisk } from "./catalog.js";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
const serverPlugin = { server_plugin_id: { type: "string", format: "uuid" }, reason: { type: ["string", "null"], maxLength: 1000 } };
const idempotency = { idempotency_key: { type: "string", minLength: 16 } };
const output = object({ operation_id: { type: "string", format: "uuid" }, status: { type: "string" } }, ["operation_id", "status"]);

function host(name: string, domain: ToolDomain, action: ToolAction, risk: ToolRisk, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDefinition {
  const isWrite = action !== "read";
  return { name, version: 1, category: isWrite ? "write" : "read", isWrite, inputSchema: object({ ...serverPlugin, ...properties, ...(isWrite ? idempotency : {}) }, ["server_plugin_id", ...required, ...(isWrite ? ["idempotency_key"] : [])]), outputSchema: output, domain, action, risk, reversible: !["remove"].includes(action), executorKind: "wp_cli", credentialKinds: ["ssh_private_key"], supportsDryRun: false, isLongRunning: true, description };
}

const named = { name: { type: "string", minLength: 1, maxLength: 200 } };
export const HOST_TOOL_DEFINITIONS: ToolDefinition[] = [
  host("wordpress.install_plugin", "plugins", "create", "high", "Install a plugin through WP-CLI.", { ...named, activate: { type: "boolean" } }, ["name"]),
  host("wordpress.activate_plugin", "plugins", "operate", "high", "Activate a plugin.", named, ["name"]),
  host("wordpress.deactivate_plugin", "plugins", "operate", "medium", "Deactivate a plugin.", named, ["name"]),
  host("wordpress.update_plugin", "plugins", "change", "high", "Update a plugin.", named, ["name"]),
  host("wordpress.remove_plugin", "plugins", "remove", "high", "Remove a plugin.", named, ["name"]),
  host("wordpress.install_theme", "themes", "create", "high", "Install a theme through WP-CLI.", { ...named, activate: { type: "boolean" } }, ["name"]),
  host("wordpress.activate_theme", "themes", "operate", "high", "Activate a theme.", named, ["name"]),
  host("wordpress.update_theme", "themes", "change", "high", "Update a theme.", named, ["name"]),
  host("wordpress.remove_theme", "themes", "remove", "high", "Remove a theme.", named, ["name"]),
  host("wordpress.get_core_version", "wordpress_core", "read", "low", "Read the WordPress core version."),
  host("wordpress.verify_core_checksums", "wordpress_core", "operate", "medium", "Verify WordPress core checksums."),
  host("wordpress.update_core", "wordpress_core", "change", "critical", "Update WordPress core."),
  host("wordpress.set_maintenance_mode", "wordpress_core", "operate", "high", "Enable or disable maintenance mode.", { enabled: { type: "boolean" } }, ["enabled"]),
  host("wordpress.cache_status", "cache_runtime", "read", "low", "Inspect the configured object cache."),
  host("wordpress.flush_cache", "cache_runtime", "operate", "medium", "Flush the WordPress object cache."),
  host("wordpress.list_cron_events", "diagnostics_logs", "read", "low", "List scheduled cron events."),
  host("wordpress.run_cron_event", "diagnostics_logs", "operate", "medium", "Run a named cron hook.", { hook: { type: "string" } }, ["hook"]),
  host("wordpress.delete_cron_event", "diagnostics_logs", "remove", "high", "Delete a named cron event.", { hook: { type: "string" } }, ["hook"]),
  host("wordpress.flush_rewrite_rules", "site_settings", "operate", "medium", "Flush rewrite rules."),
  host("wordpress.get_server_diagnostics", "diagnostics_logs", "read", "low", "Read bounded server diagnostics."),
  host("wordpress.get_php_version", "diagnostics_logs", "read", "low", "Read the PHP version used by WP-CLI."),
  host("wordpress.read_log", "diagnostics_logs", "read", "medium", "Read a bounded configured diagnostic log.", { log: { type: "string" }, lines: { type: "integer", minimum: 1, maximum: 2000 } }, ["log"])
];

function workspace(name: string, action: ToolAction, risk: ToolRisk, description: string): ToolDefinition {
  const write = action !== "read";
  return { name, version: 1, category: write ? "write" : "read", isWrite: write, inputSchema: object({ ...serverPlugin, workspace: { type: "string" }, path: { type: ["string", "null"] }, expected_hash: { type: ["string", "null"] }, content: { type: ["string", "null"] }, command: { type: ["string", "null"] }, ...(write ? idempotency : {}) }, ["server_plugin_id", "workspace", ...(write ? ["idempotency_key"] : [])]), outputSchema: output, domain: "files_code", action, risk, reversible: action !== "remove", executorKind: "workspace", credentialKinds: ["ssh_private_key"], supportsDryRun: false, isLongRunning: true, description };
}

export const WORKSPACE_TOOL_DEFINITIONS = [
  workspace("workspace_list_files", "read", "low", "List files within an allowed workspace."), workspace("workspace_search_files", "read", "low", "Search within allowed workspace files."),
  workspace("workspace_read_file", "read", "low", "Read an allowed workspace file."), workspace("workspace_get_file_hash", "read", "low", "Hash an allowed workspace file."),
  workspace("workspace_show_diff", "read", "low", "Show the workspace Git diff."), workspace("workspace_git_status", "read", "low", "Show workspace Git status."),
  workspace("workspace_create_file", "create", "medium", "Create a staged workspace file."), workspace("workspace_update_file", "change", "medium", "Update a staged workspace file with optimistic concurrency."),
  workspace("workspace_rename_file", "change", "medium", "Rename a workspace file."), workspace("workspace_remove_file", "remove", "high", "Remove a workspace file."),
  workspace("workspace_apply_patch", "change", "high", "Apply a bounded patch."), workspace("workspace_run_command", "operate", "medium", "Run a configured named command."),
  workspace("workspace_create_branch", "create", "medium", "Create a Git branch."), workspace("workspace_commit", "create", "medium", "Commit staged workspace changes."),
  workspace("workspace_stage_deploy", "operate", "high", "Stage or deploy workspace changes."), workspace("workspace_rollback", "operate", "high", "Roll back a workspace deployment.")
];

export const HOST_SESSION_TOOL_DEFINITIONS: ToolDefinition[] = ["host_session_read", "host_session_constrained", "host_session_full_shell", "host_session_root", "host_session_file_transfer"].map((name) => ({
  name, version: 1, category: "write", isWrite: true, inputSchema: object({ ...serverPlugin }, ["server_plugin_id"]), outputSchema: object({ session_id: { type: "string" } }, ["session_id"]),
  domain: "host_access", action: "operate", risk: name === "host_session_root" ? "critical" : name === "host_session_full_shell" ? "critical" : "high", reversible: true,
  executorKind: "host_session", credentialKinds: ["ssh_private_key"], supportsDryRun: false, isLongRunning: true, description: `Open an explicitly authorized ${name.replaceAll("_", " ")} session.`
}));
