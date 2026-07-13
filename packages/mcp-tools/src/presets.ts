import { type ToolAction, type ToolCatalogMetadata, type ToolDomain, type ToolRisk } from "./catalog.js";

// Policy presets are policy-editor conveniences (WPB-ACCESS decision 5): assigning one
// expands to explicit per-tool permission rows over the tools that currently exist. They
// never create a hidden "all future tools" layer, and they target domains that later
// phases will fill — those domains simply contribute no rows until their tools ship.

export interface PolicyPreset {
  // Stable, human-facing policy name (also the policies.name value when seeded).
  name: string;
  description: string;
  // Headline risk shown in the editor. Independent of per-tool risk.
  risk: ToolRisk;
  // "allow" grants the matched tools; "deny" writes explicit denies (emergency stop).
  effect: "allow" | "deny";
  // Which resource domains this preset targets. "*" means every domain.
  domains: ToolDomain[] | "*";
  // Which action classes this preset targets. "*" means every action.
  actions: ToolAction[] | "*";
}

export const POLICY_PRESETS: PolicyPreset[] = [
  {
    name: "Read only",
    description: "Read access across every domain. Grants no create, change, remove, or operate tools.",
    risk: "low",
    effect: "allow",
    domains: "*",
    actions: ["read"]
  },
  {
    name: "Content editor",
    description: "Read, create, and change content, media, taxonomy, and navigation. No permanent deletion or administration.",
    risk: "medium",
    effect: "allow",
    domains: ["content", "media", "taxonomy", "navigation_design"],
    actions: ["read", "create", "change"]
  },
  {
    name: "Publisher",
    description: "Content editor plus publication-state changes and controlled trash/restore.",
    risk: "medium",
    effect: "allow",
    domains: ["content", "media", "taxonomy", "navigation_design"],
    actions: ["read", "create", "change", "remove"]
  },
  {
    name: "Server designer",
    description: "Content plus navigation, templates, global styles, and typed serverPlugin settings changes.",
    risk: "medium",
    effect: "allow",
    domains: ["content", "media", "taxonomy", "navigation_design", "site_settings"],
    actions: ["read", "create", "change"]
  },
  {
    name: "Plugin/theme maintainer",
    description: "Full plugin and theme lifecycle: read, install, change, remove, and operate.",
    risk: "high",
    effect: "allow",
    domains: ["plugins", "themes"],
    actions: "*"
  },
  {
    name: "Developer",
    description: "Content, navigation, constrained files & code, diagnostics, and cache/runtime work.",
    risk: "high",
    effect: "allow",
    domains: ["content", "media", "taxonomy", "navigation_design", "files_code", "diagnostics_logs", "cache_runtime"],
    actions: ["read", "create", "change", "remove"]
  },
  {
    name: "Server operator",
    description: "Operate plugins, themes, core, backups, cache, diagnostics, and typed serverPlugin settings.",
    risk: "high",
    effect: "allow",
    domains: ["plugins", "themes", "wordpress_core", "backups_recovery", "cache_runtime", "diagnostics_logs", "site_settings"],
    actions: ["read", "change", "operate"]
  },
  {
    name: "User administrator",
    description: "Manage users, roles, and application passwords. No filesystem, database, or hosting access.",
    risk: "high",
    effect: "allow",
    domains: ["users_roles"],
    actions: "*"
  },
  {
    name: "Full serverPlugin administrator",
    description: "Every single-serverPlugin domain and action. Excludes Full Host, Multisite Network, and Hosting/Deployment.",
    risk: "critical",
    effect: "allow",
    domains: [
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
      "cache_runtime"
    ],
    actions: "*"
  },
  {
    name: "Full host administrator",
    description: "Real Full Shell / Root Access through the configured SSH account. Separate from typed serverPlugin administration.",
    risk: "critical",
    effect: "allow",
    domains: ["host_access"],
    actions: "*"
  },
  {
    name: "Everything",
    description: "Every current tool across every domain and action. Enumerates Full Server, Full Host, Multisite, and Hosting.",
    risk: "critical",
    effect: "allow",
    domains: "*",
    actions: "*"
  },
  {
    name: "Denied",
    description: "Explicitly denies every enabled tool. Emergency stop that wins over any allow.",
    risk: "low",
    effect: "deny",
    domains: "*",
    actions: "*"
  }
];

// Does a tool's catalog metadata fall within a preset's targeted domains/actions?
export function presetMatchesTool(preset: PolicyPreset, meta: Pick<ToolCatalogMetadata, "domain" | "action">): boolean {
  const domainOk = preset.domains === "*" || preset.domains.includes(meta.domain);
  const actionOk = preset.actions === "*" || preset.actions.includes(meta.action);
  return domainOk && actionOk;
}
