import type { ToolDefinition } from "@aibroker/mcp-tools";
import type {
  AccessLevelMap,
  BrokerPlugin,
  BrokerToolResult,
  CapabilityRecord,
  PluginExecutionContext,
  PluginProbeContext,
  ServerContext
} from "@aibroker/plugin-sdk";
import { runtimeExecutor, runtimeProbe } from "@aibroker/plugin-sdk";

export interface PlaywrightConfig extends Record<string, unknown> {
  base_url: string;
  allowed_origins: string[];
  allowed_path_prefixes: string[];
  viewport_width: number;
  viewport_height: number;
  locale: string;
  timezone: string;
  color_scheme: "light" | "dark" | "no-preference";
  artifact_retention_seconds: number;
}

type Executor = (tool: string, input: Record<string, unknown>, context: PluginExecutionContext) => Promise<BrokerToolResult>;
type Probe = (context: PluginProbeContext) => Promise<CapabilityRecord[]>;

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", additionalProperties: false, properties, required });
const target = {
  server_plugin_id: { type: "string", format: "uuid" },
  session_id: { type: ["string", "null"], format: "uuid" },
  url: { type: ["string", "null"], maxLength: 2048 },
  wait_until: { type: "string", enum: ["load", "domcontentloaded", "settled"], default: "load" }
};
const baseOutput = { final_url: { type: "string" }, title: { type: "string" }, status: { type: ["integer", "null"] },
  truncated: { type: "boolean" }, dropped_count: { type: "integer" } };
const commonOutput = obj(baseOutput);
const locatorSchema = {
  type: "object", additionalProperties: false, maxProperties: 2,
  properties: {
    role: { type: "string", maxLength: 100 }, name: { type: "string", maxLength: 500 },
    label: { type: "string", maxLength: 500 }, text: { type: "string", maxLength: 500 }, test_id: { type: "string", maxLength: 500 }
  },
  anyOf: [{ required: ["role"] }, { required: ["label"] }, { required: ["text"] }, { required: ["test_id"] }]
};

function definition(name: string, risk: ToolDefinition["risk"], description: string,
  properties: Record<string, unknown> = {}, output = commonOutput,
  options: { write?: boolean; action?: ToolDefinition["action"]; required?: string[] } = {}): ToolDefinition {
  const write = options.write === true;
  const required = options.required ?? [];
  const scopedTarget = { ...target,
    ...(required.includes("session_id") ? { session_id: { type: "string", format: "uuid" } } : {}),
    ...(required.includes("url") ? { url: { type: "string", minLength: 1, maxLength: 2048 } } : {}) };
  return {
    name, version: 1, category: write ? "write" : "read", isWrite: write,
    inputSchema: obj({ ...scopedTarget, ...properties }, ["server_plugin_id", ...required]), outputSchema: output,
    domain: name === "playwright.capture_screenshot" ? "browser_artifacts" : "browser_inspection",
    action: options.action ?? "read", risk, reversible: !write, executorKind: "browser",
    credentialKinds: [], supportsDryRun: false, isLongRunning: false, description
  };
}

