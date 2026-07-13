import { randomBytes } from "node:crypto";
import type { ToolDefinition } from "@aibroker/mcp-tools";
import { runtimeExecutor, runtimeProbe, type AccessLevelMap, type BrokerPlugin, type DatabaseAdminCredential, type PluginExecutionContext, type PluginProbeContext } from "@aibroker/plugin-sdk";

type Executor = (tool: string, input: Record<string, unknown>, context: PluginExecutionContext) => Promise<unknown>;
type Provisioner = (input: { credential: DatabaseAdminCredential; role: string; password: string; database: string; schemas: string[] }) => Promise<void>;
type Deprovisioner = (input: { credential: DatabaseAdminCredential; role: string }) => Promise<void>;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
const target = { server_plugin_id: { type: "string", format: "uuid" }, reason: { type: ["string", "null"], maxLength: 1000 } };
const output = obj({ rows: { type: "array" }, operation_id: { type: "string" }, status: { type: "string" } });
function definition(name: string, action: ToolDefinition["action"], risk: ToolDefinition["risk"], description: string,
  properties: Record<string, unknown> = {}, required: string[] = [], long = false): ToolDefinition {
  const write = action !== "read";
  return { name, version: 1, category: write ? "write" : "read", isWrite: write,
    inputSchema: obj({ ...target, ...properties, ...(write ? { idempotency_key: { type: "string", minLength: 16 } } : {}) },
      ["server_plugin_id", ...required, ...(write ? ["idempotency_key"] : [])]), outputSchema: output,
    domain: "postgres_data", action, risk, reversible: action === "read", executorKind: "postgres",
    credentialKinds: ["postgres_scoped_role"], supportsDryRun: false, isLongRunning: long, description };
}
export const POSTGRES_TOOL_DEFINITIONS: ToolDefinition[] = [
  definition("postgres.list_tables", "read", "low", "List tables visible to the scoped role.", { schema: { type: ["string", "null"] } }),
  definition("postgres.read_rows", "read", "low", "Read bounded rows from an allowed schema and table.",
    { schema: { type: "string" }, table: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500 } }, ["schema", "table"]),
  definition("postgres.run_named_query", "read", "medium", "Run a reviewed named query from plugin configuration.",
    { name: { type: "string" }, parameters: { type: "array" } }, ["name"]),
  definition("postgres.run_sql", "operate", "critical", "Run unrestricted SQL as the scoped role. Break-glass only; fully captured.",
    { sql: { type: "string", minLength: 1 }, parameters: { type: "array" }, reason: { type: "string", minLength: 1 } }, ["sql", "reason"], true)
];
const tools = (predicate: (tool: ToolDefinition) => boolean) => POSTGRES_TOOL_DEFINITIONS.filter(predicate).map(({ name }) => name);
const accessLevels: AccessLevelMap = {
  none: { label: "None", description: "No database access.", riskCeiling: null, toolNames: [] },
  read: { label: "Read", description: "Inspect schemas and bounded rows.", riskCeiling: "medium", toolNames: tools((tool) => tool.action === "read") },
  contribute: { label: "Contribute", description: "Run reviewed read queries; no arbitrary SQL.", riskCeiling: "medium", toolNames: tools((tool) => tool.action === "read") },
  manage: { label: "Manage", description: "Use reviewed database operations; no arbitrary SQL.", riskCeiling: "high", toolNames: tools((tool) => tool.name !== "postgres.run_sql") },
  full: { label: "Full", description: "Break-glass access including unrestricted, recorded SQL.", riskCeiling: "critical", toolNames: POSTGRES_TOOL_DEFINITIONS.map(({ name }) => name) }
};
function identifier(value: unknown, fallback: string): string {
  const result = typeof value === "string" && value ? value : fallback;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(result)) throw new Error("invalid_postgres_identifier");
  return result;
}
function preview(config: Record<string, unknown>) {
  const role = identifier(config.scoped_role, "aibroker_scoped");
  const database = identifier(config.database, "postgres");
  const schemas = Array.isArray(config.allowed_schemas) ? config.allowed_schemas.map((value) => identifier(value, "public")) : ["public"];
  return { profile: { username: role, workspaceRoot: `${database}:${schemas.join(",")}`, authorizedKeyPath: "n/a",
    forceCommand: "PostgreSQL role grants", sudoersPath: "n/a", sudoersLines: [`CONNECT ${database}`, ...schemas.map((schema) => `USAGE/SELECT ${schema}`)], helperCommands: [] },
    summary: [`Create or rotate scoped role ${role}`, `Grant CONNECT on ${database}`, `Grant USAGE and SELECT within ${schemas.join(", ")}`,
      "Store only the scoped role credential; discard the admin connection string"] };
}
export const postgresPlugin: BrokerPlugin = {
  key: "postgres", name: "Postgres", version: 1, description: "Typed PostgreSQL access with scoped-role provisioning and recorded break-glass SQL.",
  cardinality: "multi", minRoleToEnable: "global_admin", configVars: ["server.address"],
  configSchema: { type: "object", additionalProperties: false, properties: {
    host: { type: "string", title: "Postgres host", default: "${server.address}" }, port: { type: "integer", title: "Port", default: 5432 },
    database: { type: "string", title: "Database", default: "postgres" }, scoped_role: { type: "string", title: "Scoped role", default: "aibroker_scoped" },
    allowed_schemas: { type: "array", title: "Allowed schemas", default: ["public"] }, named_queries: { type: "object", title: "Named queries", default: {} }
  }, required: ["host", "database", "scoped_role"] }, credentialKinds: ["postgres_scoped_role"],
  domains: [{ key: "postgres_data", label: "Postgres Data" }], tools: POSTGRES_TOOL_DEFINITIONS, accessLevels,
  previewProvision(context) { return preview(context.config); },
  async provision(credential, context) {
    if (credential.kind !== "postgres_admin") throw new Error("postgres_admin_credential_required");
    const plan = preview(context.config), role = plan.profile.username, password = randomBytes(24).toString("base64url");
    const database = identifier(context.config.database, "postgres");
    const schemas = Array.isArray(context.config.allowed_schemas) ? context.config.allowed_schemas.map((value) => identifier(value, "public")) : ["public"];
    const provisioner = context.services.postgresProvisioner as Provisioner | undefined;
    if (!provisioner) throw new Error("postgres_provisioner_unavailable");
    try { await provisioner({ credential, role, password, database, schemas }); }
    finally { credential.connectionString = ""; }
    const url = new URL(String(context.config.admin_template ?? "postgres://localhost"));
    url.hostname = String(context.config.host ?? context.server.address); url.port = String(context.config.port ?? 5432);
    url.pathname = `/${database}`; url.username = role; url.password = password;
    return { ...plan, credential: { kind: "postgres_scoped_role", payload: { connectionString: url.toString() } },
      publicIdentity: role, appliedAt: new Date().toISOString() };
  },
  async deprovision(credential, context) {
    if (credential.kind !== "postgres_admin") throw new Error("postgres_admin_credential_required");
    const deprovisioner = context.services.postgresDeprovisioner as Deprovisioner | undefined;
    if (!deprovisioner) throw new Error("postgres_deprovisioner_unavailable");
    try { await deprovisioner({ credential, role: identifier(context.config.scoped_role, "aibroker_scoped") }); }
    finally { credential.connectionString = ""; }
  },
  async probeCapabilities(context: PluginProbeContext) {
    const probe = runtimeProbe(context, "postgres");
    if (!probe) throw new Error("postgres_probe_unavailable"); return probe(context);
  },
  async execute(tool, input, context) { const executor = runtimeExecutor(context, "postgres") as Executor | undefined;
    if (!executor) throw new Error("postgres_executor_unavailable"); return executor(tool.name, input, context); },
  async createTestInstance(context) { const factory = context.services.postgresSandboxFactory as (() => Promise<Record<string, unknown>>) | undefined;
    if (!factory) throw new Error("postgres_sandbox_unavailable"); return factory(); },
  auditDiff(before, after) { return { database_scope: { before, after } }; }
};
