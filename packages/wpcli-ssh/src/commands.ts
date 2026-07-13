export type WpCliTool =
  | "wordpress.list_plugins" | "wordpress.install_plugin" | "wordpress.activate_plugin" | "wordpress.deactivate_plugin" | "wordpress.update_plugin" | "wordpress.remove_plugin"
  | "wordpress.list_themes" | "wordpress.install_theme" | "wordpress.activate_theme" | "wordpress.update_theme" | "wordpress.remove_theme" | "wordpress.get_active_theme"
  | "wordpress.get_core_version" | "wordpress.verify_core_checksums" | "wordpress.update_core" | "wordpress.set_maintenance_mode"
  | "wordpress.cache_status" | "wordpress.flush_cache" | "wordpress.list_cron_events" | "wordpress.run_cron_event" | "wordpress.delete_cron_event"
  | "wordpress.flush_rewrite_rules" | "wordpress.run_health_check" | "wordpress.get_server_diagnostics" | "wordpress.get_php_version" | "wordpress.read_log";
export type NetworkTool = "network_list_sites"|"network_create_site"|"network_update_site"|"network_archive_site"|"network_delete_site"|"network_list_super_admins"|"network_grant_super_admin"|"network_revoke_super_admin"|"network_activate_plugin"|"network_deactivate_plugin"|"network_update_plugin"|"network_enable_theme"|"network_assign_user"|"network_update_core_database"|"network_migrate_domain";

export interface WpCliCommandSpec {
  tool: WpCliTool;
  wpCliPath?: string;
  wordpressPath?: string | null;
  input?: Record<string, unknown>;
}

const simple: Partial<Record<WpCliTool, string[]>> = {
  "wordpress.list_plugins": ["plugin", "list", "--format=json"], "wordpress.list_themes": ["theme", "list", "--format=json"],
  "wordpress.get_active_theme": ["theme", "list", "--status=active", "--format=json"], "wordpress.get_core_version": ["core", "version"],
  "wordpress.verify_core_checksums": ["core", "verify-checksums"], "wordpress.update_core": ["core", "update"],
  "wordpress.cache_status": ["cache", "type"], "wordpress.flush_cache": ["cache", "flush"],
  "wordpress.list_cron_events": ["cron", "event", "list", "--format=json"], "wordpress.flush_rewrite_rules": ["rewrite", "flush"],
  "wordpress.run_health_check": ["server", "health", "--format=json"], "wordpress.get_php_version": ["cli", "info", "--format=json"],
  "wordpress.get_server_diagnostics": ["cli", "info", "--format=json"]
};

export function buildWpCliCommand(spec: WpCliCommandSpec): string[] {
  const executable = spec.wpCliPath?.trim() || "wp";
  if (!isSafePath(executable, false)) throw new Error("Invalid WP-CLI binary path");
  const args = [executable];
  if (spec.wordpressPath) {
    if (!isSafePath(spec.wordpressPath, true)) throw new Error("Invalid WordPress path");
    args.push(`--path=${spec.wordpressPath}`);
  }
  const fixed = simple[spec.tool];
  if (fixed) return [...args, ...fixed];
  const input = spec.input ?? {};
  const name = () => identifier(input.name, "name");
  switch (spec.tool) {
    case "wordpress.install_plugin": return [...args, "plugin", "install", name(), ...(input.activate === true ? ["--activate"] : [])];
    case "wordpress.activate_plugin": return [...args, "plugin", "activate", name()];
    case "wordpress.deactivate_plugin": return [...args, "plugin", "deactivate", name()];
    case "wordpress.update_plugin": return [...args, "plugin", "update", name()];
    case "wordpress.remove_plugin": return [...args, "plugin", "delete", name()];
    case "wordpress.install_theme": return [...args, "theme", "install", name(), ...(input.activate === true ? ["--activate"] : [])];
    case "wordpress.activate_theme": return [...args, "theme", "activate", name()];
    case "wordpress.update_theme": return [...args, "theme", "update", name()];
    case "wordpress.remove_theme": return [...args, "theme", "delete", name()];
    case "wordpress.set_maintenance_mode": return [...args, "maintenance-mode", input.enabled === true ? "activate" : "deactivate"];
    case "wordpress.run_cron_event": return [...args, "cron", "event", "run", identifier(input.hook, "hook")];
    case "wordpress.delete_cron_event": return [...args, "cron", "event", "delete", identifier(input.hook, "hook")];
    case "wordpress.read_log": throw new Error("Log retrieval uses the bounded file reader, not WP-CLI");
    default: throw new Error(`Unsupported WP-CLI tool ${String(spec.tool)}`);
  }
}