export const PLAYWRIGHT_TOOL_DEFINITIONS: ToolDefinition[] = [
  definition("playwright.capture_screenshot", "low", "Capture a bounded screenshot of an allowed target page.", {
    full_page: { type: "boolean", default: false },
    locator: { anyOf: [locatorSchema, { type: "null" }] }
  }, obj({ ...baseOutput, artifact: { type: "object" } })),
  definition("playwright.get_page_metadata", "low", "Read bounded metadata from an allowed target page.", {}, obj({ ...baseOutput, metadata: { type: "object" } })),
  definition("playwright.get_page_snapshot", "low", "Read a bounded accessibility snapshot from an allowed target page.", {
    max_nodes: { type: "integer", minimum: 1, maximum: 1000, default: 500 }
  }, obj({ ...baseOutput, snapshot: { type: "string" } })),
  definition("playwright.get_console_messages", "medium", "Capture bounded, redacted console messages while loading an allowed page.", {
    levels: { type: "array", maxItems: 5, items: { type: "string", enum: ["debug", "info", "log", "warning", "error"] } },
    cursor: { type: "integer", minimum: 0 }
  }, obj({ ...baseOutput, messages: { type: "array" }, next_cursor: { type: "integer" }, event_count: { type: "integer" } })),
  definition("playwright.get_page_errors", "medium", "Capture bounded, redacted page errors while loading an allowed page.", {
    cursor: { type: "integer", minimum: 0 }
  }, obj({ ...baseOutput, errors: { type: "array" }, next_cursor: { type: "integer" }, event_count: { type: "integer" } })),
  definition("playwright.open_session", "medium", "Open a short-lived isolated browser session on an allowed page.", {}, obj({
    session_id: { type: "string" }, current_url: { type: "string" }, status: { type: "string" }, idle_expires_at: { type: "string" }, absolute_expires_at: { type: "string" }
  }), { action: "operate" }),
  definition("playwright.navigate", "medium", "Navigate an owned browser session within its configured destination scope.", {}, commonOutput,
    { action: "operate", required: ["session_id", "url"] }),
  definition("playwright.close_session", "medium", "Close an owned browser session and release its runtime context.", {}, obj({ status: { type: "string" } }),
    { action: "operate", required: ["session_id"] }),
  definition("playwright.list_sessions", "medium", "List browser sessions owned by the current API token.", {}, obj({ sessions: { type: "array" } })),
  definition("playwright.fill", "medium", "Fill one strict semantic locator without submitting the page.", {
    locator: locatorSchema, value: { type: "string", maxLength: 10000 }
  }, commonOutput, { action: "operate", required: ["session_id", "locator", "value"] }),
  definition("playwright.select_option", "medium", "Select bounded values in one strict semantic locator.", {
    locator: locatorSchema, values: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 500 } }
  }, commonOutput, { action: "operate", required: ["session_id", "locator", "values"] }),
  definition("playwright.press_key", "medium", "Press one reviewed navigation or editing key in a strict semantic locator.", {
    locator: locatorSchema, key: { type: "string", enum: ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Space"] }
  }, commonOutput, { action: "operate", required: ["session_id", "locator", "key"] }),
  definition("playwright.wait_for", "medium", "Wait briefly for a reviewed state on one strict semantic locator.", {
    locator: locatorSchema, state: { type: "string", enum: ["visible", "hidden", "enabled", "disabled"] },
    timeout_ms: { type: "integer", minimum: 100, maximum: 5000, default: 3000 }
  }, commonOutput, { action: "operate", required: ["session_id", "locator", "state"] }),
  definition("playwright.click", "medium", "Click one strict semantic locator in an owned session.", {
    locator: locatorSchema, idempotency_key: { type: "string", minLength: 16 }, reason: { type: "string", minLength: 1, maxLength: 500 }
  }, commonOutput, { write: true, action: "change", required: ["session_id", "locator", "idempotency_key"] })
];

const all = PLAYWRIGHT_TOOL_DEFINITIONS.map((tool) => tool.name);
const inspection = PLAYWRIGHT_TOOL_DEFINITIONS.filter((tool) => !["playwright.fill", "playwright.select_option", "playwright.press_key", "playwright.click"].includes(tool.name)).map((tool) => tool.name);
const accessLevels: AccessLevelMap = {
  none: { label: "None", description: "No browser access.", riskCeiling: null, toolNames: [] },
  read: { label: "Read", description: "Inspect and navigate allowed pages without changing form state.", riskCeiling: "medium", toolNames: inspection },
  contribute: { label: "Contribute", description: "Inspect and perform reviewed browser interactions.", riskCeiling: "medium", toolNames: all },
  manage: { label: "Manage", description: "Inspect allowed pages and manage browser artifacts.", riskCeiling: "high", toolNames: all },
  full: { label: "Full", description: "All reviewed browser inspection tools.", riskCeiling: "critical", toolNames: all }
};

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("allowed_origins must contain exact HTTP(S) origins without paths or credentials");
  }
  return url.origin;
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

