import { validateToolMetadata, type ToolDefinition, type ToolRisk } from "@aibroker/mcp-tools";

export type PluginCardinality = "singleton" | "multi";
export type PluginScope = "target" | "broker";
export type BrokerRole = "user" | "team_admin" | "global_admin";

export interface BrokerArtifactReference {
  id: string;
  uri: string;
  mimeType: string;
  size: number;
  sha256: string;
  expiresAt: string;
  redactionStatus?: "not_applicable" | "redacted" | "unredacted";
}

export interface BrokerContentItem {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

/** A typed plugin response. Binary data is transport content, never structured/audit JSON. */
export interface BrokerToolResult {
  kind: "broker_tool_result";
  structuredContent: Record<string, unknown>;
  content?: BrokerContentItem[];
  artifacts?: BrokerArtifactReference[];
  auditSummary?: Record<string, unknown>;
}

export interface DomainSpec {
  key: string;
  label: string;
}

export const ACCESS_LEVELS = ["none", "read", "contribute", "manage", "full"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface AccessLevelSpec {
  label: string;
  description: string;
  riskCeiling: ToolRisk | null;
  toolNames: string[];
  constraints?: Record<string, Record<string, unknown>>;
}

export type AccessLevelMap = Record<AccessLevel, AccessLevelSpec>;

export interface PolicyPluginIntent {
  pluginKey: string;
  instanceName?: string | null;
  mode: "simple" | "advanced";
  accessLevel: AccessLevel;
  riskCeiling: ToolRisk | null;
  grants?: Record<string, string[]>;
  deniedTools?: string[];
  constraints?: Record<string, Record<string, unknown>>;
}

export interface MaterializedPermission {
  toolName: string;
  effect: "allow" | "deny";
  constraints: Record<string, unknown>;
  riskCeiling: ToolRisk | null;
}

export interface CapabilityRecord {
  capability: string;
  status: "available" | "unavailable" | "unknown";
  executorKind?: string | null;
  credentialId?: string | null;
  details?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface ServerContext {
  id: string;
  name: string;
  address: string;
  metadata: Record<string, unknown>;
}

export interface ServerPluginContext {
  id: string;
  instanceName: string;
  config: Record<string, unknown>;
  server: ServerContext;
}

export interface PluginExecutionContext extends ServerPluginContext {
  actorUserId: string;
  actorTokenId: string;
  reason?: string;
  services: Record<string, unknown>;
}

export interface PluginProbeContext extends ServerPluginContext {
  services: Record<string, unknown>;
}

export type PluginRuntimeExecutor = (toolName: string, input: Record<string, unknown>, context: PluginExecutionContext) => Promise<unknown>;
export type PluginRuntimeProbe = (context: PluginProbeContext) => Promise<CapabilityRecord[]>;

export function runtimeExecutor(context: PluginExecutionContext, pluginKey: string): PluginRuntimeExecutor | undefined {
  const executors = context.services.executors;
  return executors && typeof executors === "object" ? (executors as Record<string, PluginRuntimeExecutor>)[pluginKey] : undefined;
}

export function runtimeProbe(context: PluginProbeContext, pluginKey: string): PluginRuntimeProbe | undefined {
  const probes = context.services.probes;
  return probes && typeof probes === "object" ? (probes as Record<string, PluginRuntimeProbe>)[pluginKey] : undefined;
}

export interface ElevatedCredential {
  kind?: "ssh";
  host: string;
  port: number;
  username: string;
  privateKey: string;
  knownHostsLine: string;
  useSudo: boolean;
}

export interface DatabaseAdminCredential {
  kind: "postgres_admin";
  connectionString: string;
}

export type PluginBootstrapCredential = ElevatedCredential | DatabaseAdminCredential;

export interface ConfinementProfile {
  username: string;
  workspaceRoot: string;
  authorizedKeyPath: string;
  forceCommand: string;
  sudoersPath: string;
  sudoersLines: string[];
  helperCommands: string[];
}

export interface ProvisionPreview {
  profile: ConfinementProfile;
  summary: string[];
}

export interface ProvisionResult extends ProvisionPreview {
  privateKey?: string;
  publicKey?: string;
  credential?: { kind: string; payload: Record<string, unknown> };
  publicIdentity?: string;
  appliedAt: string;
}

export interface PluginProvisionContext extends ServerPluginContext {
  services: Record<string, unknown>;
}

export interface BrokerPlugin {
  key: string;
  name: string;
  version: number;
  description: string;
  cardinality: PluginCardinality;
  scope?: PluginScope;
  minRoleToEnable: BrokerRole;
  configSchema: Record<string, unknown>;
  defaultConfig?(server: ServerContext): Record<string, unknown>;
  normalizeConfig?(config: Record<string, unknown>, server: ServerContext): Record<string, unknown>;
  configVars?: string[];
  credentialKinds: string[];
  domains: DomainSpec[];
  tools: ToolDefinition[];
  accessLevels: AccessLevelMap;
  probeCapabilities(context: PluginProbeContext): Promise<CapabilityRecord[]>;
  previewProvision?(context: ServerPluginContext): ProvisionPreview;
  provision?(credential: PluginBootstrapCredential, context: PluginProvisionContext): Promise<ProvisionResult>;
  deprovision?(credential: PluginBootstrapCredential, context: PluginProvisionContext): Promise<void>;
  createTestInstance?(context: { services: Record<string, unknown> }): Promise<Record<string, unknown>>;
  auditDiff?(before: unknown, after: unknown): Record<string, unknown>;
  execute(tool: ToolDefinition, input: Record<string, unknown>, context: PluginExecutionContext): Promise<unknown>;
}

export function isBrokerToolResult(value: unknown): value is BrokerToolResult {
  return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "broker_tool_result");
}

export function auditSafeToolResult(value: unknown): unknown {
  if (!isBrokerToolResult(value)) return value;
  return {
    ...value.structuredContent,
    artifacts: value.artifacts?.map(({ id, uri, mimeType, size, sha256, expiresAt, redactionStatus }) =>
      ({ id, uri, mime_type: mimeType, size, sha256, expires_at: expiresAt, redaction_status: redactionStatus ?? "not_applicable" })),
    ...(value.auditSummary ?? {})
  };
}

/** Shared static checks that every built-in and third-party plugin can run in its test suite. */
export function pluginConformanceProblems(plugin: BrokerPlugin): string[] {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9_-]*$/.test(plugin.key)) problems.push(`${plugin.key}: invalid plugin key`);
  if (plugin.scope && !["target", "broker"].includes(plugin.scope)) problems.push(`${plugin.key}: invalid plugin scope`);
  const names = new Set<string>();
  const domains = new Set(plugin.domains.map(({ key }) => key));
  for (const tool of plugin.tools) {
    if (!tool.name.startsWith(`${plugin.key}.`)) problems.push(`${tool.name}: tool is not namespaced`);
    if (names.has(tool.name)) problems.push(`${tool.name}: duplicate tool`);
    names.add(tool.name);
    if (!domains.has(tool.domain)) problems.push(`${tool.name}: undeclared domain ${tool.domain}`);
    problems.push(...validateToolMetadata(tool.name, tool));
  }
  for (const level of ACCESS_LEVELS) {
    const spec = plugin.accessLevels[level];
    for (const name of spec.toolNames) if (!names.has(name)) problems.push(`${plugin.key}.${level}: unknown tool ${name}`);
  }
  if (plugin.accessLevels.none.toolNames.length) problems.push(`${plugin.key}.none: must not grant tools`);
  return problems;
}