export function parseWpCliJson<T = unknown>(output: string): T {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("Empty WP-CLI output");
  return JSON.parse(trimmed) as T;
}

export function buildNetworkCommand(tool:NetworkTool,wpCliPath:string,wordpressPath:string|null,input:Record<string,unknown>):string[]{
  const prefix=buildPrefix(wpCliPath,wordpressPath);const blog=()=>integer(input.blog_id,"blog_id");const user=()=>identifier(input.user,"user");const plugin=()=>identifier(input.name,"name");
  switch(tool){
    case"network_list_sites":return[...prefix,"server","list","--format=json"];
    case"network_create_site":return[...prefix,"server","create",`--slug=${identifier(input.slug,"slug")}`,`--title=${text(input.title,"title")}`,`--email=${text(input.email,"email")}`,"--porcelain"];
    case"network_update_site":return[...prefix,"server","update",blog(),...(input.domain?[`--domain=${text(input.domain,"domain")}`]:[]),...(input.path?[`--path=${text(input.path,"path")}`]:[])];
    case"network_archive_site":return[...prefix,"server",input.archived===true?"archive":"unarchive",blog()];case"network_delete_site":return[...prefix,"server","delete",blog(),"--yes"];
    case"network_list_super_admins":return[...prefix,"super-admin","list"];case"network_grant_super_admin":return[...prefix,"super-admin","add",user()];case"network_revoke_super_admin":return[...prefix,"super-admin","remove",user()];
    case"network_activate_plugin":return[...prefix,"plugin","activate",plugin(),"--network"];case"network_deactivate_plugin":return[...prefix,"plugin","deactivate",plugin(),"--network"];case"network_update_plugin":return[...prefix,"plugin","update",plugin()];case"network_enable_theme":return[...prefix,"theme","enable",plugin(),"--network"];
    case"network_assign_user":return[...prefix,"user","add-role",user(),identifier(input.role,"role"),`--url=${text(input.site_url,"site_url")}`];case"network_update_core_database":return[...prefix,"core","update-db","--network"];
    case"network_migrate_domain":return[...prefix,"search-replace",text(input.old_url,"old_url"),text(input.new_url,"new_url"),"--network","--all-tables-with-prefix","--precise","--report-changed-only"];
  }
}

function buildPrefix(executable:string,wordpressPath:string|null):string[]{if(!isSafePath(executable||"wp",false))throw new Error("Invalid WP-CLI binary path");const out=[executable||"wp"];if(wordpressPath){if(!isSafePath(wordpressPath,true))throw new Error("Invalid WordPress path");out.push(`--path=${wordpressPath}`);}return out;}
function integer(value:unknown,field:string):string{if(!Number.isInteger(value)||Number(value)<1)throw new Error(`Invalid ${field}`);return String(value);}
function text(value:unknown,field:string):string{if(typeof value!=="string"||value.length<1||value.length>500||/[\0\r\n]/.test(value))throw new Error(`Invalid ${field}`);return value;}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.@/+:-]{1,200}$/.test(value)) throw new Error(`Invalid ${field}`);
  return value;
}

function isSafePath(value: string, allowSpaces: boolean): boolean {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r") || value.includes("..")) return false;
  return (allowSpaces ? /^[A-Za-z0-9_./ -]+$/ : /^[A-Za-z0-9_./-]+$/).test(value);
}