export function normalizePlaywrightConfig(config: Record<string, unknown>, server: ServerContext): PlaywrightConfig {
  const base = new URL(String(config.base_url ?? `https://${server.address}`));
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) throw new Error("base_url must be an HTTP(S) URL without credentials");
  const origins = [...new Set((strings(config.allowed_origins).length ? strings(config.allowed_origins) : [base.origin]).map(exactOrigin))];
  if (!origins.includes(base.origin)) throw new Error("base_url origin must be included in allowed_origins");
  const width = Number(config.viewport_width ?? 1440), height = Number(config.viewport_height ?? 900);
  if (!Number.isInteger(width) || width < 320 || width > 2560 || !Number.isInteger(height) || height < 240 || height > 2000) throw new Error("viewport is outside the allowed range");
  const retention = Number(config.artifact_retention_seconds ?? 86400);
  if (!Number.isInteger(retention) || retention < 300 || retention > 604800) throw new Error("artifact retention must be between 300 and 604800 seconds");
  const scheme = String(config.color_scheme ?? "no-preference");
  if (!["light", "dark", "no-preference"].includes(scheme)) throw new Error("invalid color_scheme");
  return {
    base_url: base.toString(), allowed_origins: origins,
    allowed_path_prefixes: strings(config.allowed_path_prefixes).map((path) => path.startsWith("/") ? path : `/${path}`),
    viewport_width: width, viewport_height: height,
    locale: String(config.locale ?? "en-US"), timezone: String(config.timezone ?? "UTC"),
    color_scheme: scheme as PlaywrightConfig["color_scheme"], artifact_retention_seconds: retention
  };
}

export const playwrightPlugin: BrokerPlugin = {
  key: "playwright", name: "Playwright Browser", version: 2,
  description: "Inspect allowed pages with isolated one-shot calls or short-lived, typed browser sessions.",
  cardinality: "singleton", scope: "target", minRoleToEnable: "team_admin",
  configVars: ["server.address"],
  configSchema: {
    type: "object", additionalProperties: false,
    properties: {
      base_url: { type: "string", format: "uri", title: "Base URL", default: "https://${server.address}" },
      allowed_origins: { type: "array", title: "Allowed origins", items: { type: "string" } },
      allowed_path_prefixes: { type: "array", title: "Allowed path prefixes", items: { type: "string" } },
      viewport_width: { type: "integer", title: "Viewport width", default: 1440 },
      viewport_height: { type: "integer", title: "Viewport height", default: 900 },
      locale: { type: "string", title: "Locale", default: "en-US" },
      timezone: { type: "string", title: "Timezone", default: "UTC" },
      color_scheme: { type: "string", title: "Color scheme", enum: ["no-preference", "light", "dark"], default: "no-preference" },
      artifact_retention_seconds: { type: "integer", title: "Artifact retention seconds", default: 86400 }
    }, required: ["base_url", "allowed_origins"]
  },
  defaultConfig(server) { return normalizePlaywrightConfig({}, server); },
  normalizeConfig(config, server) { return normalizePlaywrightConfig(config, server); },
  credentialKinds: ["browser_storage_state"],
  domains: [{ key: "browser_inspection", label: "Browser Inspection" }, { key: "browser_artifacts", label: "Browser Artifacts" }],
  tools: PLAYWRIGHT_TOOL_DEFINITIONS, accessLevels,
  async probeCapabilities(context) {
    const probe = runtimeProbe(context, "playwright") as Probe | undefined;
    if (!probe) throw new Error("browser_runtime_unavailable");
    return probe(context);
  },
  async execute(tool, input, context) {
    const executor = runtimeExecutor(context, "playwright") as Executor | undefined;
    if (!executor) throw new Error("browser_runtime_unavailable");
    return executor(tool.name, input, context);
  },
  auditDiff(before, after) { return { playwright_instance: { before, after } }; }
};

export const playwrightToolsByRisk = (risk: "low" | "medium") => PLAYWRIGHT_TOOL_DEFINITIONS.filter((tool) => tool.risk === risk).map((tool) => tool.name);