export async function probeConformanceProblems(plugin: BrokerPlugin, context: PluginProbeContext): Promise<string[]> {
  const records = await plugin.probeCapabilities(context);
  const problems: string[] = [];
  const names = new Set<string>();
  for (const record of records) {
    if (!record.capability.trim()) problems.push(`${plugin.key}: empty capability name`);
    if (names.has(record.capability)) problems.push(`${plugin.key}: duplicate capability ${record.capability}`);
    names.add(record.capability);
    if (!["available", "unavailable", "unknown"].includes(record.status)) problems.push(`${record.capability}: invalid capability status`);
    try {
      const copy = JSON.parse(JSON.stringify(record)) as CapabilityRecord;
      if (copy.capability !== record.capability || copy.status !== record.status) problems.push(`${record.capability}: capability did not round-trip`);
    } catch { problems.push(`${record.capability}: capability is not JSON serializable`); }
  }
  return problems;
}

const RISK_RANK: Record<ToolRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function riskAtOrBelow(risk: ToolRisk, ceiling: ToolRisk | null): boolean {
  return ceiling !== null && RISK_RANK[risk] <= RISK_RANK[ceiling];
}

export function materializePluginIntent(
  plugin: BrokerPlugin,
  intent: PolicyPluginIntent,
  reviewedTools: ReadonlySet<string>
): MaterializedPermission[] {
  if (intent.pluginKey !== plugin.key) throw new Error(`Plugin intent mismatch: ${intent.pluginKey}`);
  const denied = new Set(intent.deniedTools ?? []);
  const level = plugin.accessLevels[intent.accessLevel];
  const ceiling = intent.riskCeiling ?? level.riskCeiling;
  const simpleTools = new Set(level.toolNames);
  const grants = intent.grants ?? {};
  const constraints = intent.constraints ?? (intent.mode === "simple" ? level.constraints ?? {} : {});
  const rows: MaterializedPermission[] = [];

  for (const tool of plugin.tools) {
    if (denied.has(tool.name)) {
      rows.push({ toolName: tool.name, effect: "deny", constraints: constraints[tool.name] ?? {}, riskCeiling: ceiling });
      continue;
    }
    const granted = intent.mode === "simple"
      ? simpleTools.has(tool.name)
      : (grants[tool.domain] ?? []).includes(tool.action);
    if (!granted || !riskAtOrBelow(tool.risk, ceiling)) continue;
    if ((tool.risk === "high" || tool.risk === "critical") && !reviewedTools.has(tool.name)) continue;
    rows.push({ toolName: tool.name, effect: "allow", constraints: constraints[tool.name] ?? {}, riskCeiling: ceiling });
  }
  return rows;
}

export class PluginRegistry {
  readonly #plugins = new Map<string, BrokerPlugin>();
  readonly #tools = new Map<string, { plugin: BrokerPlugin; tool: ToolDefinition }>();

  register(plugin: BrokerPlugin): this {
    if (!/^[a-z][a-z0-9_-]*$/.test(plugin.key)) throw new Error(`Invalid plugin key: ${plugin.key}`);
    if (this.#plugins.has(plugin.key)) throw new Error(`Plugin already registered: ${plugin.key}`);
    const pluginToolNames = new Set<string>();
    for (const tool of plugin.tools) {
      if (!tool.name.startsWith(`${plugin.key}.`)) throw new Error(`Tool ${tool.name} must be namespaced with ${plugin.key}.`);
      if (pluginToolNames.has(tool.name)) throw new Error(`Tool duplicated within plugin ${plugin.key}: ${tool.name}`);
      if (this.#tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
      pluginToolNames.add(tool.name);
    }
    this.#plugins.set(plugin.key, plugin);
    for (const tool of plugin.tools) this.#tools.set(tool.name, { plugin, tool });
    return this;
  }

  get(key: string): BrokerPlugin | undefined { return this.#plugins.get(key); }
  resolveTool(name: string): { plugin: BrokerPlugin; tool: ToolDefinition } | undefined { return this.#tools.get(name); }
  plugins(): BrokerPlugin[] { return [...this.#plugins.values()]; }
  tools(): ToolDefinition[] { return [...this.#tools.values()].map(({ tool }) => tool); }
}

export function interpolateServerConfig(value: unknown, server: ServerContext): unknown {
  if (typeof value === "string") return value.replaceAll("${server.address}", server.address);
  if (Array.isArray(value)) return value.map((item) => interpolateServerConfig(item, server));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateServerConfig(item, server)]));
  }
  return value;
}
