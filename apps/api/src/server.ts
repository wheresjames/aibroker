import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { generateApiToken, hashPassword, verifyApiToken, verifyPassword } from "@aibroker/auth";
import type { AIBrokerConfig } from "@aibroker/core";
import { redactObject, redactValue, validateBindingConstraints, validateConstraints } from "@aibroker/core";
import { loadEncryptionKey, decryptJson, encryptJson, type EncryptedPayload } from "@aibroker/crypto";
import { writeAuditEvent } from "@aibroker/audit";
import { evaluatePolicy } from "@aibroker/policy";
import { WordPressRestClient, WordPressRestError, WordPressSessionError, type PendingTwoFactor } from "@aibroker/wordpress-rest";
import { PAGE_BUILDER_ADAPTERS, PAGE_BUILDER_TOOL_HANDLERS, type PageBuilderToolCtx } from "@aibroker/page-builders";
import { TOOL_ACTIONS, TOOL_DOMAINS, type ToolDefinition } from "@aibroker/mcp-tools";
import {
  ACCESS_LEVELS,
  PluginRegistry,
  auditSafeToolResult,
  isBrokerToolResult,
  interpolateServerConfig,
  materializePluginIntent,
  type AccessLevel,
  type ElevatedCredential,
  type PolicyPluginIntent,
  type ServerPluginContext
} from "@aibroker/plugin-sdk";
import { createBuiltInPluginRegistry, wordpressPlugin, sshPlugin, postgresPlugin } from "@aibroker/plugin-catalog";
import { assertAuthenticatedBrowserScope, normalizePlaywrightConfig } from "@aibroker/plugin-playwright";
import { FilesystemArtifactStore, S3ArtifactStore, type ArtifactStore } from "@aibroker/artifacts";
import { executeElevatedSshScript, executeSshCommand } from "@aibroker/wpcli-ssh";
import { recordServerPluginCapabilities } from "@aibroker/db";
import { REST_TOOL_HANDLERS, type RestToolCtx } from "./tools/rest-tools.js";
import {
  completeWordPressTwoFactor, connectWordPressSession, disconnectWordPressSession, loadWordPressSession, markSessionExpired, SessionConnectError,
  snapshotStore, storeBrowserCapturedSession
} from "./tools/wordpress-sessions.js";
import { captureOrigins, CHALLENGE_PROVIDER_ORIGINS, createCapture, finishCapture, loadCapture, MAX_TWO_FACTOR_ATTEMPTS, updateCapturePayload } from "./tools/credential-captures.js";
import type pg from "pg";
import { Pool as PgPool } from "pg";
import { createMcpPipeline, McpToolError, type McpAuditContext, type McpPipeline } from "./mcp/pipeline.js";
import { registerMcpTransport } from "./mcp/transport.js";

const MCP_SERVER_NAME = "aibroker";
const MCP_SERVER_VERSION = "0.1.0";

export interface BuildServerOptions {
  config: AIBrokerConfig;
  db: pg.Pool;
}

interface AdminUser {
  id: string;
  owner_user_id?: string | null;
  email: string;
  display_name: string;
  role: string;
  status: string;
  password_change_required: boolean;
  session_epoch?: number;
}

const SESSION_TTL_SECONDS = 6 * 24 * 60 * 60;

function issueSessionToken(userId: string, epoch: number, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, ep: epoch, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySessionToken(token: string, secret: string): { sub: string; ep: number } | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); } catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown; ep?: unknown; exp?: unknown };
    if (typeof parsed.sub !== "string" || typeof parsed.exp !== "number" || parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return { sub: parsed.sub, ep: typeof parsed.ep === "number" ? parsed.ep : 0 };
  } catch { return null; }
}

interface TokenActor {
  tokenId: string;
  userId: string;
  role: string;
  status: string;
  groupIds: string[];
}

interface RestCredentialPayload {
  username: string;
  applicationPassword: string;
}

interface ServerRow {
  id: string;
  name: string;
  base_url: string;
  address: string;
  status: string;
  capabilities: Record<string, unknown>;
  client_name?: string | null;
  tags?: string[];
  multisite_network_slug?: string | null;
  wordpress_path?: string | null;
  wp_cli_path?: string;
}

interface ServerPluginTarget extends ServerPluginContext {
  pluginKey: string;
  status: "enabled" | "disabled" | "removed";
  server: ServerRow & { metadata: Record<string, unknown> };
}

interface LeasedBrowserSession {
  id: string; server_id: string; server_plugin_id: string; actor_user_id: string | null; actor_token_id: string | null;
  worker_lease_id: string; lease_slot: number; status: "opening" | "active" | "closing" | "closed" | "expired" | "failed";
  current_url: string | null; event_cursors: Record<string, number>; event_counts: Record<string, number>;
  idle_expires_at: string; absolute_expires_at: string; created_at: string; last_activity_at: string;
}

// In-process catalog metadata map, keyed by tool name. Used to snapshot domain/action/
// risk/executor into audit records, to resolve executor/credential requirements for the
// effective-access explanation, and to derive the known-tool + write classifications
// (so adding a tool to the catalog is the only change needed — no parallel hard-coded set).
const PLUGIN_REGISTRY = createBuiltInPluginRegistry();
const TOOL_META: Map<string, ToolDefinition> = new Map(PLUGIN_REGISTRY.tools().map((tool) => [tool.name, tool]));
const ALL_TOOL_NAMES: string[] = PLUGIN_REGISTRY.tools().map((tool) => tool.name);
function isWriteTool(name: string): boolean {
  return TOOL_META.get(name)?.isWrite ?? false;
}
const DEFAULT_BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
const DEFAULT_BOOTSTRAP_ADMIN_PASSWORD = "change_me_in_local_dev";
const DEFAULT_BOOTSTRAP_ADMIN_NAME = "AIBroker Admin";

// Fallback MCP server name used in Client Setup snippets when the app_settings
// row is missing. Must stay in sync with migration 011's seeded default.
const DEFAULT_MCP_SERVER_NAME = "aibroker";
// MCP server names double as JSON object keys and CLI arguments, so keep them to
// a conservative identifier set: alphanumeric start, then letters/digits/_/-.
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isServerAddress(value: string): boolean {
  if (value.length > 253 || /[\s/?#]/.test(value)) return false;
  const host = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return /^[a-z0-9][a-z0-9.-]*$/i.test(host) || /^[0-9a-f:]+$/i.test(host);
}

export async function ensureBootstrapAdmin(
  db: pg.Pool,
  env = process.env,
  logger: Pick<Console, "warn"> = console
): Promise<void> {
  const email = (env.AIBROKER_BOOTSTRAP_ADMIN_EMAIL ?? env.AIBROKER_SEED_ADMIN_EMAIL ?? DEFAULT_BOOTSTRAP_ADMIN_EMAIL)
    .trim()
    .toLowerCase();
  const password = env.AIBROKER_BOOTSTRAP_ADMIN_PASSWORD ?? env.AIBROKER_SEED_ADMIN_PASSWORD ?? DEFAULT_BOOTSTRAP_ADMIN_PASSWORD;
  const displayName = env.AIBROKER_BOOTSTRAP_ADMIN_NAME ?? env.AIBROKER_SEED_ADMIN_NAME ?? DEFAULT_BOOTSTRAP_ADMIN_NAME;

  const admins = await db.query<{ count: number }>(
    "select count(*)::int as count from users where role in ('global_admin', 'team_admin') and status = 'active'"
  );
  const bootstrap = await db.query<{
    password_change_required: boolean;
    last_login_at: string | null;
  }>(
    "select password_change_required, last_login_at from users where email = $1 and status = 'active' and role = 'global_admin'",
    [email]
  );
  const bootstrapUser = bootstrap.rows[0];
  const production = env.NODE_ENV === "production";
  if (Number(admins.rows[0]?.count ?? 0) === 0 || (bootstrapUser && !bootstrapUser.password_change_required && !bootstrapUser.last_login_at)) {
    if (production && password === DEFAULT_BOOTSTRAP_ADMIN_PASSWORD) {
      throw new Error("Refusing to create the bootstrap admin with the built-in default password in production; set AIBROKER_BOOTSTRAP_ADMIN_PASSWORD");
    }
    const passwordHash = await hashPassword(password);
    await db.query(
      `insert into users (email, display_name, password_hash, password_change_required, role, status)
       values ($1, $2, $3, true, 'global_admin', 'active')
       on conflict (email) do update set
         display_name = excluded.display_name,
         password_hash = excluded.password_hash,
         password_change_required = true,
         role = 'global_admin',
         status = 'active',
         updated_at = now()`,
      [email, displayName, passwordHash]
    );
  }

  const activeBootstrap = await db.query<{ password_change_required: boolean }>(
    "select password_change_required from users where email = $1 and status = 'active' and role = 'global_admin'",
    [email]
  );
  if (activeBootstrap.rows[0]?.password_change_required) {
    logger.warn(
      [
        "AIBroker bootstrap admin password must be changed.",
        `Username: ${email}`,
        // Production logs are shipped and retained, so never write the credential there.
        production ? "Password: the value of AIBROKER_BOOTSTRAP_ADMIN_PASSWORD" : `Password: ${password}`
      ].join("\n")
    );
  }
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const artifactStore = createArtifactStore(options.config);
  const artifactMetrics = { reads: 0 };
  const server = Fastify({
    logger: {
      level: options.config.nodeEnv === "test" ? "silent" : "info",
      serializers: {
        req(request) {
          return redactObject({
            id: request.id,
            method: request.method,
            url: request.url,
            headers: request.headers
          });
        }
      }
    },
    genReqId() {
      return randomUUID();
    }
  });

  server.decorate("db", options.db);
  server.decorate("config", options.config);
  const artifactCleanup = setInterval(() => void cleanupExpiredArtifacts(options.db, artifactStore), 60_000);
  const browserSessionReconciliation = setInterval(() => void reconcileBrowserSessions(options.db, options.config), 15_000);
  artifactCleanup.unref();
  browserSessionReconciliation.unref();
  server.addHook("onClose", async () => { clearInterval(artifactCleanup); clearInterval(browserSessionReconciliation); });

  server.addHook("preHandler", async (request, reply) => {
    // Match on the routed path, not the raw URL: the router percent-decodes before
    // matching, so a raw-URL check is bypassed by e.g. /%61dmin/groups. Unmatched
    // requests (404s) have no route, so fall back to the raw URL for those.
    if (!(request.routeOptions.url ?? request.url).startsWith("/admin/")) return;
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor || reply.sent) return;
  });

  server.get("/health/live", async () => ({
    status: "ok",
    checks: { api: "ok" }
  }));

  server.get("/health/ready", async () => {
    await options.db.query("select 1");
    return {
      status: "ok",
      checks: { api: "ok", database: "ok" }
    };
  });

  server.get("/runtime", async () => ({ sandbox_enabled: options.config.sandboxEnabled }));

  server.get("/admin/sandbox", async (request, reply) => {
    if (!options.config.sandboxEnabled) return error(reply, 404, "sandbox_disabled");
    // Returns decrypted sandbox secrets, so it is gated like the other sandbox routes.
    const actor = await requireGlobalAdmin(options.db, request, reply); if (!actor) return;
    const result = await options.db.query(
      "select id,plugin_key,name,status,connection_config,encrypted_secrets,registered_server_id,created_at,expires_at,torn_down_at from sandbox_targets order by created_at desc"
    );
    const key = loadEncryptionKey(options.config.encryptionKeyBase64);
    return { targets: result.rows.map((row) => ({ ...row,
      secrets: row.encrypted_secrets ? decryptJson(row.encrypted_secrets as EncryptedPayload, key) : {}, encrypted_secrets: undefined })) };
  });

  server.post<{ Body: { plugin_key?: string; name?: string } }>("/admin/sandbox", async (request, reply) => {
    if (!options.config.sandboxEnabled) return error(reply, 404, "sandbox_disabled");
    const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
    if (actor.role !== "global_admin") return error(reply, 403, "global_admin_required");
    const plugin = request.body.plugin_key ? PLUGIN_REGISTRY.get(request.body.plugin_key) : undefined;
    if (!plugin?.createTestInstance) return error(reply, 400, "sandbox_plugin_unsupported");
    const created = await plugin.createTestInstance({ services: {
      postgresSandboxFactory: () => createPostgresSandbox(options.config.databaseUrl),
      wordpressSandboxFactory: async () => ({
        connection_config: { address: "wordpress", base_url: "http://localhost:8081", wordpress_path: "/var/www/html", wp_cli_path: "wp" },
        secrets: {},
        instructions: "Use ./dev.sh run --wptest <name> --keep for a fresh disposable target; the bundled Compose target is shown here."
      })
    } });
    const name = request.body.name?.trim() || `${plugin.name} sandbox`;
    const row = await options.db.query(
      `insert into sandbox_targets(plugin_key,name,connection_config,encrypted_secrets,created_by,expires_at)
       values($1,$2,$3::jsonb,$4::jsonb,$5,now()+interval '24 hours') returning *`,
      [plugin.key, name, JSON.stringify(created.connection_config ?? {}),
       JSON.stringify(encryptJson((created.secrets ?? {}) as Record<string, unknown>, loadEncryptionKey(options.config.encryptionKeyBase64))), actor.id]
    );
    await auditFromRequest(options.db, request, { eventType: "sandbox_create", actorUserId: actor.id, status: "success",
      input: { target_id: row.rows[0].id, plugin_key: plugin.key, connection_config: created.connection_config, instructions: created.instructions } });
    const { encrypted_secrets: _encryptedSecrets, ...publicTarget } = row.rows[0];
    return reply.code(201).send({ target: { ...publicTarget, secrets: created.secrets ?? {}, instructions: created.instructions } });
  });

  server.post<{ Params: { id: string } }>("/admin/sandbox/:id/register", async (request, reply) => {
    if (!options.config.sandboxEnabled) return error(reply, 404, "sandbox_disabled");
    const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
    if (actor.role !== "global_admin") return error(reply, 403, "global_admin_required");
    const target = await options.db.query("select * from sandbox_targets where id=$1 and status='running'", [request.params.id]);
    if (!target.rows[0]) return error(reply, 404, "sandbox_target_not_found");
    if (target.rows[0].registered_server_id) return { server_id: target.rows[0].registered_server_id };
    const config = target.rows[0].connection_config as Record<string, unknown>;
    const address = String(config.address ?? "localhost");
    if (!isServerAddress(address)) return error(reply, 400, "invalid_sandbox_address");
    const serverRow = await options.db.query(
      "insert into servers(name,address,metadata) values($1,$2,$3::jsonb) returning *",
      [target.rows[0].name, address, JSON.stringify({ ephemeral: true, sandbox_target_id: request.params.id })]
    );
    await options.db.query("update sandbox_targets set registered_server_id=$2 where id=$1", [request.params.id, serverRow.rows[0].id]);
    await auditFromRequest(options.db, request, { eventType: "sandbox_register", actorUserId: actor.id, serverId: serverRow.rows[0].id,
      status: "success", input: { target_id: request.params.id } });
    return reply.code(201).send({ server: serverRow.rows[0] });
  });

  server.post<{ Params: { id: string }; Body: { reason?: string; confirmed?: boolean } }>("/admin/sandbox/:id/teardown", async (request, reply) => {
    if (!options.config.sandboxEnabled) return error(reply, 404, "sandbox_disabled");
    const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
    if (actor.role !== "global_admin") return error(reply, 403, "global_admin_required");
    if (!request.body.confirmed || !request.body.reason?.trim()) return error(reply, 400, request.body.confirmed ? "reason_required" : "confirmation_required");
    const target = await options.db.query("select * from sandbox_targets where id=$1 and status='running'", [request.params.id]);
    if (!target.rows[0]) return error(reply, 404, "sandbox_target_not_found");
    if (target.rows[0].registered_server_id) {
      const provisioned = await options.db.query(
        `select 1 from server_plugins sp join postgres_provisioning pp on pp.server_plugin_id=sp.id
         where sp.server_id=$1 and pp.status='provisioned' limit 1`, [target.rows[0].registered_server_id]
      );
      if (provisioned.rowCount) return error(reply, 409, "deprovision_required");
    }
    if (target.rows[0].plugin_key === "postgres") await teardownPostgresSandbox(options.config.databaseUrl, target.rows[0].connection_config);
    await options.db.query("update sandbox_targets set status='removed',encrypted_secrets=null,torn_down_at=now() where id=$1", [request.params.id]);
    await auditFromRequest(options.db, request, { eventType: "sandbox_teardown", actorUserId: actor.id, status: "success",
      reason: request.body.reason.trim(), input: { target_id: request.params.id, plugin_key: target.rows[0].plugin_key } });
    return { ok: true };
  });

  server.get("/metrics", async (request, reply) => {
    // Bearer-protected when AIBROKER_METRICS_TOKEN is set; never public in production.
    const metricsToken = options.config.metricsToken;
    if (metricsToken) {
      const supplied = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${metricsToken}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return error(reply, 401, "unauthenticated");
    } else if (options.config.nodeEnv === "production") {
      return error(reply, 404, "metrics_disabled", "Set AIBROKER_METRICS_TOKEN to enable /metrics in production.");
    }
    const [
      toolCalls,
      failures,
      authFailures,
      credentialFailures,
      workerFailures,
      artifactWrites,
      artifactDeletes,
      artifactBytes,
      artifactCleanupBacklog,
      activeBrowserSessions,
      failedBrowserSessions
    ] = await Promise.all([
      scalar(options.db, "select count(*)::int as count from audit_events where event_type = 'mcp_tool_call'"),
      scalar(options.db, "select count(*)::int as count from audit_events where status = 'failure'"),
      scalar(options.db, "select count(*)::int as count from audit_events where event_type = 'admin_login' and status = 'failure'"),
      scalar(options.db, "select count(*)::int as count from server_connection_tests where status = 'error'"),
      scalar(options.db, "select count(*)::int as count from jobs where status = 'failed'"),
      scalar(options.db, "select count(*)::int as count from browser_artifacts"),
      scalar(options.db, "select count(*)::int as count from browser_artifacts where status = 'deleted'"),
      scalar(options.db, "select coalesce(sum(byte_size),0)::bigint as count from browser_artifacts"),
      scalar(options.db, "select count(*)::int as count from browser_artifacts where status = 'failed'"),
      scalar(options.db, "select count(*)::int as count from leased_sessions where status in ('opening','active','closing')"),
      scalar(options.db, "select count(*)::int as count from leased_sessions where status = 'failed'")
    ]);
    reply.type("text/plain; version=0.0.4");
    return [
      "# HELP aibroker_tool_calls_total Total MCP tool calls.",
      "# TYPE aibroker_tool_calls_total counter",
      `aibroker_tool_calls_total ${toolCalls}`,
      "# HELP aibroker_failures_total Failed audit events.",
      "# TYPE aibroker_failures_total counter",
      `aibroker_failures_total ${failures}`,
      "# HELP aibroker_auth_failures_total Failed admin login attempts.",
      "# TYPE aibroker_auth_failures_total counter",
      `aibroker_auth_failures_total ${authFailures}`,
      "# HELP aibroker_credential_failures_total Failed server connection tests.",
      "# TYPE aibroker_credential_failures_total counter",
      `aibroker_credential_failures_total ${credentialFailures}`,
      "# HELP aibroker_worker_job_failures_total Failed worker jobs.",
      "# TYPE aibroker_worker_job_failures_total counter",
      `aibroker_worker_job_failures_total ${workerFailures}`,
      "# TYPE aibroker_artifact_writes_total counter",
      `aibroker_artifact_writes_total ${artifactWrites}`,
      "# TYPE aibroker_artifact_reads_total counter",
      `aibroker_artifact_reads_total ${artifactMetrics.reads}`,
      "# TYPE aibroker_artifact_deletes_total counter",
      `aibroker_artifact_deletes_total ${artifactDeletes}`,
      "# TYPE aibroker_artifact_bytes_total counter",
      `aibroker_artifact_bytes_total ${artifactBytes}`,
      "# TYPE aibroker_artifact_cleanup_backlog gauge",
      `aibroker_artifact_cleanup_backlog ${artifactCleanupBacklog}`,
      "# TYPE aibroker_browser_sessions_active gauge",
      `aibroker_browser_sessions_active ${activeBrowserSessions}`,
      "# TYPE aibroker_browser_sessions_failed_total counter",
      `aibroker_browser_sessions_failed_total ${failedBrowserSessions}`,
      ""
    ].join("\n");
  });

  server.post<{ Body: { email?: string; password?: string } }>("/auth/login", async (request, reply) => {
    const email = request.body.email?.trim().toLowerCase();
    const password = request.body.password ?? "";
    if (!email || !password) return error(reply, 400, "validation_error");

    if (await loginThrottled(options.db, email, request.ip)) return error(reply, 429, "too_many_attempts", "Too many failed sign-in attempts. Try again later.");
    const user = await findUserByEmail(options.db, email);
    const valid = await checkPassword(user, password);
    if (!valid) await recordLoginFailure(options.db, email, request.ip);
    await auditFromRequest(options.db, request, {
      eventType: "admin_login",
      status: valid ? "success" : "failure",
      input: { email },
      ...(user?.id ? { actorUserId: user.id } : {}),
      ...(valid ? {} : { errorCode: "invalid_credentials" })
    });

    if (!valid || !user) return error(reply, 401, "invalid_credentials");
    await options.db.query("update users set last_login_at = now() where id = $1", [user.id]);
    return { user: publicUser(user), password_change_required: user.password_change_required, session_token: issueSessionToken(user.id, user.session_epoch ?? 0, options.config.sessionSecret) };
  });

  server.post<{ Body: { email?: string; current_password?: string; new_password?: string } }>("/auth/change-password", async (request, reply) => {
    const email = request.body.email?.trim().toLowerCase();
    const currentPassword = request.body.current_password ?? "";
    const newPassword = request.body.new_password ?? "";
    if (!email || !currentPassword) return error(reply, 400, "validation_error", "Current password is required.");
    if (shouldEnforcePasswordPolicy(options.config) && newPassword.length < 12) {
      return error(reply, 400, "validation_error", "New password must be at least 12 characters.");
    }
    if (currentPassword === newPassword) return error(reply, 400, "validation_error", "New password must be different from the bootstrap password.");

    if (await loginThrottled(options.db, email, request.ip)) return error(reply, 429, "too_many_attempts", "Too many failed sign-in attempts. Try again later.");
    const user = await findUserByEmail(options.db, email);
    const valid = await checkPassword(user, currentPassword);
    if (!valid) await recordLoginFailure(options.db, email, request.ip);
    await auditFromRequest(options.db, request, {
      eventType: "admin_password_change",
      status: valid ? "success" : "failure",
      input: { email },
      ...(user?.id ? { actorUserId: user.id } : {}),
      ...(valid ? {} : { errorCode: "invalid_credentials" })
    });

    if (!valid || !user) return error(reply, 401, "invalid_credentials");

    const passwordHash = await hashPassword(newPassword);
    const result = await options.db.query<AdminUser>(
      `update users
       set password_hash = $2, password_change_required = false, updated_at = now(), last_login_at = now(),
           session_epoch = session_epoch + 1
       where id = $1
       returning id, email, display_name, role, status, password_change_required, session_epoch`,
      [user.id, passwordHash]
    );
    const updatedUser = result.rows[0];
    if (!updatedUser) return error(reply, 404, "user_not_found");
    return { user: publicUser(updatedUser), password_change_required: false, session_token: issueSessionToken(updatedUser.id, updatedUser.session_epoch ?? 0, options.config.sessionSecret) };
  });

  // Revokes every session token the user holds (all devices), not just this one.
  server.post("/auth/logout", async (request, reply) => {
    const claims = await sessionClaims(request, options.config.sessionSecret);
    if (!claims) return error(reply, 401, "auth_required");
    const result = await options.db.query(
      "update users set session_epoch = session_epoch + 1 where id = $1 and session_epoch = $2",
      [claims.sub, claims.ep]
    );
    if (result.rowCount) {
      await auditFromRequest(options.db, request, { eventType: "admin_logout", actorUserId: claims.sub, status: "success" });
    }
    return { ok: true };
  });

  server.get("/admin/bootstrap", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    return {
      app: "AIBroker",
      navigation: ["Dashboard", "Users", "Groups", "Servers", "Tokens", "Policies", "Audit Logs", "Client Setup"],
      features: {
        mcpEnabled: options.config.mcpEnabled,
        authorization: "policy"
      }
    };
  });

  server.get("/admin/summary", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const [users, servers, tokens, audit] = await Promise.all([
      scalar(options.db, "select count(*)::int as count from users"),
      scalar(options.db, "select count(*)::int as count from servers"),
      scalar(options.db, "select count(*)::int as count from api_tokens where revoked_at is null"),
      scalar(options.db, "select count(*)::int as count from audit_events")
    ]);
    reply.header("cache-control", "no-store");
    return { users, servers, active_tokens: tokens, audit_events: audit };
  });

  server.get("/admin/users", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const scopeWhere = actor.role === "global_admin"
      ? ""
      : `where u.id in (
           with recursive scope as (
             select id from users where owner_user_id = $1
             union all
             select child.id from users child join scope s on child.owner_user_id = s.id
           )
           select id from scope
         )`;
    const result = await options.db.query(
      `select u.id, u.owner_user_id, owner.display_name as owner_display_name, u.email, u.display_name,
              u.role, u.status, u.created_at, u.updated_at, u.last_login_at,
              (select count(*)::int from users child where child.owner_user_id = u.id) as child_count,
              (with recursive descendants as (
                 select child.id from users child where child.owner_user_id = u.id
                 union all
                 select next_child.id from users next_child join descendants d on next_child.owner_user_id = d.id
               ) select count(*)::int from descendants) as descendant_count
       from users u
       left join users owner on owner.id = u.owner_user_id
       ${scopeWhere}
       order by u.owner_user_id nulls first, u.display_name`,
      actor.role === "global_admin" ? [] : [actor.id]
    );
    return { users: result.rows };
  });

  server.post<{
    Body: { email?: string; display_name?: string; password?: string; role?: string; status?: string; owner_user_id?: string | null; reason?: string };
  }>("/admin/users", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const email = request.body.email?.trim().toLowerCase();
    const displayName = request.body.display_name?.trim();
    const password = request.body.password ?? "";
    const role = request.body.role ?? "user";
    const status = request.body.status ?? "active";
    const ownerUserId = role === "global_admin" ? null : request.body.owner_user_id || null;
    if (!email || !displayName || password.length < 8 || !isRole(role) || !isUserStatus(status)) return error(reply, 400, "validation_error");
    if (["global_admin", "team_admin"].includes(role) && actor.role !== "global_admin") return error(reply, 403, "admin_denied");
    if (ownerUserId) {
      const owner = await options.db.query<{ role: string }>("select role from users where id = $1 and status <> 'deleted'", [ownerUserId]);
      const ownerRow = owner.rows[0];
      if (!ownerRow) return error(reply, 400, "owner_not_found");
      if (!canOwnRole(ownerRow.role, role)) return error(reply, 400, "invalid_owner", "Only team_admins and global_admins can own users.");
      if (!(await canUseOwner(options.db, actor, ownerUserId))) return error(reply, 403, "admin_denied");
    } else if (actor.role !== "global_admin") {
      return error(reply, 400, "owner_required", "Non-global admins must create users under an owner in their scope.");
    }
    const passwordHash = await hashPassword(password);
    const result = await options.db.query(
      `insert into users (owner_user_id, email, display_name, password_hash, role, status, password_change_required)
       values ($1,$2,$3,$4,$5,$6,true)
       returning id, owner_user_id, email, display_name, role, status, password_change_required, created_at, updated_at`,
      [ownerUserId, email, displayName, passwordHash, role, status]
    );
    if (ownerUserId) {
      await options.db.query(
        `insert into user_ownership_history (user_id, previous_owner_user_id, new_owner_user_id, changed_by_user_id, reason)
         values ($1, null, $2, $3, $4)`,
        [result.rows[0].id, ownerUserId, actor.id, request.body.reason?.trim() || "Initial owner assignment"]
      );
    }
    await auditFromRequest(options.db, request, {
      eventType: "user_create",
      actorUserId: actor.id,
      status: "success",
      input: { email, role, status, owner_user_id: ownerUserId }
    });
    return { user: result.rows[0] };
  });

  server.patch<{ Params: { id: string }; Body: { display_name?: string; email?: string; status?: string; role?: string } }>("/admin/users/:id", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const userId = request.params.id;
    if (!(await canManageUser(options.db, actor, userId))) return error(reply, 403, "admin_denied");
    const before = await options.db.query("select id, email, display_name, role, status, owner_user_id from users where id = $1", [userId]);
    if (!before.rows[0]) return error(reply, 404, "user_not_found");
    if (["global_admin", "team_admin"].includes(before.rows[0].role) && actor.role !== "global_admin") return error(reply, 403, "admin_denied");
    const displayName = request.body.display_name?.trim();
    const email = request.body.email?.trim().toLowerCase();
    const status = request.body.status ?? before.rows[0].status;
    const role = request.body.role ?? before.rows[0].role;
    if (!displayName || !email || !isRole(role) || !isUserStatus(status)) return error(reply, 400, "validation_error");
    if (["global_admin", "team_admin"].includes(role) && actor.role !== "global_admin") return error(reply, 403, "admin_denied");
    if (before.rows[0].role === "global_admin" && (role !== "global_admin" || status !== "active") && (await isLastGlobalAdmin(options.db, userId))) {
      return error(reply, 409, "last_global_admin", "At least one active global admin must remain.");
    }
    const taken = await options.db.query("select id from users where email = $1 and id <> $2", [email, userId]);
    if (taken.rowCount) return error(reply, 409, "email_taken", "That email is already in use.");
    // global_admin must have no owner; other roles keep their existing owner.
    const ownerUserId = role === "global_admin" ? null : before.rows[0].owner_user_id;
    const result = await options.db.query<AdminUser>(
      `update users set display_name = $2, email = $3, status = $4, role = $5, owner_user_id = $6, updated_at = now()
       where id = $1
       returning id, owner_user_id, email, display_name, role, status, password_change_required`,
      [userId, displayName, email, status, role, ownerUserId]
    );
    await auditFromRequest(options.db, request, {
      eventType: "user_update",
      actorUserId: actor.id,
      status: "success",
      input: { user_id: userId, before: before.rows[0], after: result.rows[0] }
    });
    return { user: publicUser(result.rows[0]!) };
  });

  server.post<{ Params: { id: string }; Body: { new_owner_user_id?: string | null; reason?: string } }>("/admin/users/:id/move", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const userId = request.params.id;
    const newOwnerUserId = request.body.new_owner_user_id || null;
    const reason = request.body.reason?.trim();
    if (!reason) return error(reply, 400, "reason_required", "A reason is required to move a user.");
    if (newOwnerUserId === userId) return error(reply, 400, "invalid_owner", "A user cannot own themselves.");

    const client = await options.db.connect();
    try {
      await client.query("begin");
      const userResult = await client.query<{ owner_user_id: string | null; role: string }>(
        "select owner_user_id, role from users where id = $1 and status <> 'deleted' for update",
        [userId]
      );
      const movedUser = userResult.rows[0];
      if (!movedUser) {
        await client.query("rollback");
        return error(reply, 404, "user_not_found");
      }
      if (movedUser.role === "team_admin" && actor.role !== "global_admin") {
        await client.query("rollback");
        return error(reply, 403, "admin_denied");
      }
      if (movedUser.role === "global_admin") {
        await client.query("rollback");
        return error(reply, 400, "invalid_owner", "Global admins cannot have owners.");
      }
      if (!(await canManageUser(client, actor, userId))) {
        await client.query("rollback");
        return error(reply, 403, "admin_denied");
      }
      if (!newOwnerUserId) {
        await client.query("rollback");
        return error(reply, 400, "owner_required", "Only global admins can be root owners.");
      }
      if (newOwnerUserId) {
        const ownerResult = await client.query<{ role: string }>("select role from users where id = $1 and status <> 'deleted'", [newOwnerUserId]);
        const owner = ownerResult.rows[0];
        if (!owner) {
          await client.query("rollback");
          return error(reply, 400, "owner_not_found");
        }
        if (!canOwnRole(owner.role, movedUser.role)) {
          await client.query("rollback");
          return error(reply, 400, "invalid_owner", "Only team_admins and global_admins can own users.");
        }
        if (!(await canUseOwner(client, actor, newOwnerUserId))) {
          await client.query("rollback");
          return error(reply, 403, "admin_denied");
        }
        const descendantResult = await client.query(
          `with recursive descendants as (
             select id from users where owner_user_id = $1
             union all
             select u.id from users u join descendants d on u.owner_user_id = d.id
           )
           select 1 from descendants where id = $2 limit 1`,
          [userId, newOwnerUserId]
        );
        if (descendantResult.rowCount) {
          await client.query("rollback");
          return error(reply, 400, "invalid_owner", "A user cannot be moved under one of their descendants.");
        }
      }
      await client.query("update users set owner_user_id = $2, updated_at = now() where id = $1", [userId, newOwnerUserId]);
      await client.query(
        `insert into user_ownership_history (user_id, previous_owner_user_id, new_owner_user_id, changed_by_user_id, reason)
         values ($1, $2, $3, $4, $5)`,
        [userId, movedUser.owner_user_id, newOwnerUserId, actor.id, reason]
      );
      await client.query("commit");
      await auditFromRequest(options.db, request, {
        eventType: "user_move",
        actorUserId: actor.id,
        status: "success",
        input: { user_id: userId, previous_owner_user_id: movedUser.owner_user_id, new_owner_user_id: newOwnerUserId, reason }
      });
      return { ok: true };
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  server.post<{ Params: { id: string } }>("/admin/users/:id/disable", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageUser(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    // Same rule as PATCH /admin/users/:id: only global admins may act on admin accounts.
    const target = await options.db.query<{ role: string }>("select role from users where id = $1", [request.params.id]);
    if (!target.rows[0]) return error(reply, 404, "user_not_found");
    if (["global_admin", "team_admin"].includes(target.rows[0].role) && actor.role !== "global_admin") return error(reply, 403, "admin_denied");
    if (target.rows[0].role === "global_admin" && (await isLastGlobalAdmin(options.db, request.params.id))) {
      return error(reply, 409, "last_global_admin", "At least one active global admin must remain.");
    }
    await options.db.query("update users set status = 'disabled', updated_at = now() where id = $1", [request.params.id]);
    await auditFromRequest(options.db, request, {
      eventType: "user_disable",
      actorUserId: actor.id,
      status: "success",
      input: { user_id: request.params.id }
    });
    return { ok: true };
  });

  server.get("/admin/groups", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const groups = await options.db.query(
      `select g.id, g.name, g.description, g.owner_user_id, owner.display_name as owner_display_name, g.created_at,
              (select count(*)::int from group_memberships gm where gm.group_id = g.id) as member_count,
              (select count(*)::int from server_bindings sb where sb.subject_type = 'group' and sb.subject_id = g.id) as server_count
       from groups g
       left join users owner on owner.id = g.owner_user_id
       order by g.name`
    );
    const memberships = await options.db.query(
      `select gm.group_id, gm.user_id, u.display_name, u.email
       from group_memberships gm
       join users u on u.id = gm.user_id
       order by u.display_name`
    );
    return { groups: groups.rows, memberships: memberships.rows };
  });

  server.post<{ Body: { name?: string; description?: string; owner_user_id?: string | null } }>("/admin/groups", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const name = request.body.name?.trim();
    if (!name) return error(reply, 400, "validation_error");
    const ownerUserId = actor.role === "global_admin" ? request.body.owner_user_id ?? null : actor.id;
    if (ownerUserId && !(await canUseOwner(options.db, actor, ownerUserId))) return error(reply, 403, "admin_denied");
    const result = await options.db.query(
      "insert into groups (name, description, owner_user_id) values ($1,$2,$3) returning id, name, description, owner_user_id, created_at",
      [name, request.body.description ?? null, ownerUserId]
    );
    await auditFromRequest(options.db, request, {
      eventType: "group_create",
      actorUserId: actor.id,
      status: "success",
      input: { name, owner_user_id: ownerUserId }
    });
    return { group: result.rows[0] };
  });

  server.patch<{ Params: { id: string }; Body: { name?: string; description?: string; owner_user_id?: string | null } }>("/admin/groups/:id", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageGroup(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const before = await options.db.query("select * from groups where id = $1", [request.params.id]);
    if (!before.rows[0]) return error(reply, 404, "group_not_found");
    const ownerUserId = request.body.owner_user_id === undefined ? before.rows[0].owner_user_id : request.body.owner_user_id;
    if (ownerUserId && !(await canUseOwner(options.db, actor, ownerUserId))) return error(reply, 403, "admin_denied");
    const result = await options.db.query(
      `update groups set
         name = coalesce($2, name),
         description = coalesce($3, description),
         owner_user_id = $4,
         updated_at = now()
       where id = $1 returning *`,
      [request.params.id, request.body.name?.trim() || null, request.body.description ?? null, ownerUserId ?? null]
    );
    await auditFromRequest(options.db, request, {
      eventType: "group_update",
      actorUserId: actor.id,
      status: "success",
      input: { group_id: request.params.id, before: before.rows[0], after: result.rows[0] }
    });
    return { group: result.rows[0] };
  });

  server.delete<{ Params: { id: string }; Body: { reason?: string } }>("/admin/groups/:id", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageGroup(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const before = await options.db.query("select * from groups where id = $1", [request.params.id]);
    if (!before.rows[0]) return error(reply, 404, "group_not_found");
    const bindings = await bindingsQuery(options.db, "sb.subject_type = 'group' and sb.subject_id = $1", [request.params.id]);
    const client = await options.db.connect();
    try {
      await client.query("begin");
      await client.query("delete from server_bindings where subject_type = 'group' and subject_id = $1", [request.params.id]);
      await client.query("delete from groups where id = $1", [request.params.id]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await auditFromRequest(options.db, request, {
      eventType: "group_delete",
      actorUserId: actor.id,
      status: "success",
      input: { group_id: request.params.id, before: before.rows[0], bindings, reason: request.body?.reason ?? null }
    });
    return { ok: true };
  });

  server.post<{ Params: { id: string }; Body: { user_ids?: string[]; reason?: string } }>("/admin/groups/:id/members", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageGroup(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const userIds = request.body.user_ids ?? [];
    if (!Array.isArray(userIds) || userIds.length === 0) return error(reply, 400, "validation_error");
    for (const userId of userIds) {
      if (!(await canManageUser(options.db, actor, userId))) return error(reply, 403, "admin_denied");
    }
    await options.db.query(
      `insert into group_memberships (group_id, user_id)
       select $1, unnest($2::uuid[])
       on conflict (group_id, user_id) do nothing`,
      [request.params.id, userIds]
    );
    await auditFromRequest(options.db, request, {
      eventType: "group_member_add",
      actorUserId: actor.id,
      status: "success",
      input: { group_id: request.params.id, user_ids: userIds, reason: request.body.reason ?? null }
    });
    return { ok: true };
  });

  server.post<{ Body: { group_id?: string; user_id?: string } }>("/admin/groups/members", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!request.body.group_id || !request.body.user_id) return error(reply, 400, "validation_error");
    if (!(await canManageGroup(options.db, actor, request.body.group_id))) return error(reply, 403, "admin_denied");
    if (!(await canManageUser(options.db, actor, request.body.user_id))) return error(reply, 403, "admin_denied");
    await options.db.query(
      `insert into group_memberships (group_id, user_id) values ($1,$2)
       on conflict (group_id, user_id) do nothing`,
      [request.body.group_id, request.body.user_id]
    );
    await auditFromRequest(options.db, request, {
      eventType: "group_member_add",
      actorUserId: actor.id,
      status: "success",
      input: request.body
    });
    return { ok: true };
  });

  server.delete<{ Params: { id: string; userId: string }; Body: { reason?: string } }>("/admin/groups/:id/members/:userId", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageGroup(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    await options.db.query("delete from group_memberships where group_id = $1 and user_id = $2", [request.params.id, request.params.userId]);
    await auditFromRequest(options.db, request, {
      eventType: "group_member_remove",
      actorUserId: actor.id,
      status: "success",
      input: { group_id: request.params.id, user_id: request.params.userId, reason: request.body?.reason ?? null }
    });
    return { ok: true };
  });

  server.post<{ Params: { id: string }; Body: { servers?: Array<{ server_id?: string; policy_id?: string }>; reason?: string } }>("/admin/groups/:id/servers", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageGroup(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const servers = request.body.servers ?? [];
    if (!Array.isArray(servers) || servers.some((item) => !item.server_id || !item.policy_id)) return error(reply, 400, "validation_error");
    for (const item of servers) {
      if (!(await canManageServer(options.db, actor, item.server_id!))) return error(reply, 403, "admin_denied");
      await upsertBinding(options.db, {
        subjectType: "group",
        subjectId: request.params.id,
        serverId: item.server_id!,
        policyId: item.policy_id!,
        createdBy: actor.id
      });
    }
    await auditFromRequest(options.db, request, {
      eventType: "group_server_bind",
      actorUserId: actor.id,
      status: "success",
      input: { group_id: request.params.id, servers, reason: request.body.reason ?? null }
    });
    return { ok: true };
  });

  server.delete<{ Params: { id: string; serverId: string }; Body: { reason?: string } }>("/admin/groups/:id/servers/:serverId", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageGroup(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    if (!(await canManageServer(options.db, actor, request.params.serverId))) return error(reply, 403, "admin_denied");
    await options.db.query("delete from server_bindings where subject_type = 'group' and subject_id = $1 and server_id = $2", [
      request.params.id,
      request.params.serverId
    ]);
    await auditFromRequest(options.db, request, {
      eventType: "group_server_unbind",
      actorUserId: actor.id,
      serverId: request.params.serverId,
      status: "success",
      input: { group_id: request.params.id, server_id: request.params.serverId, reason: request.body?.reason ?? null }
    });
    return { ok: true };
  });

  server.get("/admin/servers", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    // A1 legibility: surface the REST-credential status (none/active/expired) so the
    // missing-credential gap that silently breaks every server tool is visible at a glance.
    const result = await options.db.query(
      `select s.*, coalesce((select count(*)::int from server_plugins sp where sp.server_id=s.id and sp.status='enabled'),0) as plugin_count, (
        select row_to_json(t) from (
          select status, error_code, error_message, tested_at, duration_ms
          from server_connection_tests where server_id = s.id order by tested_at desc limit 1
        ) t
      ) as last_connection_test,
      coalesce((
        select case
          when c.expires_at is not null and c.expires_at <= now() then 'expired'
          else 'active'
        end
        from server_credentials c join server_plugins spc on spc.id=c.server_plugin_id
        where spc.server_id = s.id and spc.status='enabled' and c.kind = 'wordpress_rest_application_password' and c.status = 'active'
        order by c.created_at desc limit 1
      ), 'none') as rest_credential_status
      from servers s
      where ($1::boolean or exists (
        with recursive scope as (
          select $2::uuid as id union all
          select u.id from users u join scope on u.owner_user_id = scope.id
        )
        select 1 where exists (
            select 1 from server_bindings sb where sb.server_id = s.id and (
              (sb.subject_type = 'user' and sb.subject_id in (select id from scope))
              or (sb.subject_type = 'group' and sb.subject_id in (select id from groups where owner_user_id in (select id from scope)))
            )
        )
      )) order by created_at desc`,
      [actor.role === "global_admin", actor.id]
    );
    return { servers: result.rows };
  });

  server.post<{
    Body: {
      name?: string;
      address?: string;
    };
  }>("/admin/servers", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (actor.role !== "global_admin") return error(reply, 403, "global_admin_required");
    const name = request.body.name?.trim();
    const address = request.body.address?.trim();
    if (!name || !address || !isServerAddress(address)) return error(reply, 400, "validation_error");
      const result = await options.db.query(
      `insert into servers (name, address, metadata)
       values ($1,$2,'{}'::jsonb)
       returning *`,
      [name, address]
    );
    await auditFromRequest(options.db, request, {
      eventType: "server_create",
      actorUserId: actor.id,
      serverId: result.rows[0].id,
      status: "success",
      input: request.body
    });
    return { server: result.rows[0] };
  });

  server.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      address?: string;
    };
  }>("/admin/servers/:id", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const before = await options.db.query("select * from servers where id = $1", [request.params.id]);
    if (!before.rows[0]) return error(reply, 404, "server_not_found");
    const name = request.body.name?.trim() || before.rows[0].name;
    const address = request.body.address?.trim() || before.rows[0].address;
    if (!name || !address || !isServerAddress(address)) return error(reply, 400, "validation_error");
    const result = await options.db.query(
      `update servers set
         name = $2, address = $3, updated_at = now()
       where id = $1 returning *`,
      [request.params.id, name, address]
    );
    await auditFromRequest(options.db, request, {
      eventType: "server_update",
      actorUserId: actor.id,
      serverId: request.params.id,
      status: "success",
      input: { server_id: request.params.id, before: before.rows[0], after: result.rows[0] }
    });
    return { server: result.rows[0] };
  });

  server.get("/admin/plugins", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    return { plugins: PLUGIN_REGISTRY.plugins().map((plugin) => ({
      key: plugin.key, name: plugin.name, version: plugin.version, description: plugin.description,
      cardinality: plugin.cardinality, min_role_to_enable: plugin.minRoleToEnable,
      config_schema: plugin.configSchema, credential_kinds: plugin.credentialKinds, domains: plugin.domains,
      access_levels: plugin.accessLevels
    })) };
  });

  server.get<{ Params: { id: string } }>("/admin/servers/:id/plugins", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const result = await options.db.query(
      `select sp.*,p.name as plugin_name,p.version,p.config_schema,coalesce(pr.status,ppr.status) as provisioning_status,
              coalesce(pr.profile,jsonb_build_object('username',ppr.scoped_role,'allowed_schemas',ppr.allowed_schemas)) as provisioning_profile,
              (select count(*)::int from server_capabilities sc where sc.server_plugin_id=sp.id and sc.status='available') as capability_count,
              exists(select 1 from server_credentials sc where sc.server_plugin_id=sp.id and sc.owner_user_id is null
                and sc.kind in (select jsonb_array_elements_text(p.credential_kinds)) and sc.status='active') as has_active_credential,
              (select sc.created_at from server_credentials sc where sc.server_plugin_id=sp.id and sc.owner_user_id is null
                and sc.kind in (select jsonb_array_elements_text(p.credential_kinds)) and sc.status='active'
                order by sc.created_at desc limit 1) as active_credential_created_at
       from server_plugins sp join plugins p on p.key=sp.plugin_key
       left join ssh_provisioning pr on pr.server_plugin_id=sp.id
       left join postgres_provisioning ppr on ppr.server_plugin_id=sp.id
       where sp.server_id=$1 and sp.status<>'removed' order by sp.created_at`,
      [request.params.id]
    );
    return { plugins: result.rows };
  });

  server.get<{ Params: { id: string; pluginId: string } }>("/admin/servers/:id/plugins/:pluginId/artifacts", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const target = await getServerPlugin(options.db, request.params.pluginId);
    if (!target || target.server.id !== request.params.id || target.pluginKey !== "playwright") return error(reply, 404, "server_plugin_not_found");
    const artifacts = await options.db.query(
      `select ba.id,ba.artifact_type,ba.mime_type,ba.byte_size,ba.sha256,ba.redaction_status,ba.status,ba.created_at,ba.expires_at,
              u.display_name as actor_name,t.token_prefix
       from browser_artifacts ba left join users u on u.id=ba.actor_user_id left join api_tokens t on t.id=ba.actor_token_id
       where ba.server_plugin_id=$1 order by ba.created_at desc limit 100`, [target.id]
    );
    return { artifacts: artifacts.rows };
  });

  server.get<{ Params: { id: string; pluginId: string } }>("/admin/servers/:id/plugins/:pluginId/sessions", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const target = await getServerPlugin(options.db, request.params.pluginId);
    if (!target || target.server.id !== request.params.id || target.pluginKey !== "playwright") return error(reply, 404, "server_plugin_not_found");
    const sessions = await options.db.query(
      `select ls.id,ls.status,ls.current_url,ls.event_counts,ls.created_at,ls.last_activity_at,ls.idle_expires_at,ls.absolute_expires_at,
              u.display_name as actor_name,t.token_prefix
       from leased_sessions ls left join users u on u.id=ls.actor_user_id left join api_tokens t on t.id=ls.actor_token_id
       where ls.server_plugin_id=$1 order by ls.created_at desc limit 100`, [target.id]
    );
    return { sessions: sessions.rows };
  });

  server.post<{ Params: { id: string; pluginId: string; sessionId: string }; Body: { reason?: string } }>("/admin/servers/:id/plugins/:pluginId/sessions/:sessionId/close", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    if (!request.body.reason?.trim()) return error(reply, 400, "reason_required");
    const target = await getServerPlugin(options.db, request.params.pluginId);
    if (!target || target.server.id !== request.params.id || target.pluginKey !== "playwright") return error(reply, 404, "server_plugin_not_found");
    const found = await options.db.query<{ id: string; worker_lease_id: string; status: string }>(
      "select id,worker_lease_id,status from leased_sessions where id=$1 and server_plugin_id=$2", [request.params.sessionId, target.id]
    );
    const session = found.rows[0]; if (!session) return error(reply, 404, "browser_session_not_found");
    await browserRpc(options.config, { worker_lease_id: session.worker_lease_id }, "/v1/sessions/close").catch(() => undefined);
    await options.db.query(`update leased_sessions set status='closed',closed_at=coalesce(closed_at,now()),close_code='admin_close',version=version+1
      where id=$1 and status in ('opening','active','closing')`, [session.id]);
    await auditFromRequest(options.db, request, { eventType: "browser_session_close", actorUserId: actor.id, serverId: target.server.id,
      status: "success", reason: request.body.reason.trim(), input: { server_plugin_id: target.id, session_id: session.id } });
    return { status: "closed" };
  });

  server.get<{ Params: { id: string; pluginId: string; artifactId: string } }>("/admin/servers/:id/plugins/:pluginId/artifacts/:artifactId", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const target = await getServerPlugin(options.db, request.params.pluginId);
    if (!target || target.server.id !== request.params.id || target.pluginKey !== "playwright") return error(reply, 404, "server_plugin_not_found");
    const found = await options.db.query<{ mime_type: string; byte_size: number; sha256: string; storage_key: string; status: string; expires_at: string }>(
      `select mime_type,byte_size,sha256,storage_key,status,expires_at from browser_artifacts where id=$1 and server_plugin_id=$2`,
      [request.params.artifactId, target.id]
    );
    const artifact = found.rows[0];
    if (!artifact) return error(reply, 404, "artifact_not_found");
    if (artifact.status !== "available" || new Date(artifact.expires_at).getTime() <= Date.now()) return error(reply, 410, "artifact_expired");
    const data = await artifactStore.get(artifact.storage_key, Math.min(Number(artifact.byte_size), 10 * 1024 * 1024));
    if (data.byteLength !== Number(artifact.byte_size) || createHash("sha256").update(data).digest("hex") !== artifact.sha256) return error(reply, 502, "artifact_integrity_failed");
    await auditFromRequest(options.db, request, { eventType: "browser_artifact_read", actorUserId: actor.id, serverId: target.server.id,
      status: "success", input: { server_plugin_id: target.id, artifact_id: request.params.artifactId, byte_size: artifact.byte_size, sha256: artifact.sha256 } });
    return reply.type(artifact.mime_type).send(Buffer.from(data));
  });

  server.post<{ Params: { id: string }; Body: { plugin_key?: string; instance_name?: string; config?: Record<string, unknown> } }>(
    "/admin/servers/:id/plugins", async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply);
      if (!actor) return;
      if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
      if (!['team_admin','global_admin'].includes(actor.role)) return error(reply, 403, "team_admin_required");
      const plugin = request.body.plugin_key ? PLUGIN_REGISTRY.get(request.body.plugin_key) : undefined;
      const instanceName = request.body.instance_name?.trim();
      if (!plugin || !instanceName) return error(reply, 400, "validation_error");
      if (plugin.minRoleToEnable === "global_admin" && actor.role !== "global_admin") return error(reply, 403, "global_admin_required");
      if (plugin.cardinality === "singleton") {
        const existing = await options.db.query("select 1 from server_plugins where server_id=$1 and plugin_key=$2 and status<>'removed'", [request.params.id, plugin.key]);
        if (existing.rowCount) return error(reply, 409, "plugin_cardinality_exceeded");
      }
      const serverRow = await options.db.query<{ id: string; name: string; address: string; metadata: Record<string, unknown> }>("select id,name,address,metadata from servers where id=$1", [request.params.id]);
      if (!serverRow.rows[0]) return error(reply, 404, "server_not_found");
      const serverContext = { ...serverRow.rows[0], metadata: serverRow.rows[0].metadata ?? {} };
      let config = request.body.config ?? plugin.defaultConfig?.(serverContext) ?? (plugin.key === "wordpress"
        ? { base_url: "https://${server.address}" }
        : plugin.key === "ssh"
          ? { host: "${server.address}", port: 22, username: "aibroker", workspace_root: "/var/www/html" }
          : { host: "${server.address}", port: 5432, database: "postgres", scoped_role: "aibroker_scoped", allowed_schemas: ["public"], named_queries: {} });
      if (plugin.normalizeConfig) {
        try { config = plugin.normalizeConfig(config, serverContext); }
        catch (err) { return error(reply, 400, "validation_error", err instanceof Error ? err.message : "Invalid plugin configuration"); }
      }
      if (plugin.key === "playwright") {
        try { validatePlaywrightEnvironment(config, serverContext, options.config); }
        catch (err) { return error(reply, 400, "validation_error", err instanceof Error ? err.message : "Invalid browser target"); }
      }
      if (plugin.key === "postgres") {
        try { config = normalizePostgresConfig(config); }
        catch (err) { return error(reply, 400, err instanceof Error ? err.message : "validation_error"); }
      }
      if (plugin.key === "wordpress" && typeof config.base_url !== "string") return error(reply, 400, "validation_error");
      if (plugin.provision) {
        try { plugin.previewProvision?.({ id: "preview", instanceName, config, server: { id: request.params.id, name: "", address: serverRow.rows[0].address, metadata: {} } }); }
        catch (err) { return error(reply, 400, err instanceof Error ? err.message : "validation_error"); }
      }
      // Remove is a soft delete (status='removed') so audit/artifact foreign keys survive. Re-adding
      // must therefore resurrect any previously removed instance that still holds the unique
      // (server_id, plugin_key, instance_name) slot instead of colliding with it.
      const created = await options.db.query(
        `insert into server_plugins(server_id,plugin_key,instance_name,status,config) values($1,$2,$3,$4,$5::jsonb)
         on conflict (server_id,plugin_key,instance_name) do update
           set status=excluded.status, config=excluded.config, removed_at=null, updated_at=now()
           where server_plugins.status='removed'
         returning *`,
        [request.params.id, plugin.key, instanceName, plugin.provision ? "disabled" : "enabled", JSON.stringify(config)]
      );
      if (!created.rows[0]) return error(reply, 409, "plugin_instance_name_taken");
      if (plugin.key === "ssh") await options.db.query(
          `insert into ssh_provisioning(server_plugin_id,status,profile) values($1,'pending',$2::jsonb)
           on conflict (server_plugin_id) do update set status='pending', profile=excluded.profile, updated_at=now()`,
          [created.rows[0].id, JSON.stringify(plugin.previewProvision?.({ id: created.rows[0].id, instanceName, config,
            server: { id: request.params.id, name: "", address: serverRow.rows[0].address, metadata: {} } }).profile ?? {})]
        );
      if (plugin.key === "postgres") await options.db.query(
        `insert into postgres_provisioning(server_plugin_id,status,scoped_role,allowed_schemas) values($1,'pending',$2,$3::jsonb)
         on conflict (server_plugin_id) do update set status='pending', scoped_role=excluded.scoped_role, allowed_schemas=excluded.allowed_schemas, updated_at=now()`,
        [created.rows[0].id, String(config.scoped_role ?? "aibroker_scoped"), JSON.stringify(config.allowed_schemas ?? ["public"])]
      );
      await auditFromRequest(options.db, request, { eventType: "server_plugin_create", actorUserId: actor.id,
        serverId: request.params.id, status: "success", input: { after: created.rows[0] } });
      return reply.code(201).send({ plugin: created.rows[0] });
    }
  );

  server.get<{ Params: { id: string; pluginId: string } }>(
    "/admin/servers/:id/plugins/:pluginId/provisioning-preview", async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
      if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
      const target = await getServerPlugin(options.db, request.params.pluginId);
      if (!target || target.server.id !== request.params.id) return error(reply, 404, "server_plugin_not_found");
      const plugin = PLUGIN_REGISTRY.get(target.pluginKey);
      if (!plugin?.previewProvision) return error(reply, 400, "plugin_does_not_support_provisioning");
      return { preview: plugin.previewProvision(target) };
    }
  );

  server.get<{ Params: { id: string; pluginId: string } }>(
    "/admin/servers/:id/plugins/:pluginId/ssh-activity", async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
      if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
      const target = await getServerPlugin(options.db, request.params.pluginId);
      if (!target || target.server.id !== request.params.id || target.pluginKey !== "ssh") return error(reply, 404, "server_plugin_not_found");
      const sessions = await options.db.query(
        `select id,mode,host,username,status,reason,started_at,last_activity_at,ended_at,recording_failed,recording_truncated
         from host_sessions where server_plugin_id=$1 order by started_at desc limit 25`, [target.id]
      );
      const operations = await options.db.query(
        `select id,tool_name,status,reason,created_at,started_at,finished_at,error_code
         from host_operations where server_plugin_id=$1 order by created_at desc limit 25`, [target.id]
      );
      return { sessions: sessions.rows, operations: operations.rows };
    }
  );

  server.post<{ Params: { id: string; pluginId: string }; Body: {
    host?: string; port?: number; username?: string; private_key?: string; known_hosts_line?: string;
    host_key_fingerprint?: string; use_sudo?: boolean; confirmed?: boolean; reason?: string;
  } }>("/admin/servers/:id/plugins/:pluginId/provision", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
    if (actor.role !== "global_admin") return error(reply, 403, "global_admin_required");
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const target = await getServerPlugin(options.db, request.params.pluginId);
    if (!target || target.server.id !== request.params.id || target.pluginKey !== "ssh") return error(reply, 404, "server_plugin_not_found");
    const body = request.body;
    if (!body.confirmed || !body.reason?.trim()) return error(reply, 400, body.confirmed ? "reason_required" : "confirmation_required");
    if (!body.host || !body.username || !body.private_key || !body.known_hosts_line || !body.host_key_fingerprint) return error(reply, 400, "validation_error");
    if (body.host !== String(target.config.host ?? target.server.address)) return error(reply, 400, "provisioning_target_mismatch");
    if (!knownHostsMatchesFingerprint(body.known_hosts_line, body.host_key_fingerprint)) return error(reply, 400, "host_key_fingerprint_mismatch");
    const elevated: ElevatedCredential = { host: body.host, port: body.port ?? 22, username: body.username,
      privateKey: body.private_key, knownHostsLine: body.known_hosts_line, useSudo: body.use_sudo !== false };
    await options.db.query("update ssh_provisioning set status='provisioning',last_error=null,updated_at=now() where server_plugin_id=$1", [target.id]);
    try {
      const result = await sshPlugin.provision!(elevated, { ...target, services: { elevatedSshRunner: executeElevatedSshScript } });
      const encrypted = encryptJson({ privateKey: result.privateKey, knownHostsLine: body.known_hosts_line }, loadEncryptionKey(options.config.encryptionKeyBase64));
      result.privateKey = "";
      const client = await options.db.connect();
      try {
        await client.query("begin");
        await client.query("update server_credentials set status='replaced',replaced_at=now() where server_plugin_id=$1 and kind='ssh_private_key' and status='active'", [target.id]);
        const stored = await client.query<{ id: string }>(
          "insert into server_credentials(server_plugin_id,kind,encrypted_payload) values($1,'ssh_private_key',$2::jsonb) returning id",
          [target.id, JSON.stringify(encrypted)]
        );
        await client.query(
          `insert into ssh_connectors(server_id,server_plugin_id,credential_id,mode,host,port,username,host_key_fingerprint,session_recording)
           values($1,$2,$3,'constrained_shell',$4,$5,$6,$7,true)
           on conflict(server_id) do update set server_plugin_id=excluded.server_plugin_id,credential_id=excluded.credential_id,
             mode='constrained_shell',host=excluded.host,port=excluded.port,username=excluded.username,
             host_key_fingerprint=excluded.host_key_fingerprint,connection_status='unknown',updated_at=now()`,
          [target.server.id, target.id, stored.rows[0]!.id, body.host, body.port ?? 22, result.profile.username, body.host_key_fingerprint]
        );
        await client.query(
          `insert into server_workspaces(server_id,name,remote_root,kind) values($1,'html',$2,'plugin')
           on conflict(server_id,name) do update set remote_root=excluded.remote_root`, [target.server.id, result.profile.workspaceRoot]
        );
        await client.query("update server_plugins set status='enabled',updated_at=now() where id=$1", [target.id]);
        await client.query(
          "update ssh_provisioning set status='provisioned',profile=$2::jsonb,public_key=$3,provisioned_at=now(),deprovisioned_at=null,last_error=null,updated_at=now() where server_plugin_id=$1",
          [target.id, JSON.stringify(result.profile), result.publicKey]
        );
        await client.query("commit");
      } catch (err) { await client.query("rollback"); throw err; } finally { client.release(); }
      await auditFromRequest(options.db, request, { eventType: "ssh_provision", actorUserId: actor.id, serverId: target.server.id,
        status: "success", reason: body.reason.trim(), input: { server_plugin_id: target.id, profile: result.profile } });
      return { status: "provisioned", profile: result.profile };
    } catch (err) {
      const message = err instanceof Error ? err.message : "ssh_provisioning_failed";
      await options.db.query("update ssh_provisioning set status='failed',last_error=$2,updated_at=now() where server_plugin_id=$1", [target.id, message.slice(0, 500)]);
      await auditFromRequest(options.db, request, { eventType: "ssh_provision", actorUserId: actor.id, serverId: target.server.id,
        status: "failure", reason: body.reason.trim(), errorCode: "ssh_provisioning_failed", input: { server_plugin_id: target.id } });
      return error(reply, 502, "ssh_provisioning_failed", message);
    } finally {
      elevated.privateKey = "";
      body.private_key = "";
    }
  });

  server.post<{ Params: { id: string; pluginId: string }; Body: { admin_connection_string?: string; confirmed?: boolean; reason?: string } }>(
    "/admin/servers/:id/plugins/:pluginId/postgres-provision", async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
      if (actor.role !== "global_admin") return error(reply, 403, "global_admin_required");
      if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
      const target = await getServerPlugin(options.db, request.params.pluginId);
      if (!target || target.server.id !== request.params.id || target.pluginKey !== "postgres") return error(reply, 404, "server_plugin_not_found");
      if (!request.body.confirmed || !request.body.reason?.trim()) return error(reply, 400, request.body.confirmed ? "reason_required" : "confirmation_required");
      if (!request.body.admin_connection_string) return error(reply, 400, "validation_error");
      const credential = { kind: "postgres_admin" as const, connectionString: request.body.admin_connection_string };
      await options.db.query("update postgres_provisioning set status='provisioning',last_error=null,updated_at=now() where server_plugin_id=$1", [target.id]);
      try {
        const result = await postgresPlugin.provision!(credential, { ...target, services: { postgresProvisioner: provisionPostgresRole } });
        const connectionString = result.credential?.payload.connectionString;
        if (typeof connectionString !== "string") throw new Error("postgres_scoped_credential_missing");
        const encrypted = encryptJson({ connectionString }, loadEncryptionKey(options.config.encryptionKeyBase64));
        const client = await options.db.connect();
        try {
          await client.query("begin");
          await client.query("update server_credentials set status='replaced',replaced_at=now() where server_plugin_id=$1 and kind='postgres_scoped_role' and status='active'", [target.id]);
          const stored = await client.query<{ id: string }>("insert into server_credentials(server_plugin_id,kind,encrypted_payload) values($1,'postgres_scoped_role',$2::jsonb) returning id", [target.id, JSON.stringify(encrypted)]);
          await client.query(
            `insert into postgres_connectors(server_plugin_id,credential_id,host,port,database_name,scoped_role)
             values($1,$2,$3,$4,$5,$6) on conflict(server_plugin_id) do update set credential_id=excluded.credential_id,
               host=excluded.host,port=excluded.port,database_name=excluded.database_name,scoped_role=excluded.scoped_role,
               connection_status='unknown',updated_at=now()`,
            [target.id, stored.rows[0]!.id, String(target.config.host), Number(target.config.port ?? 5432), String(target.config.database), result.publicIdentity]
          );
          await client.query("update postgres_provisioning set status='provisioned',scoped_role=$2,allowed_schemas=$3::jsonb,provisioned_at=now(),deprovisioned_at=null,last_error=null,updated_at=now() where server_plugin_id=$1",
            [target.id, result.publicIdentity, JSON.stringify(target.config.allowed_schemas ?? ["public"])]);
          await client.query("update server_plugins set status='enabled',updated_at=now() where id=$1", [target.id]);
          await client.query("commit");
        } catch (err) { await client.query("rollback"); throw err; } finally { client.release(); }
        await auditFromRequest(options.db, request, { eventType: "postgres_provision", actorUserId: actor.id, serverId: target.server.id,
          status: "success", reason: request.body.reason.trim(), input: { server_plugin_id: target.id, scoped_role: result.publicIdentity, allowed_schemas: target.config.allowed_schemas } });
        return { status: "provisioned", scoped_role: result.publicIdentity };
      } catch (err) {
        const message = err instanceof Error ? err.message : "postgres_provisioning_failed";
        await options.db.query("update postgres_provisioning set status='failed',last_error=$2,updated_at=now() where server_plugin_id=$1", [target.id, message.slice(0, 500)]);
        await auditFromRequest(options.db, request, { eventType: "postgres_provision", actorUserId: actor.id, serverId: target.server.id,
          status: "failure", reason: request.body.reason.trim(), errorCode: "postgres_provisioning_failed", input: { server_plugin_id: target.id } });
        return error(reply, 502, "postgres_provisioning_failed", message);
      } finally { credential.connectionString = ""; request.body.admin_connection_string = ""; }
    }
  );

  server.post<{ Params: { id: string; pluginId: string }; Body: { admin_connection_string?: string; confirmed?: boolean; reason?: string } }>(
    "/admin/servers/:id/plugins/:pluginId/postgres-deprovision", async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
      if (actor.role !== "global_admin") return error(reply, 403, "global_admin_required");
      if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
      const target = await getServerPlugin(options.db, request.params.pluginId);
      if (!target || target.server.id !== request.params.id || target.pluginKey !== "postgres") return error(reply, 404, "server_plugin_not_found");
      if (!request.body.confirmed || !request.body.reason?.trim() || !request.body.admin_connection_string) return error(reply, 400, "confirmation_required");
      const credential = { kind: "postgres_admin" as const, connectionString: request.body.admin_connection_string };
      try {
        await postgresPlugin.deprovision!(credential, { ...target, services: { postgresDeprovisioner: deprovisionPostgresRole } });
        await options.db.query("update server_credentials set status='disabled' where server_plugin_id=$1 and kind='postgres_scoped_role' and status='active'", [target.id]);
        await options.db.query("update server_plugins set status='disabled',updated_at=now() where id=$1", [target.id]);
        await options.db.query("update postgres_provisioning set status='deprovisioned',deprovisioned_at=now(),updated_at=now() where server_plugin_id=$1", [target.id]);
        await auditFromRequest(options.db, request, { eventType: "postgres_deprovision", actorUserId: actor.id, serverId: target.server.id,
          status: "success", reason: request.body.reason.trim(), input: { server_plugin_id: target.id } });
        return { status: "deprovisioned" };
      } finally { credential.connectionString = ""; request.body.admin_connection_string = ""; }
    }
  );

  server.post<{ Params: { id: string; pluginId: string }; Body: {
    host?: string; port?: number; username?: string; private_key?: string; known_hosts_line?: string;
    host_key_fingerprint?: string; use_sudo?: boolean; confirmed?: boolean; reason?: string;
  } }>("/admin/servers/:id/plugins/:pluginId/deprovision", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
    if (actor.role !== "global_admin") return error(reply, 403, "global_admin_required");
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const target = await getServerPlugin(options.db, request.params.pluginId);
    const body = request.body;
    if (!target || target.server.id !== request.params.id || target.pluginKey !== "ssh") return error(reply, 404, "server_plugin_not_found");
    if (!body.confirmed || !body.reason?.trim()) return error(reply, 400, body.confirmed ? "reason_required" : "confirmation_required");
    if (!body.host || !body.username || !body.private_key || !body.known_hosts_line || !body.host_key_fingerprint) return error(reply, 400, "validation_error");
    if (body.host !== String(target.config.host ?? target.server.address)) return error(reply, 400, "provisioning_target_mismatch");
    if (!knownHostsMatchesFingerprint(body.known_hosts_line, body.host_key_fingerprint)) return error(reply, 400, "host_key_fingerprint_mismatch");
    const elevated: ElevatedCredential = { host: body.host, port: body.port ?? 22, username: body.username,
      privateKey: body.private_key, knownHostsLine: body.known_hosts_line, useSudo: body.use_sudo !== false };
    try {
      await sshPlugin.deprovision!(elevated, { ...target, services: { elevatedSshRunner: executeElevatedSshScript } });
      await options.db.query("update server_plugins set status='disabled',updated_at=now() where id=$1", [target.id]);
      await options.db.query("update server_credentials set status='disabled' where server_plugin_id=$1 and kind='ssh_private_key' and status='active'", [target.id]);
      await options.db.query("update ssh_provisioning set status='deprovisioned',deprovisioned_at=now(),updated_at=now() where server_plugin_id=$1", [target.id]);
      await auditFromRequest(options.db, request, { eventType: "ssh_deprovision", actorUserId: actor.id, serverId: target.server.id,
        status: "success", reason: body.reason.trim(), input: { server_plugin_id: target.id } });
      return { status: "deprovisioned" };
    } catch (err) {
      const message = err instanceof Error ? err.message : "ssh_deprovisioning_failed";
      await auditFromRequest(options.db, request, { eventType: "ssh_deprovision", actorUserId: actor.id, serverId: target.server.id,
        status: "failure", reason: body.reason.trim(), errorCode: "ssh_deprovisioning_failed", input: { server_plugin_id: target.id } });
      return error(reply, 502, "ssh_deprovisioning_failed", message);
    } finally { elevated.privateKey = ""; body.private_key = ""; }
  });

  server.patch<{ Params: { id: string; pluginId: string }; Body: { instance_name?: string; config?: Record<string, unknown> } }>(
    "/admin/servers/:id/plugins/:pluginId", async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
      if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
      const before = await options.db.query("select * from server_plugins where id=$1 and server_id=$2", [request.params.pluginId, request.params.id]);
      if (!before.rows[0]) return error(reply, 404, "server_plugin_not_found");
      const plugin = PLUGIN_REGISTRY.get(String(before.rows[0].plugin_key));
      let nextConfig = request.body.config;
      if (plugin?.normalizeConfig && nextConfig) {
        const serverRow = await options.db.query<{ id: string; name: string; address: string; metadata: Record<string, unknown> }>("select id,name,address,metadata from servers where id=$1", [request.params.id]);
        try { nextConfig = plugin.normalizeConfig(nextConfig, { ...serverRow.rows[0]!, metadata: serverRow.rows[0]?.metadata ?? {} }); }
        catch (err) { return error(reply, 400, "validation_error", err instanceof Error ? err.message : "Invalid plugin configuration"); }
        if (plugin.key === "playwright") {
          try { validatePlaywrightEnvironment(nextConfig, { address: serverRow.rows[0]!.address }, options.config); }
          catch (err) { return error(reply, 400, "validation_error", err instanceof Error ? err.message : "Invalid browser target"); }
          const authenticated = await options.db.query(
            "select 1 from server_credentials where server_plugin_id=$1 and kind='browser_storage_state' and status='active' limit 1", [request.params.pluginId]);
          if (authenticated.rowCount) {
            try { assertAuthenticatedBrowserScope(nextConfig); }
            catch (err) { return error(reply, 400, "validation_error", err instanceof Error ? err.message : "Invalid browser scope"); }
          }
        }
      }
      if (plugin?.key === "postgres" && nextConfig) {
        try { nextConfig = normalizePostgresConfig(nextConfig); }
        catch (err) { return error(reply, 400, err instanceof Error ? err.message : "validation_error"); }
      }
      const updated = await options.db.query(
        `update server_plugins set instance_name=coalesce($3,instance_name),config=coalesce($4::jsonb,config),updated_at=now()
         where id=$1 and server_id=$2 returning *`,
        [request.params.pluginId, request.params.id, request.body.instance_name?.trim() || null,
         nextConfig ? JSON.stringify(nextConfig) : null]
      );
      await auditFromRequest(options.db, request, { eventType: "server_plugin_update", actorUserId: actor.id,
        serverId: request.params.id, status: "success", input: plugin?.auditDiff?.(before.rows[0], updated.rows[0]) ?? { before: before.rows[0], after: updated.rows[0] } });
      if (plugin?.key === "playwright" && nextConfig) await closeBrowserSessionsForPlugin(options.db, options.config, request.params.pluginId, "configuration_changed");
      return { plugin: updated.rows[0] };
    }
  );

  // Capture Playwright's stored browser state by logging in through the live remote
  // browser instead of pasting cookie JSON (shared capture service).
  server.post<{ Params: { id: string; pluginId: string }; Body: { start_url?: string } }>(
    "/admin/servers/:id/plugins/:pluginId/credential/capture", async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
      if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
      const target = await getServerPlugin(options.db, request.params.pluginId);
      if (!target || target.server.id !== request.params.id || target.pluginKey !== "playwright") return error(reply, 404, "server_plugin_not_found");
      try { assertAuthenticatedBrowserScope(target.config); }
      catch (err) { return error(reply, 400, "validation_error", err instanceof Error ? err.message : "Invalid browser scope"); }
      const origins = (target.config.allowed_origins as unknown[]).map(String);
      const startUrl = request.body?.start_url ? String(request.body.start_url) : String(target.config.base_url);
      let start: URL;
      try { start = new URL(startUrl); } catch { return error(reply, 400, "validation_error", "start_url must be a URL"); }
      if (!origins.includes(start.origin)) return error(reply, 400, "browser_destination_denied", "start_url must be on one of the instance's allowed origins");
      const captureId = await createCapture(options.db, options.config, { serverPluginId: target.id, ownerUserId: actor.id, kind: "playwright_browser" });
      try {
        const frame = await browserRpc(options.config, {
          capture_id: captureId, url: start.toString(), allowed_origins: [...new Set([...origins, ...CHALLENGE_PROVIDER_ORIGINS])].slice(0, 20),
          ...captureBrowserDefaults(options.config, String(target.config.base_url), target)
        }, "/v1/capture/start");
        return { capture_id: captureId, frame };
      } catch (err) {
        await finishCapture(options.db, captureId, "failed");
        const mapped = mapToolError(err);
        return error(reply, mapped.status, mapped.code, mapped.message);
      }
    }
  );

  server.post<{ Params: { id: string; pluginId: string }; Body: { reason?: string } }>(
    "/admin/servers/:id/plugins/:pluginId/disable", async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
      if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
      if (!request.body.reason?.trim()) return error(reply, 400, "reason_required");
      const before = await options.db.query("select * from server_plugins where id=$1 and server_id=$2", [request.params.pluginId, request.params.id]);
      if (!before.rows[0]) return error(reply, 404, "server_plugin_not_found");
      const plugin = PLUGIN_REGISTRY.get(String(before.rows[0].plugin_key));
      await options.db.query("update server_plugins set status='disabled',updated_at=now() where id=$1", [request.params.pluginId]);
      if (String(before.rows[0].plugin_key) === "playwright") await closeBrowserSessionsForPlugin(options.db, options.config, request.params.pluginId, "plugin_disabled");
      await auditFromRequest(options.db, request, { eventType: "server_plugin_disable", actorUserId: actor.id,
        serverId: request.params.id, status: "success", reason: request.body.reason.trim(),
        input: plugin?.auditDiff?.(before.rows[0], { ...before.rows[0], status: "disabled" }) ?? { before: before.rows[0], after: { ...before.rows[0], status: "disabled" } } });
      return { ok: true };
    }
  );

  server.post<{ Params: { id: string; pluginId: string }; Body: { reason?: string; confirmed?: boolean } }>(
    "/admin/servers/:id/plugins/:pluginId/remove", async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
      if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
      if (!request.body.reason?.trim()) return error(reply, 400, "reason_required");
      const before = await options.db.query("select * from server_plugins where id=$1 and server_id=$2", [request.params.pluginId, request.params.id]);
      if (!before.rows[0]) return error(reply, 404, "server_plugin_not_found");
      if (before.rows[0].status === "removed") return { ok: true };
      const provisioning = String(before.rows[0].plugin_key) === "ssh"
        ? await options.db.query("select status from ssh_provisioning where server_plugin_id=$1", [request.params.pluginId])
        : String(before.rows[0].plugin_key) === "postgres"
          ? await options.db.query("select status from postgres_provisioning where server_plugin_id=$1", [request.params.pluginId])
          : { rows: [] as Array<{ status: string }> };
      if (provisioning.rows[0]?.status === "provisioned") return error(reply, 409, "deprovision_required");
      const [credentialCount, capabilityCount, operationCount, policyCount] = await Promise.all([
        options.db.query<{ count: number }>("select count(*)::int count from server_credentials where server_plugin_id=$1 and status='active'", [request.params.pluginId]),
        options.db.query<{ count: number }>("select count(*)::int count from server_capabilities where server_plugin_id=$1", [request.params.pluginId]),
        options.db.query<{ count: number }>("select count(*)::int count from host_operations where server_plugin_id=$1 and status in ('queued','running')", [request.params.pluginId]),
        options.db.query<{ count: number }>("select count(*)::int count from policy_plugin_intents where plugin_key=$1", [before.rows[0].plugin_key])
      ]);
      const dependents = { active_credentials: credentialCount.rows[0]?.count ?? 0, capabilities: capabilityCount.rows[0]?.count ?? 0,
        active_operations: operationCount.rows[0]?.count ?? 0, policy_intents: policyCount.rows[0]?.count ?? 0 };
      if (dependents.active_operations > 0) return error(reply, 409, "active_operations_exist");
      if (Object.values(dependents).some((count) => count > 0) && !request.body.confirmed) {
        return reply.code(409).send({ error: "removal_confirmation_required", dependents });
      }
      const client = await options.db.connect();
      try {
        await client.query("begin");
        await client.query("update server_plugins set status='removed',removed_at=now(),updated_at=now() where id=$1", [request.params.pluginId]);
        await client.query("update server_credentials set status='disabled' where server_plugin_id=$1 and status='active'", [request.params.pluginId]);
        await client.query("update server_capabilities set status='unavailable',details=details || '{\"reason\":\"plugin_removed\"}'::jsonb where server_plugin_id=$1", [request.params.pluginId]);
        await client.query("commit");
      } catch (err) { await client.query("rollback"); throw err; } finally { client.release(); }
      if (String(before.rows[0].plugin_key) === "playwright") await closeBrowserSessionsForPlugin(options.db, options.config, request.params.pluginId, "plugin_removed");
      const after = { ...before.rows[0], status: "removed", removed_at: new Date().toISOString() };
      const plugin = PLUGIN_REGISTRY.get(String(before.rows[0].plugin_key));
      await auditFromRequest(options.db, request, { eventType: "server_plugin_remove", actorUserId: actor.id,
        serverId: request.params.id, status: "success", reason: request.body.reason.trim(),
        input: { ...(plugin?.auditDiff?.(before.rows[0], after) ?? { before: before.rows[0], after }), dependents } });
      return { ok: true, dependents };
    }
  );

  server.post<{ Params: { id: string; pluginId: string }; Body: { username?: string; application_password?: string; storage_state?: unknown } }>(
    "/admin/servers/:id/plugins/:pluginId/credential", async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
      if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
      const target = await getServerPlugin(options.db, request.params.pluginId);
      if (!target || target.server.id !== request.params.id) return error(reply, 404, "server_plugin_not_found");
      if (target.pluginKey === "playwright") {
        try {
          const credential = await storeBrowserStorageState(options.db, options.config, target, request.body.storage_state);
          await auditFromRequest(options.db, request, { eventType: "server_plugin_credential_replace", actorUserId: actor.id,
            serverId: target.server.id, status: "success", input: { server_plugin_id: target.id, kind: "browser_storage_state" } });
          return { credential };
        } catch (err) {
          const mapped = mapToolError(err);
          return error(reply, mapped.status, mapped.code, mapped.message);
        }
      }
      if (!request.body.username || !request.body.application_password) return error(reply, 400, "validation_error");
      const kind = "wordpress_rest_application_password";
      const secret = { username: request.body.username, applicationPassword: request.body.application_password };
      const encrypted = encryptJson(secret, loadEncryptionKey(options.config.encryptionKeyBase64));
      await options.db.query("update server_credentials set status='replaced',replaced_at=now() where server_plugin_id=$1 and kind=$2 and status='active'", [target.id, kind]);
      const credential = await options.db.query(
        `insert into server_credentials(server_plugin_id,kind,encrypted_payload) values($1,$2,$3::jsonb)
         returning id,server_plugin_id,kind,status,created_at`, [target.id,kind,JSON.stringify(encrypted)]);
      await auditFromRequest(options.db, request, { eventType: "server_plugin_credential_replace", actorUserId: actor.id,
        serverId: target.server.id, status: "success", input: { server_plugin_id: target.id, kind } });
      return { credential: credential.rows[0] };
    }
  );

  server.post<{ Params: { id: string; pluginId: string } }>("/admin/servers/:id/plugins/:pluginId/test", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply); if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const target = await getServerPlugin(options.db, request.params.pluginId);
    if (!target || target.server.id !== request.params.id) return error(reply, 404, "server_plugin_not_found");
    const plugin = PLUGIN_REGISTRY.get(target.pluginKey);
    if (!plugin) return error(reply, 400, "plugin_not_loaded");
    try {
      const capabilities = await plugin.probeCapabilities({ ...target, services: { probes: {
        wordpress: () => probeWordPressCapabilities(options.db, options.config, target),
        ssh: () => probeSshCapabilities(options.db, options.config, target),
        postgres: () => probePostgresCapabilities(options.db, options.config, target),
        playwright: () => probePlaywrightCapabilities(options.db, options.config, target, artifactStore)
      } } });
      await recordServerPluginCapabilities(options.db, target.id, capabilities);
      if (target.pluginKey === "wordpress") {
        const failed = capabilities.find((capability) =>
          ["rest_reachable", "rest_authenticated"].includes(capability.capability) && capability.status !== "available"
        );
        if (failed) {
          const code = failed.errorCode ?? (failed.capability === "rest_authenticated" ? "auth_failed" : "unreachable");
          const message = failed.errorMessage ?? (failed.capability === "rest_authenticated"
            ? "WordPress rejected the saved REST credential. Replace it and try again."
            : "The WordPress REST API could not be reached. Check the plugin base URL and server availability.");
          await auditFromRequest(options.db, request, { eventType: "server_plugin_probe", actorUserId: actor.id,
            serverId: target.server.id, status: "failure", errorCode: code, input: { server_plugin_id: target.id, capabilities } });
          // Do not use 401 here: that status is reserved for the caller's AIBroker session
          // and causes the web client to sign the administrator out. This is a rejected
          // downstream WordPress credential, not failed authentication to AIBroker.
          return error(reply, failed.capability === "rest_authenticated" ? 422 : 502, code, message);
        }
      }
      await auditFromRequest(options.db, request, { eventType: "server_plugin_probe", actorUserId: actor.id,
        serverId: target.server.id, status: "success", input: { server_plugin_id: target.id, capabilities } });
      return { status: "ok", capabilities };
    } catch (err) {
      const mapped = mapToolError(err);
      await auditFromRequest(options.db, request, { eventType: "server_plugin_probe", actorUserId: actor.id,
        serverId: target.server.id, status: "failure", errorCode: mapped.code, input: { server_plugin_id: target.id } });
      return error(reply, 502, mapped.code, mapped.message);
    }
  });

  server.post<{ Params: { id: string }; Body: { reason?: string } }>("/admin/servers/:id/disable", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    if (!request.body.reason?.trim()) return error(reply, 400, "reason_required");
    const before = await options.db.query("select * from servers where id=$1", [request.params.id]);
    if (!before.rows[0]) return error(reply, 404, "server_not_found");
    await options.db.query("update servers set status = 'disabled', disabled_at = now(), updated_at = now() where id = $1", [
      request.params.id
    ]);
    await auditFromRequest(options.db, request, {
      eventType: "server_disable",
      actorUserId: actor.id,
      serverId: request.params.id,
      status: "success",
      reason: request.body.reason.trim(),
      input: { before: before.rows[0], after: { ...before.rows[0], status: "disabled" } }
    });
    return { ok: true };
  });

  server.post<{
    Params: { id: string };
    Body: { username?: string; application_password?: string; expires_at?: string | null; rotation_due_at?: string | null };
  }>("/admin/servers/:id/rest-credential", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    if (!request.body.username || !request.body.application_password) return error(reply, 400, "validation_error");
    const instance = await options.db.query<{ id: string }>("select id from server_plugins where server_id=$1 and plugin_key='wordpress' and status='enabled' order by created_at limit 1", [request.params.id]);
    const serverPluginId = instance.rows[0]?.id;
    if (!serverPluginId) return error(reply, 409, "server_plugin_required");
    const key = loadEncryptionKey(options.config.encryptionKeyBase64);
    const encrypted = encryptJson(
      { username: request.body.username, applicationPassword: request.body.application_password },
      key
    );
    await options.db.query(
      "update server_credentials set status = 'replaced', replaced_at = now() where server_plugin_id = $1 and kind = 'wordpress_rest_application_password' and status = 'active'",
      [serverPluginId]
    );
    const result = await options.db.query(
      `insert into server_credentials (server_plugin_id, kind, encrypted_payload, expires_at, rotation_due_at)
       values ($1,'wordpress_rest_application_password',$2::jsonb,$3,$4)
       returning id, server_plugin_id, kind, status, created_at`,
      [serverPluginId, JSON.stringify(encrypted), request.body.expires_at ?? null, request.body.rotation_due_at ?? null]
    );
    await auditFromRequest(options.db, request, {
      eventType: "credential_replace",
      actorUserId: actor.id,
      serverId: request.params.id,
      status: "success",
      input: { server_id: request.params.id, kind: "wordpress_rest_application_password" }
    });
    return { credential: result.rows[0] };
  });

  server.post<{
    Params: { id: string };
    Body: {
      host?: string;
      port?: number;
      username?: string;
      private_key?: string;
      passphrase?: string;
      known_hosts_line?: string;
      host_key_fingerprint?: string;
      mode?: "typed_wp_cli" | "constrained_shell" | "full_shell" | "root_access";
      has_sudo?: boolean;
      unrestricted_sudo?: boolean;
      wordpress_path?: string | null;
      wp_cli_path?: string | null;
    };
  }>("/admin/servers/:id/ssh-credential", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    return error(reply, 410, "ssh_provisioning_required", "Add the SSH plugin and use its one-time provisioning flow. Elevated credentials are never stored.");
  });

  server.get<{ Params: { id: string } }>("/admin/servers/:id/ssh-connector", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const result = await options.db.query(
      `select c.server_id, c.mode, c.host, c.port, c.username, c.host_key_fingerprint, c.wordpress_path, c.wp_cli_path,
              c.has_sudo, c.unrestricted_sudo, c.connection_status, c.last_tested_at, c.session_recording,
              c.idle_timeout_seconds, c.max_session_seconds, sc.status as credential_status, sc.last_used_at, sc.rotation_due_at
       from ssh_connectors c left join server_credentials sc on sc.id=c.credential_id where c.server_id=$1`, [request.params.id]
    );
    if (!result.rows[0]) return error(reply, 404, "ssh_connector_not_found");
    return { connector: result.rows[0] };
  });

  server.post<{Params:{id:string};Body:{adapter_id?:string;base_url?:string,token?:string,api_version?:string,configuration?:Record<string,unknown>}}>("/admin/servers/:id/hosting-provider",async(request,reply)=>{
    const actor=await requireAdmin(options.db,request,reply);if(!actor)return;if(!(await canManageServer(options.db,actor,request.params.id)))return error(reply,403,"admin_denied");
    if(request.body.adapter_id!=="aibroker_v1"||!request.body.base_url||!request.body.token)return error(reply,400,"validation_error","Only reviewed adapter aibroker_v1 is supported.");
    try{new URL(request.body.base_url);}catch{return error(reply,400,"validation_error","Invalid provider URL.");}
    const encrypted=encryptJson({token:request.body.token},loadEncryptionKey(options.config.encryptionKeyBase64));
    await options.db.query("update server_credentials set status='replaced',replaced_at=now() where server_id=$1 and kind='hosting_provider_token' and status='active'",[request.params.id]);
    const credential=await options.db.query<{id:string}>("insert into server_credentials(server_id,kind,encrypted_payload) values($1,'hosting_provider_token',$2::jsonb) returning id",[request.params.id,JSON.stringify(encrypted)]);
    const provider=await options.db.query(`insert into hosting_providers(server_id,adapter_id,credential_id,base_url,api_version,configuration) values($1,$2,$3,$4,$5,$6::jsonb) on conflict(server_id,adapter_id) do update set credential_id=excluded.credential_id,base_url=excluded.base_url,api_version=excluded.api_version,configuration=excluded.configuration,status='unknown' returning id,server_id,adapter_id,base_url,api_version,status`,[request.params.id,request.body.adapter_id,credential.rows[0]!.id,request.body.base_url,request.body.api_version??null,JSON.stringify(request.body.configuration??{})]);
    return{provider:provider.rows[0]};
  });

  server.get("/admin/recovery",async(request,reply)=>{const actor=await requireAdmin(options.db,request,reply);if(!actor)return;const scope=await managedServerIds(options.db,actor);const scoped=(alias:string)=>scope?`${alias}.server_id=any($1::uuid[])`:"true";const params=scope?[scope]:[];const backups=await options.db.query(`select b.*,s.name server_name from backups b join servers s on s.id=b.server_id where b.deleted_at is null and ${scoped("b")} order by b.created_at desc limit 200`,params);const restores=await options.db.query(`select r.*,s.name server_name from restore_history r join servers s on s.id=r.server_id where ${scoped("r")} order by r.created_at desc limit 100`,params);const deployments=await options.db.query(`select d.*,s.name server_name from deployments d join servers s on s.id=d.server_id where ${scoped("d")} order by d.created_at desc limit 100`,params);const operations=await options.db.query(`select o.id,o.server_id,s.name server_name,o.tool_name,o.status,o.progress,o.error_code,o.created_at,o.finished_at from host_operations o join servers s on s.id=o.server_id where (o.tool_name like 'backup_%' or o.tool_name like 'database_%' or o.tool_name like 'hosting_%' or o.tool_name like 'network_%') and ${scoped("o")} order by o.created_at desc limit 300`,params);const providers=await options.db.query(`select p.id,p.adapter_id,p.base_url,p.api_version,p.status,p.last_discovered_at,s.name server_name from hosting_providers p join servers s on s.id=p.server_id where ${scoped("p")} order by s.name`,params);return{backups:backups.rows,restores:restores.rows,deployments:deployments.rows,operations:operations.rows,providers:providers.rows};});

  server.get("/admin/networks",async(request,reply)=>{const actor=await requireAdmin(options.db,request,reply);if(!actor)return;const scope=await managedServerIds(options.db,actor);const result=await options.db.query(`select n.*,coalesce(json_agg(json_build_object('id',s.id,'name',s.name,'network_server_id',m.network_server_id)) filter(where s.id is not null),'[]') servers from wordpress_networks n left join wordpress_network_servers m on m.network_id=n.id left join servers s on s.id=m.server_id ${scope?"where n.primary_server_id=any($1::uuid[])":""} group by n.id order by n.name`,scope?[scope]:[]);return{networks:result.rows};});
  server.post<{Body:{name?:string;primary_server_id?:string;domain?:string;base_path?:string}}>("/admin/networks",async(request,reply)=>{const actor=await requireAdmin(options.db,request,reply);if(!actor)return;if(!request.body.name||!request.body.primary_server_id||!request.body.domain)return error(reply,400,"validation_error");if(!(await canManageServer(options.db,actor,request.body.primary_server_id)))return error(reply,403,"admin_denied");const credential=await options.db.query<{id:string}>(`select sc.id from server_plugins sp join server_credentials sc on sc.server_plugin_id=sp.id where sp.server_id=$1 and sp.plugin_key='ssh' and sp.status='enabled' and sc.kind='ssh_private_key' and sc.status='active' order by sc.created_at desc limit 1`,[request.body.primary_server_id]);const client=await options.db.connect();try{await client.query("begin");const created=await client.query<{id:string}>("insert into wordpress_networks(name,primary_server_id,credential_id,domain,base_path) values($1,$2,$3,$4,$5) returning *",[request.body.name,request.body.primary_server_id,credential.rows[0]?.id??null,request.body.domain,request.body.base_path??"/"]);await client.query("insert into wordpress_network_servers(network_id,server_id,network_server_id) values($1,$2,1)",[created.rows[0]!.id,request.body.primary_server_id]);await client.query("commit");return{network:created.rows[0]};}catch(err){await client.query("rollback");throw err;}finally{client.release();}});

  server.post<{ Params: { id: string }; Body: { name?: string; remote_root?: string; kind?: "plugin" | "theme"; allowed_extensions?: string[]; max_file_bytes?: number; commands?: Record<string, string[]>; direct_live_edit?: boolean } }>("/admin/servers/:id/workspaces", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    if (!request.body.name || !request.body.remote_root?.startsWith("/") || !request.body.kind) return error(reply, 400, "validation_error");
    const result = await options.db.query(
      `insert into server_workspaces(server_id,name,remote_root,kind,allowed_extensions,max_file_bytes,commands,direct_live_edit)
       values($1,$2,$3,$4,coalesce($5,array['php','js','ts','css','json','md']),coalesce($6,1048576),coalesce($7::jsonb,'{}'),$8)
       on conflict(server_id,name) do update set remote_root=excluded.remote_root, kind=excluded.kind, allowed_extensions=excluded.allowed_extensions,
         max_file_bytes=excluded.max_file_bytes, commands=excluded.commands, direct_live_edit=excluded.direct_live_edit returning *`,
      [request.params.id, request.body.name, request.body.remote_root, request.body.kind, request.body.allowed_extensions ?? null, request.body.max_file_bytes ?? null, JSON.stringify(request.body.commands ?? {}), request.body.direct_live_edit === true]
    );
    return { workspace: result.rows[0] };
  });

  server.get("/me/host-operations", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const result = await options.db.query(`select id, server_id, tool_name, status, exit_code, error_code, reason, started_at, finished_at, created_at from host_operations where actor_user_id=$1 order by created_at desc limit 100`, [actor.id]);
    return { operations: result.rows };
  });

  server.get("/me/host-servers", async (request, reply) => {
    const actor=await requireUser(options.db,request,reply);if(!actor)return;
    const groups=await options.db.query<{group_id:string}>("select group_id from group_memberships where user_id=$1",[actor.id]);
    const result=await options.db.query(`select distinct s.id,s.name,c.server_plugin_id,c.mode,c.connection_status from servers s join ssh_connectors c on c.server_id=s.id join server_bindings b on b.server_id=s.id where s.status='active' and ((b.subject_type='user' and b.subject_id=$1) or (b.subject_type='group' and b.subject_id=any($2::uuid[]))) order by s.name`,[actor.id,groups.rows.map(r=>r.group_id)]);
    return {servers:result.rows};
  });

  // ---- WordPress login sessions (AB-ELEMENTOR D1): each user connects their own ----
  const boundWordPressPlugin = async (actor: AdminUser, serverPluginId: string): Promise<ServerPluginTarget | null> => {
    if (!/^[0-9a-f-]{36}$/i.test(serverPluginId)) return null;
    const groups = await options.db.query<{ group_id: string }>("select group_id from group_memberships where user_id=$1", [actor.id]);
    const bound = await options.db.query(
      `select 1 from server_plugins sp join servers s on s.id=sp.server_id and s.status='active'
       join server_bindings b on b.server_id=s.id
       where sp.id=$1 and sp.plugin_key='wordpress' and sp.status='enabled'
         and ((b.subject_type='user' and b.subject_id=$2) or (b.subject_type='group' and b.subject_id=any($3::uuid[]))) limit 1`,
      [serverPluginId, actor.id, groups.rows.map((row) => row.group_id)]);
    return bound.rowCount ? getServerPlugin(options.db, serverPluginId) : null;
  };

  server.get("/me/wordpress-sessions", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const groups = await options.db.query<{ group_id: string }>("select group_id from group_memberships where user_id=$1", [actor.id]);
    const result = await options.db.query<{
      server_plugin_id: string; instance_name: string; server_id: string; server_name: string;
      session_status: string | null; expires_at: string | null; metadata: Record<string, unknown> | null; connected_at: string | null; last_used_at: string | null;
    }>(
      `select distinct on (sp.id) sp.id as server_plugin_id, sp.instance_name, s.id as server_id, s.name as server_name,
              sc.status as session_status, sc.expires_at, sc.metadata, sc.created_at as connected_at, sc.last_used_at
       from servers s
       join server_plugins sp on sp.server_id=s.id and sp.plugin_key='wordpress' and sp.status='enabled'
       join server_bindings b on b.server_id=s.id
       left join lateral (
         select c.status, c.expires_at, c.metadata, c.created_at, c.last_used_at from server_credentials c
         where c.server_plugin_id=sp.id and c.owner_user_id=$1 and c.kind='wordpress_session' and c.status in ('active','expired')
         order by c.created_at desc limit 1
       ) sc on true
       where s.status='active' and ((b.subject_type='user' and b.subject_id=$1) or (b.subject_type='group' and b.subject_id=any($2::uuid[])))
       order by sp.id`, [actor.id, groups.rows.map((row) => row.group_id)]);
    const now = Date.now();
    const sessions = result.rows.map((row) => {
      const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null;
      const state = !row.session_status ? "not_connected"
        : row.session_status === "expired" || (expiresAt !== null && expiresAt <= now) ? "expired"
          : expiresAt !== null && expiresAt - now < 2 * 86400_000 ? "expiring_soon" : "connected";
      const meta = row.metadata ?? {};
      return {
        server_plugin_id: row.server_plugin_id, instance_name: row.instance_name, server_id: row.server_id, server_name: row.server_name,
        state, expires_at: row.expires_at, connected_at: row.connected_at, last_used_at: row.last_used_at,
        wp_user_name: meta.wp_user_name ?? null, roles: meta.roles ?? [], privileged: meta.privileged === true
      };
    }).sort((a, b) => `${a.server_name}${a.instance_name}`.localeCompare(`${b.server_name}${b.instance_name}`));
    return { sessions };
  });

  // Shared by every way of connecting a session (password, 2FA relay, live browser).
  const sessionConnectedResponse = async (request: FastifyRequest, actor: AdminUser, target: ServerPluginTarget, method: string,
    connected: { expiresAt: Date | null; metadata: { wp_user_slug: string; wp_user_name: string; roles: string[]; privileged: boolean } }) => {
    await auditFromRequest(options.db, request, { eventType: "wordpress_session_connect", actorUserId: actor.id, serverId: target.server.id,
      status: "success", input: { server_plugin_id: target.id, method, wp_user: connected.metadata.wp_user_slug, privileged: connected.metadata.privileged } });
    return {
      session: { server_plugin_id: target.id, state: "connected", expires_at: connected.expiresAt?.toISOString() ?? null,
        wp_user_name: connected.metadata.wp_user_name, roles: connected.metadata.roles, privileged: connected.metadata.privileged },
      ...(connected.metadata.privileged ? { warning: "This WordPress account has administrator capabilities. An Editor-level account is safer for AI-driven editing." } : {})
    };
  };
  const sessionConnectFailed = async (request: FastifyRequest, reply: FastifyReply, actor: AdminUser, target: ServerPluginTarget, method: string, err: unknown) => {
    const mapped = err instanceof SessionConnectError ? { code: err.code, status: err.status, message: err.message } : mapToolError(err);
    await auditFromRequest(options.db, request, { eventType: "wordpress_session_connect", actorUserId: actor.id, serverId: target.server.id,
      status: "failure", errorCode: mapped.code, input: { server_plugin_id: target.id, method } });
    // 401 is reserved for the AIBroker session itself (the UI signs out on it); a
    // rejected WordPress password or code is a 422.
    return error(reply, mapped.status >= 500 ? 502 : mapped.status === 401 ? 422 : mapped.status, mapped.code, mapped.message);
  };

  server.post<{ Body: { server_plugin_id?: string; username?: string; password?: string } }>("/me/wordpress-sessions", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const { server_plugin_id: pluginId = "", username = "", password = "" } = request.body ?? {};
    if (!username.trim() || !password) return error(reply, 400, "validation_error", "Username and password are required.");
    const target = await boundWordPressPlugin(actor, pluginId);
    if (!target) return error(reply, 404, "server_plugin_not_found");
    const rate = await consumeRateBucket(options.db, `wordpress-session-login:${actor.id}:${target.id}`, 5);
    if (!rate.allowed) return error(reply, 429, "rate_limited", "Too many login attempts; wait a minute and try again.");
    try {
      const connected = await connectWordPressSession(options.db, options.config, target, actor.id, { username: username.trim(), password });
      return await sessionConnectedResponse(request, actor, target, "password", connected);
    } catch (err) {
      // A relayable second factor: park the pending login and ask for the code (D6).
      if (err instanceof WordPressSessionError && err.code === "wordpress_login_challenge" && err.pending) {
        const captureId = await createCapture(options.db, options.config, { serverPluginId: target.id, ownerUserId: actor.id,
          kind: "wordpress_two_factor", payload: err.pending as unknown as Record<string, unknown> });
        reply.code(409);
        return { error: "two_factor_required", message: err.message, capture_id: captureId };
      }
      // Anything else the background login cannot complete falls back to the live browser (D7).
      if (err instanceof WordPressSessionError && err.code === "wordpress_login_challenge") {
        await auditFromRequest(options.db, request, { eventType: "wordpress_session_connect", actorUserId: actor.id, serverId: target.server.id,
          status: "failure", errorCode: err.code, input: { server_plugin_id: target.id, method: "password", challenge: err.challenge } });
        reply.code(409);
        return { error: err.code, message: err.message, challenge: err.challenge, browser_login: true };
      }
      return sessionConnectFailed(request, reply, actor, target, "password", err);
    }
  });

  server.post<{ Body: { capture_id?: string; code?: string } }>("/me/wordpress-sessions/two-factor", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const capture = await loadCapture<PendingTwoFactor>(options.db, options.config, String(request.body?.capture_id ?? ""), actor.id, ["wordpress_two_factor"]);
    if (!capture) return error(reply, 404, "capture_not_found", "This login expired. Start again.");
    const target = await boundWordPressPlugin(actor, capture.serverPluginId);
    if (!target) { await finishCapture(options.db, capture.id, "failed"); return error(reply, 404, "server_plugin_not_found"); }
    try {
      const connected = await completeWordPressTwoFactor(options.db, options.config, target, actor.id, capture.payload, String(request.body?.code ?? ""));
      await finishCapture(options.db, capture.id, "completed");
      return await sessionConnectedResponse(request, actor, target, "two_factor", connected);
    } catch (err) {
      if (err instanceof WordPressSessionError && err.code === "wordpress_2fa_invalid" && err.pending) {
        if (capture.attempts + 1 >= MAX_TWO_FACTOR_ATTEMPTS) {
          await finishCapture(options.db, capture.id, "failed");
          return error(reply, 422, "wordpress_2fa_invalid", "Too many wrong codes. Start the login again.");
        }
        await updateCapturePayload(options.db, options.config, capture.id, err.pending as unknown as Record<string, unknown>, true);
        return error(reply, 422, err.code, err.message);
      }
      await finishCapture(options.db, capture.id, "failed");
      return sessionConnectFailed(request, reply, actor, target, "two_factor", err);
    }
  });

  // Live remote-browser login (capture flow B): the worker opens the login page, the UI
  // streams frames and sends clicks/keys, and the capture completes when WordPress sets
  // its logged-in cookie.
  server.post<{ Body: { server_plugin_id?: string } }>("/me/wordpress-sessions/browser", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const target = await boundWordPressPlugin(actor, String(request.body?.server_plugin_id ?? ""));
    if (!target) return error(reply, 404, "server_plugin_not_found");
    const rate = await consumeRateBucket(options.db, `wordpress-session-browser:${actor.id}:${target.id}`, 5);
    if (!rate.allowed) return error(reply, 429, "rate_limited", "Too many login attempts; wait a minute and try again.");
    const base = target.server.base_url.replace(/\/$/, "");
    const loginPath = typeof target.config.login_path === "string" ? target.config.login_path : "/wp-login.php";
    const captureId = await createCapture(options.db, options.config, { serverPluginId: target.id, ownerUserId: actor.id, kind: "wordpress_browser" });
    try {
      const frame = await browserRpc(options.config, {
        capture_id: captureId, url: `${base}${loginPath}`, allowed_origins: captureOrigins(base, target.config.login_extra_origins),
        ...captureBrowserDefaults(options.config, base, target), success_cookie_prefix: "wordpress_logged_in_"
      }, "/v1/capture/start");
      return { capture_id: captureId, frame };
    } catch (err) {
      await finishCapture(options.db, captureId, "failed");
      const mapped = mapToolError(err);
      return error(reply, mapped.status, mapped.code, mapped.message);
    }
  });

  // Generic capture controls, shared by WordPress sessions and Playwright browser state.
  server.post<{ Params: { id: string } }>("/me/login-captures/:id/frame", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const capture = await loadCapture(options.db, options.config, request.params.id, actor.id, ["wordpress_browser", "playwright_browser"]);
    if (!capture) return error(reply, 404, "capture_not_found", "This login expired. Start again.");
    try { return { frame: await browserRpc(options.config, { capture_id: capture.id }, "/v1/capture/frame") }; }
    catch (err) { return captureWorkerError(reply, capture.id, err); }
  });

  server.post<{ Params: { id: string }; Body: { events?: unknown[] } }>("/me/login-captures/:id/input", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const capture = await loadCapture(options.db, options.config, request.params.id, actor.id, ["wordpress_browser", "playwright_browser"]);
    if (!capture) return error(reply, 404, "capture_not_found", "This login expired. Start again.");
    if (!Array.isArray(request.body?.events) || !request.body.events.length) return error(reply, 400, "validation_error", "events are required");
    try { return { frame: await browserRpc(options.config, { capture_id: capture.id, events: request.body.events.slice(0, 50) }, "/v1/capture/input") }; }
    catch (err) { return captureWorkerError(reply, capture.id, err); }
  });

  server.post<{ Params: { id: string } }>("/me/login-captures/:id/finish", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const capture = await loadCapture(options.db, options.config, request.params.id, actor.id, ["wordpress_browser", "playwright_browser"]);
    if (!capture) return error(reply, 404, "capture_not_found", "This login expired. Start again.");
    let finished: Record<string, unknown>;
    // Playwright captures have no success cookie to wait for: "Done" finishes them.
    try { finished = await browserRpc(options.config, { capture_id: capture.id, ...(capture.kind === "playwright_browser" ? { force: true } : {}) }, "/v1/capture/finish"); }
    catch (err) { return captureWorkerError(reply, capture.id, err); }
    if (finished.status !== "completed") return { status: "active" };
    const storageState = finished.storage_state as Record<string, unknown>;
    if (capture.kind === "wordpress_browser") {
      const target = await boundWordPressPlugin(actor, capture.serverPluginId);
      if (!target) { await finishCapture(options.db, capture.id, "failed"); return error(reply, 404, "server_plugin_not_found"); }
      try {
        const connected = await storeBrowserCapturedSession(options.db, options.config, target, actor.id, storageState);
        await finishCapture(options.db, capture.id, "completed");
        return { status: "completed", ...(await sessionConnectedResponse(request, actor, target, "browser", connected)) };
      } catch (err) {
        await finishCapture(options.db, capture.id, "failed");
        return sessionConnectFailed(request, reply, actor, target, "browser", err);
      }
    }
    const target = await getServerPlugin(options.db, capture.serverPluginId);
    const admin = await requireAdmin(options.db, request, reply); if (!admin) return;
    if (!target || !(await canManageServer(options.db, admin, target.server.id))) { await finishCapture(options.db, capture.id, "failed"); return error(reply, 403, "admin_denied"); }
    try {
      const credential = await storeBrowserStorageState(options.db, options.config, target, storageState);
      await finishCapture(options.db, capture.id, "completed");
      await auditFromRequest(options.db, request, { eventType: "server_plugin_credential_replace", actorUserId: admin.id,
        serverId: target.server.id, status: "success", input: { server_plugin_id: target.id, kind: "browser_storage_state", method: "browser_capture" } });
      return { status: "completed", credential };
    } catch (err) {
      await finishCapture(options.db, capture.id, "failed");
      const mapped = mapToolError(err);
      return error(reply, mapped.status, mapped.code, mapped.message);
    }
  });

  server.delete<{ Params: { id: string } }>("/me/login-captures/:id", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const capture = await loadCapture(options.db, options.config, request.params.id, actor.id);
    if (!capture) return error(reply, 404, "capture_not_found");
    if (capture.kind !== "wordpress_two_factor") await browserRpc(options.config, { capture_id: capture.id }, "/v1/capture/cancel").catch(() => undefined);
    await finishCapture(options.db, capture.id, "cancelled");
    return { status: "cancelled" };
  });

  const captureWorkerError = async (reply: FastifyReply, captureId: string, err: unknown) => {
    const mapped = mapToolError(err);
    if (["browser_capture_not_found", "browser_capture_expired"].includes(mapped.code)) await finishCapture(options.db, captureId, "expired");
    return error(reply, mapped.status, mapped.code, mapped.message);
  };

  // Disconnecting only needs ownership of the session, not a current server binding.
  server.delete<{ Params: { serverPluginId: string } }>("/me/wordpress-sessions/:serverPluginId", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    if (!/^[0-9a-f-]{36}$/i.test(request.params.serverPluginId)) return error(reply, 404, "session_not_found");
    const target = await getServerPlugin(options.db, request.params.serverPluginId);
    if (!target) return error(reply, 404, "session_not_found");
    const removed = await disconnectWordPressSession(options.db, options.config, target, actor.id);
    if (!removed) return error(reply, 404, "session_not_found");
    await auditFromRequest(options.db, request, { eventType: "wordpress_session_disconnect", actorUserId: actor.id, serverId: target.server.id,
      status: "success", input: { server_plugin_id: target.id } });
    return { status: "disconnected" };
  });

  server.get<{ Params: { id: string } }>("/me/host-operations/:id", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const operation = await options.db.query("select id, server_id, tool_name, status, result, exit_code, error_code, reason, started_at, finished_at, created_at from host_operations where id=$1 and actor_user_id=$2", [request.params.id, actor.id]);
    if (!operation.rows[0]) return error(reply, 404, "operation_not_found");
    const logs = await options.db.query("select id, stream, content, created_at from host_operation_logs where operation_id=$1 order by id", [request.params.id]);
    return { operation: operation.rows[0], logs: logs.rows };
  });

  server.post<{ Params: { id: string } }>("/me/host-operations/:id/cancel", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const result = await options.db.query(`update host_operations set cancel_requested_at=now(), status=case when status='queued' then 'cancelled' else status end, updated_at=now() where id=$1 and actor_user_id=$2 and status in ('queued','running') returning id,status`, [request.params.id, actor.id]);
    if (!result.rows[0]) return error(reply, 409, "operation_not_cancellable");
    await options.db.query("update jobs set status='cancelled', updated_at=now() where id=(select job_id from host_operations where id=$1) and status='queued'", [request.params.id]);
    return { operation: result.rows[0] };
  });

  server.post<{ Body: { server_id?: string; mode?: "read" | "constrained_shell" | "full_shell" | "root_access"; reason?: string } }>("/me/host-sessions", async (request, reply) => {
    const user = await requireUser(options.db, request, reply); if (!user) return;
    if (!request.body.server_id || !request.body.mode) return error(reply, 400, "validation_error");
    const server = await getServer(options.db, request.body.server_id); if (!server) return error(reply, 404, "server_not_found");
    const groups = await options.db.query<{ group_id: string }>("select group_id from group_memberships where user_id=$1", [user.id]);
    const actor: TokenActor = { tokenId: user.id, userId: user.id, role: user.role, status: user.status, groupIds: groups.rows.map((row) => row.group_id) };
    const tool = request.body.mode === "root_access" ? "host_session_root" : request.body.mode === "full_shell" ? "host_session_full_shell" : request.body.mode === "constrained_shell" ? "host_session_constrained" : "host_session_read";
    const decision = await evaluateAccess(options.db, actor, server, tool, true, request.body); if (!decision.allowed) return error(reply, 403, decision.reason);
    const connectorResult = await options.db.query<{ server_plugin_id: string | null; credential_id: string; mode: string; host: string; username: string; session_recording: boolean }>("select server_plugin_id,credential_id,mode,host,username,session_recording from ssh_connectors where server_id=$1", [server.id]);
    const connector = connectorResult.rows[0]; if (!connector) return error(reply, 409, "ssh_unavailable");
    if (!sessionModeCompatible(request.body.mode, connector.mode)) return error(reply, 409, "connector_mode_mismatch", `SSH is configured as ${connector.mode}; ${request.body.mode} is unavailable.`);
    const created = await options.db.query<{ id: string }>(`insert into host_sessions(server_id,server_plugin_id,actor_user_id,credential_id,mode,host,username,reason,source_ip,client_metadata,recording_enabled)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) returning id`, [server.id,connector.server_plugin_id,user.id,connector.credential_id,request.body.mode,connector.host,connector.username,request.body.reason ?? null,request.ip,JSON.stringify({ user_agent: request.headers["user-agent"] }),connector.session_recording]);
    await options.db.query("insert into jobs(kind,server_id,payload) values('host.session',$1,jsonb_build_object('session_id',$2::text))", [server.id,created.rows[0]!.id]);
    await auditFromRequest(options.db,request,{eventType:"host_session_start",status:"success",actorUserId:user.id,serverId:server.id,toolName:tool,input:{mode:request.body.mode,host:connector.host,username:connector.username},...(request.body.reason?{reason:request.body.reason}:{}),sessionId:created.rows[0]!.id,executorKind:"host_session"});
    return { session_id: created.rows[0]!.id, status: "starting" };
  });

  server.get("/me/host-sessions", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const result = await options.db.query("select id,server_id,mode,host,username,status,reason,started_at,last_activity_at,ended_at from host_sessions where actor_user_id=$1 order by started_at desc limit 100", [actor.id]);
    return { sessions: result.rows };
  });

  server.post<{ Params: { id: string } }>("/me/host-sessions/:id/end", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const result = await options.db.query("update host_sessions set status='ended',ended_at=now() where id=$1 and actor_user_id=$2 and status in ('starting','active','disconnected') returning id,status", [request.params.id,actor.id]);
    if (!result.rows[0]) return error(reply,404,"session_not_found"); return { session: result.rows[0] };
  });

  server.post<{ Params: { id: string }; Body: { data_base64?: string } }>("/me/host-sessions/:id/input", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const owned = await options.db.query("select recording_enabled from host_sessions where id=$1 and actor_user_id=$2 and status='active'", [request.params.id,actor.id]);
    if (!owned.rows[0] || !request.body.data_base64) return error(reply,409,"session_not_active");
    const bytes = Buffer.from(request.body.data_base64,"base64"); if (bytes.length > 65536) return error(reply,413,"input_too_large");
    await options.db.query("insert into host_session_stream(session_id,direction,content) values($1,'input',$2)",[request.params.id,bytes]);
    return { accepted: bytes.length };
  });

  server.get<{ Params: { id: string }; Querystring: { after?: string } }>("/me/host-sessions/:id/output", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply); if (!actor) return;
    const owned = await options.db.query("select status,recording_failed,recording_truncated from host_sessions where id=$1 and actor_user_id=$2",[request.params.id,actor.id]);
    if (!owned.rows[0]) return error(reply,404,"session_not_found");
    const after = Number.parseInt(request.query.after ?? "0",10) || 0;
    const events = await options.db.query<{ id: string; content_base64: string; created_at: string }>("select id,encode(content,'base64') content_base64,created_at from host_session_stream where session_id=$1 and direction in ('output','system') and id>$2 order by id limit 500",[request.params.id,after]);
    return { session: owned.rows[0], events: events.rows };
  });

  server.post<{ Params: { id: string } }>("/admin/servers/:id/test-connection", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    return error(reply, 409, "plugin_instance_required", "Test a connection from the server's Plugins tab.");
  });

  server.get<{ Params: { id: string } }>("/admin/servers/:id/capabilities", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const result = await options.db.query(
      `select sc.capability, sc.status, sc.executor_kind, sc.credential_id, sc.details, sc.discovered_at,
              sc.expires_at, sc.error_code, sc.error_message, sp.plugin_key, sp.instance_name,
              (expires_at is not null and expires_at < now()) as stale
       from server_capabilities sc join server_plugins sp on sp.id=sc.server_plugin_id
       where sp.server_id = $1 order by sp.instance_name, sc.capability`,
      [request.params.id]
    );
    return { capabilities: result.rows };
  });

  server.post<{ Params: { id: string } }>("/admin/servers/:id/refresh-capabilities", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManageServer(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const result = await options.db.query(
      `insert into jobs (kind, status, server_id, payload, run_after)
       values ('server.capability_refresh','queued',$1,$2::jsonb,now())
       returning *`,
      [request.params.id, JSON.stringify({ requested_by: actor.id })]
    );
    await auditFromRequest(options.db, request, {
      eventType: "server_capability_refresh_queued",
      actorUserId: actor.id,
      serverId: request.params.id,
      status: "success",
      input: { server_id: request.params.id }
    });
    return { job: result.rows[0] };
  });

  server.post("/admin/servers/bulk-test-connections", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (actor.role !== "global_admin") return error(reply, 403, "global_admin_required");
    const result = await options.db.query(
      `insert into jobs (kind, status, payload, run_after)
       values ('server.bulk_connection_test','queued',$1::jsonb,now())
       returning *`,
      [JSON.stringify({ requested_by: actor.id })]
    );
    await auditFromRequest(options.db, request, {
      eventType: "bulk_connection_test_queued",
      actorUserId: actor.id,
      status: "success",
      input: {}
    });
    return { job: result.rows[0] };
  });

  server.get("/admin/tokens", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const result = await options.db.query(
      `select t.id, t.user_id, u.email, t.name, t.token_prefix, t.expires_at, t.last_used_at, t.revoked_at, t.created_at
       from api_tokens t join users u on u.id = t.user_id
       where ($1::boolean or u.id in (
         with recursive scope as (
           select id from users where owner_user_id = $2
           union all select u2.id from users u2 join scope on u2.owner_user_id = scope.id
         ) select id from scope
       )) order by t.created_at desc`,
      [actor.role === "global_admin", actor.id]
    );
    return { tokens: result.rows };
  });

  server.post<{
    Body: { user_id?: string; name?: string; expires_at?: string };
  }>("/admin/tokens", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!request.body.user_id) return error(reply, 400, "validation_error", "A user is required for the token.");
    if (!(await canManageUser(options.db, actor, request.body.user_id))) return error(reply, 403, "admin_denied");
    if (!request.body.name?.trim()) return error(reply, 400, "validation_error", "A token name is required.");
    if (!request.body.expires_at) return error(reply, 400, "validation_error", "An expiration date is required.");
    const generated = generateApiToken();
    const result = await options.db.query(
      `insert into api_tokens (user_id, name, token_prefix, token_hash, expires_at)
       values ($1,$2,$3,$4,$5)
       returning id, user_id, name, token_prefix, expires_at, created_at`,
      [request.body.user_id, request.body.name, generated.prefix, generated.hash, request.body.expires_at]
    );
    await auditFromRequest(options.db, request, {
      eventType: "token_create",
      actorUserId: actor.id,
      status: "success",
      input: { user_id: request.body.user_id, name: request.body.name }
    });
    return { token: result.rows[0], secret: generated.token };
  });

  server.post<{ Params: { id: string } }>("/admin/tokens/:id/revoke", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const tokenOwner = await options.db.query<{ user_id: string }>("select user_id from api_tokens where id = $1", [request.params.id]);
    if (!tokenOwner.rows[0]) return error(reply, 404, "token_not_found");
    if (!(await canManageUser(options.db, actor, tokenOwner.rows[0].user_id))) return error(reply, 403, "admin_denied");
    await options.db.query("update api_tokens set revoked_at = now() where id = $1", [request.params.id]);
    await closeBrowserSessionsForToken(options.db, options.config, request.params.id, "token_revoked");
    await auditFromRequest(options.db, request, {
      eventType: "token_revoke",
      actorUserId: actor.id,
      status: "success",
      input: { token_id: request.params.id }
    });
    return { ok: true };
  });

  // --- Self-service /me/* routes (any active user, scoped to the actor) ---

  server.get("/me/tokens", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply);
    if (!actor) return;
    const result = await options.db.query(
      `select t.id, t.user_id, u.email, t.name, t.token_prefix, t.expires_at, t.last_used_at, t.revoked_at, t.created_at
       from api_tokens t join users u on u.id = t.user_id
       where t.user_id = $1 order by t.created_at desc`,
      [actor.id]
    );
    return { tokens: result.rows };
  });

  server.post<{ Body: { name?: string; expires_at?: string } }>("/me/tokens", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply);
    if (!actor) return;
    const name = request.body.name?.trim();
    if (!name) return error(reply, 400, "validation_error", "A token name is required.");
    if (!request.body.expires_at) return error(reply, 400, "validation_error", "An expiration date is required.");
    const generated = generateApiToken();
    const result = await options.db.query(
      `insert into api_tokens (user_id, name, token_prefix, token_hash, expires_at)
       values ($1,$2,$3,$4,$5)
       returning id, user_id, name, token_prefix, expires_at, created_at`,
      [actor.id, name, generated.prefix, generated.hash, request.body.expires_at]
    );
    await auditFromRequest(options.db, request, {
      eventType: "token_create",
      actorUserId: actor.id,
      status: "success",
      input: { user_id: actor.id, name }
    });
    return { token: result.rows[0], secret: generated.token };
  });

  server.post<{ Params: { id: string } }>("/me/tokens/:id/revoke", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply);
    if (!actor) return;
    const owned = await options.db.query("select 1 from api_tokens where id = $1 and user_id = $2", [request.params.id, actor.id]);
    if (!owned.rowCount) return error(reply, 403, "not_owner");
    await options.db.query("update api_tokens set revoked_at = now() where id = $1", [request.params.id]);
    await closeBrowserSessionsForToken(options.db, options.config, request.params.id, "token_revoked");
    await auditFromRequest(options.db, request, {
      eventType: "token_revoke",
      actorUserId: actor.id,
      status: "success",
      input: { token_id: request.params.id }
    });
    return { ok: true };
  });

  server.get("/me/activity", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply);
    if (!actor) return;
    const [events, loginRow, activeTokens, recentCalls] = await Promise.all([
      options.db.query(
        `select id, request_id, event_type, actor_user_id, actor_token_id, server_id, tool_name, status,
                input_summary, error_code, duration_ms, client_ip, user_agent, created_at
         from audit_events where actor_user_id = $1 order by created_at desc limit 50`,
        [actor.id]
      ),
      options.db.query<{ last_login_at: string | null }>("select last_login_at from users where id = $1", [actor.id]),
      scalar(options.db, "select count(*)::int as count from api_tokens where user_id = $1 and revoked_at is null", [actor.id]),
      scalar(options.db, "select count(*)::int as count from audit_events where actor_user_id = $1 and event_type = 'mcp_tool_call' and created_at > now() - interval '7 days'", [actor.id])
    ]);
    return {
      events: events.rows ?? [],
      last_login_at: loginRow.rows[0]?.last_login_at ?? null,
      active_tokens: activeTokens,
      recent_calls: recentCalls
    };
  });

  server.patch<{ Body: { display_name?: string; email?: string } }>("/me/profile", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply);
    if (!actor) return;
    const displayName = request.body.display_name?.trim();
    const email = request.body.email?.trim().toLowerCase();
    if (!displayName || !email) return error(reply, 400, "validation_error");
    const taken = await options.db.query("select id from users where email = $1 and id <> $2", [email, actor.id]);
    if (taken.rowCount) return error(reply, 409, "email_taken", "That email is already in use.");
    const before = await options.db.query("select email, display_name from users where id = $1", [actor.id]);
    const result = await options.db.query<AdminUser>(
      `update users set display_name = $2, email = $3, updated_at = now()
       where id = $1
       returning id, owner_user_id, email, display_name, role, status, password_change_required`,
      [actor.id, displayName, email]
    );
    await auditFromRequest(options.db, request, {
      eventType: "user_update",
      actorUserId: actor.id,
      status: "success",
      input: { user_id: actor.id, before: before.rows[0], after: { email, display_name: displayName } }
    });
    return { user: publicUser(result.rows[0]!) };
  });

  // Organization defaults the Client Setup page needs, readable by any active
  // user (regular users reach Client Setup too). Global admins edit them below.
  server.get("/me/broker-config", async (request, reply) => {
    const actor = await requireUser(options.db, request, reply);
    if (!actor) return;
    return { default_mcp_server_name: await defaultMcpServerName(options.db) };
  });

  server.put<{ Body: { default_mcp_server_name?: string } }>("/admin/broker-defaults", async (request, reply) => {
    const actor = await requireGlobalAdmin(options.db, request, reply);
    if (!actor) return;
    const name = request.body.default_mcp_server_name?.trim();
    if (!name || !MCP_SERVER_NAME_PATTERN.test(name)) {
      return error(reply, 400, "validation_error", "Server name must be 1-64 characters: letters, digits, hyphen, or underscore, starting with a letter or digit.");
    }
    const before = await defaultMcpServerName(options.db);
    await options.db.query(
      `insert into app_settings (key, value, updated_by, updated_at)
       values ('default_mcp_server_name', $1, $2, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [name, actor.id]
    );
    await auditFromRequest(options.db, request, {
      eventType: "broker_defaults_update",
      actorUserId: actor.id,
      status: "success",
      input: { before: { default_mcp_server_name: before }, after: { default_mcp_server_name: name } }
    });
    return { default_mcp_server_name: name };
  });

  server.get("/admin/tools", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const result = await options.db.query(
      `select name, version, category, is_write, plugin_key,
              domain, action, risk, reversible, executor_kind, credential_kinds,
              supports_dry_run, is_long_running, description, constraints_schema, reviewed, updated_at
       from tool_definitions where is_enabled = true order by domain, action, name`
    );
    // Catalog version: max(updated_at) + row count. Any metadata edit or new tool changes
    // it, giving the UI a cheap staleness check and audit context.
    const version = await options.db.query<{ version: string }>(
      "select coalesce(extract(epoch from max(updated_at))::bigint, 0) || ':' || count(*)::text as version from tool_definitions where is_enabled = true"
    );
    return {
      tools: result.rows,
      catalog_version: version.rows[0]?.version ?? "0:0",
      domains: TOOL_DOMAINS,
      actions: TOOL_ACTIONS
    };
  });

  // The unreviewed-tools queue: tools that appeared after access was configured and have
  // not been acknowledged by an administrator. New tools are always ungranted regardless;
  // this surface simply makes them visible for review.
  server.get("/admin/tools/unreviewed", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const result = await options.db.query(
      `select name, domain, action, risk, description, created_at
       from tool_definitions where is_enabled = true and reviewed = false order by created_at, name`
    );
    return { tools: result.rows };
  });

  server.post<{ Body: { tool_names?: string[] } }>("/admin/tools/review", async (request, reply) => {
    const actor = await requireGlobalAdmin(options.db, request, reply);
    if (!actor) return;
    const names = Array.isArray(request.body.tool_names) ? request.body.tool_names : [];
    await options.db.query("update tool_definitions set reviewed = true where name = any($1::text[])", [names]);
    await rematerializePolicyIntents(options.db);
    await auditFromRequest(options.db, request, {
      eventType: "tools_reviewed",
      actorUserId: actor.id,
      status: "success",
      input: { tool_names: names }
    });
    return { ok: true };
  });

  server.get("/admin/policies", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const result = await options.db.query(
      `select p.id, p.name, p.description, p.built_in, p.created_by, p.created_at, p.updated_at,
              count(distinct pp.id)::int as permission_count,
              count(distinct sb.id)::int as binding_count
       from policies p
       left join policy_permissions pp on pp.policy_id = p.id
       left join server_bindings sb on sb.policy_id = p.id
       where ($1::boolean or p.built_in=true or p.created_by in (
         with recursive scope as (
           select $2::uuid as id union all select child.id from users child join scope parent on child.owner_user_id=parent.id
         ) select id from scope
       ))
       group by p.id
       order by p.built_in desc, p.name`,
      [actor.role === "global_admin", actor.id]
    );
    return { policies: result.rows };
  });

  server.post<{ Body: { name?: string; description?: string } }>("/admin/policies", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const name = request.body.name?.trim();
    if (!name) return error(reply, 400, "validation_error");
    const result = await options.db.query(
      "insert into policies (name, description, created_by) values ($1,$2,$3) returning *",
      [name, request.body.description ?? null, actor.id]
    );
    await auditFromRequest(options.db, request, {
      eventType: "policy_create",
      actorUserId: actor.id,
      status: "success",
      input: { after: result.rows[0] }
    });
    return { policy: result.rows[0] };
  });

  server.get<{ Params: { id: string } }>("/admin/policies/:id", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const policy = await options.db.query("select * from policies where id = $1", [request.params.id]);
    if (!policy.rows[0]) return error(reply, 404, "policy_not_found");
    if (!policy.rows[0].built_in && !(await canManagePolicy(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const permissions = await options.db.query(
      "select id, policy_id, tool_name, effect, constraints from policy_permissions where policy_id = $1 order by tool_name, effect",
      [request.params.id]
    );
    const bindings = await bindingsQuery(options.db, "sb.policy_id = $1", [request.params.id]);
    const intents = await options.db.query(
      `select id,policy_id,plugin_key,instance_name,mode,access_level,risk_ceiling,grants,denied_tools,constraints
       from policy_plugin_intents where policy_id=$1 order by plugin_key,instance_name nulls first`,
      [request.params.id]
    );
    return { policy: policy.rows[0], permissions: permissions.rows, intents: intents.rows, bindings };
  });

  server.put<{ Params: { id: string }; Body: { intents?: unknown[]; reason?: string } }>(
    "/admin/policies/:id/intents", async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply);
      if (!actor) return;
      if (!(await canManagePolicy(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
      const rawIntents = Array.isArray(request.body.intents) ? request.body.intents : [];
      let intents: PolicyPluginIntent[];
      try {
        intents = rawIntents.map(normalizePolicyIntent);
      } catch (err) {
        return error(reply, 400, "validation_error", err instanceof Error ? err.message : undefined);
      }
      const scopes = new Set(intents.map((intent) => `${intent.pluginKey}\0${intent.instanceName ?? ""}`));
      if (scopes.size !== intents.length) return error(reply, 400, "validation_error", "Only one intent is allowed per plugin and instance name.");
      if (intents.some(intentNeedsFullConfirmation) && !request.body.reason?.trim()) {
        return error(reply, 400, "reason_required", "Selecting Full access requires an audit reason.");
      }
      const before = await options.db.query("select * from policy_plugin_intents where policy_id=$1", [request.params.id]);
      await replacePolicyIntents(options.db, request.params.id, intents);
      await auditFromRequest(options.db, request, {
        eventType: intents.some(intentNeedsFullConfirmation) ? "policy_full_access_grant" : "policy_intents_replace",
        actorUserId: actor.id,
        status: "success",
        ...(request.body.reason?.trim() ? { reason: request.body.reason.trim() } : {}),
        input: { policy_id: request.params.id, before: before.rows, after: intents }
      });
      return { ok: true };
    }
  );

  server.patch<{ Params: { id: string }; Body: { name?: string; description?: string } }>("/admin/policies/:id", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManagePolicy(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const before = await options.db.query("select * from policies where id = $1", [request.params.id]);
    if (!before.rows[0]) return error(reply, 404, "policy_not_found");
    const result = await options.db.query(
      `update policies set
         name = coalesce($2, name),
         description = coalesce($3, description),
         updated_at = now()
       where id = $1 returning *`,
      [request.params.id, request.body.name?.trim() || null, request.body.description ?? null]
    );
    await auditFromRequest(options.db, request, {
      eventType: "policy_update",
      actorUserId: actor.id,
      status: "success",
      input: { policy_id: request.params.id, before: before.rows[0], after: result.rows[0] }
    });
    return { policy: result.rows[0] };
  });

  server.delete<{ Params: { id: string }; Body: { reason?: string } }>("/admin/policies/:id", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManagePolicy(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    if (!request.body.reason?.trim()) return error(reply, 400, "reason_required");
    const before = await options.db.query<{ built_in: boolean }>("select * from policies where id = $1", [request.params.id]);
    if (!before.rows[0]) return error(reply, 404, "policy_not_found");
    if (before.rows[0].built_in) return error(reply, 400, "built_in_policy");
    const references = await scalar(options.db, "select count(*)::int as count from server_bindings where policy_id = $1", [request.params.id]);
    if (references > 0) return error(reply, 409, "policy_in_use");
    await options.db.query("delete from policies where id = $1", [request.params.id]);
    await auditFromRequest(options.db, request, {
      eventType: "policy_delete",
      actorUserId: actor.id,
      status: "success",
      reason: request.body.reason.trim(),
      input: { policy_id: request.params.id, before: before.rows[0] }
    });
    return { ok: true };
  });

  server.put<{ Params: { id: string }; Body: { permissions?: Array<{ tool_name?: string; effect?: string; constraints?: unknown }>; reason?: string } }>("/admin/policies/:id/permissions", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!(await canManagePolicy(options.db, actor, request.params.id))) return error(reply, 403, "admin_denied");
    const permissions = request.body.permissions ?? [];
    if (!Array.isArray(permissions)) return error(reply, 400, "validation_error");
    const policy = await options.db.query("select * from policies where id = $1", [request.params.id]);
    if (!policy.rows[0]) return error(reply, 404, "policy_not_found");
    const known = await options.db.query<{ name: string }>("select name from tool_definitions where is_enabled = true");
    const knownTools = new Set(known.rows.map((row) => row.name));
    const normalized: Array<{ toolName: string; effect: "allow" | "deny"; constraints: Record<string, unknown> }> = [];
    for (const permission of permissions) {
      if (!knownTools.has(permission.tool_name ?? "") || !["allow", "deny"].includes(permission.effect ?? "")) {
        return error(reply, 400, "validation_error");
      }
      try {
        normalized.push({
          toolName: permission.tool_name!,
          effect: permission.effect as "allow" | "deny",
          constraints: validateConstraints(permission.tool_name!, permission.constraints ?? {})
        });
      } catch (err) {
        return error(reply, 400, "invalid_constraints", err instanceof Error ? err.message : undefined);
      }
    }
    const before = await options.db.query("select * from policy_permissions where policy_id = $1", [request.params.id]);
    const client = await options.db.connect();
    try {
      await client.query("begin");
      await client.query("delete from policy_permissions where policy_id = $1", [request.params.id]);
      for (const permission of normalized) {
        await client.query(
          `insert into policy_permissions (policy_id, tool_name, effect, constraints)
           values ($1,$2,$3,$4::jsonb)`,
          [request.params.id, permission.toolName, permission.effect, JSON.stringify(permission.constraints)]
        );
      }
      await client.query("update policies set updated_at = now() where id = $1", [request.params.id]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await auditFromRequest(options.db, request, {
      eventType: "policy_permissions_replace",
      actorUserId: actor.id,
      status: "success",
      input: { policy_id: request.params.id, before: before.rows, after: normalized },
      ...(request.body.reason?.trim() ? { reason: request.body.reason.trim() } : {})
    });
    return { ok: true };
  });

  server.get<{ Querystring: { server_id?: string; subject_id?: string } }>("/admin/bindings", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const filters: string[] = [];
    const params: unknown[] = [];
    if (request.query.server_id) {
      params.push(request.query.server_id);
      filters.push(`sb.server_id = $${params.length}`);
    }
    if (request.query.subject_id) {
      params.push(request.query.subject_id);
      filters.push(`sb.subject_id = $${params.length}`);
    }
    return { bindings: await bindingsQuery(options.db, filters.join(" and "), params) };
  });

  server.post<{
    Body: { subject_type?: string; subject_id?: string; server_id?: string; policy_id?: string; constraints?: unknown; reason?: string };
  }>("/admin/bindings", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    if (!["user", "group"].includes(request.body.subject_type ?? "") || !request.body.subject_id || !request.body.server_id || !request.body.policy_id) {
      return error(reply, 400, "validation_error");
    }
    if (!(await canManageBindingSubject(options.db, actor, request.body.subject_type as "user" | "group", request.body.subject_id))) {
      return error(reply, 403, "admin_denied");
    }
    if (!(await canManageServer(options.db, actor, request.body.server_id))) return error(reply, 403, "admin_denied");
    let constraints: Record<string, unknown>;
    try {
      constraints = validateBindingConstraints(request.body.constraints ?? {});
    } catch (err) {
      return error(reply, 400, "invalid_constraints", err instanceof Error ? err.message : undefined);
    }
    await upsertBinding(options.db, {
      subjectType: request.body.subject_type as "user" | "group",
      subjectId: request.body.subject_id,
      serverId: request.body.server_id,
      policyId: request.body.policy_id,
      constraints,
      createdBy: actor.id
    });
    await auditFromRequest(options.db, request, {
      eventType: "binding_upsert",
      actorUserId: actor.id,
      serverId: request.body.server_id,
      status: "success",
      input: request.body
    });
    return { ok: true };
  });

  server.delete<{ Params: { id: string }; Body: { reason?: string } }>("/admin/bindings/:id", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const before = await options.db.query("select * from server_bindings where id = $1", [request.params.id]);
    const binding = before.rows[0];
    if (!binding) return error(reply, 404, "binding_not_found");
    if (!(await canManageBindingSubject(options.db, actor, binding.subject_type, binding.subject_id))) return error(reply, 403, "admin_denied");
    await options.db.query("delete from server_bindings where id = $1", [request.params.id]);
    await auditFromRequest(options.db, request, {
      eventType: "binding_delete",
      actorUserId: actor.id,
      serverId: binding.server_id,
      status: "success",
      input: { binding_id: request.params.id, before: binding, reason: request.body?.reason ?? null }
    });
    return { ok: true };
  });

  server.get<{
    Querystring: { user_id?: string; server_id?: string; tool_name?: string };
  }>("/admin/policy/effective", async (request, reply) => {
    if (!request.query.user_id || !request.query.server_id || !request.query.tool_name) {
      return error(reply, 400, "validation_error");
    }
    const actor = await actorForUser(options.db, request.query.user_id);
    if (!actor) return error(reply, 404, "user_not_found");
    const server = await getServer(options.db, request.query.server_id);
    if (!server) return error(reply, 404, "server_not_found");
    const toolName = request.query.tool_name;
    const decision = await evaluateAccess(options.db, actor, server, toolName, isWriteTool(toolName), {});
    const meta = TOOL_META.get(toolName);
    const connector = await describeConnectorAvailability(options.db, server.id, meta);
    // Authorization and connector availability are reported separately (WPB-ACCESS
    // decision 9). `final` folds them into one explanation the UI can render directly:
    //   not_granted / risk_ceiling / constraint_failed / server_disabled come from policy evaluation;
    //   credential_missing / executor_unavailable come from connector state and only
    //   matter once policy already allows.
    let final: string;
    if (server.status === "disabled") final = "server_disabled";
    else if (!decision.allowed) final = decision.reason;
    else if (connector.credential_status === "missing") final = "credential_missing";
    else if (connector.executor_status === "unavailable") final = "executor_unavailable";
    else final = "allowed";
    return {
      user: { id: actor.userId, role: actor.role, group_ids: actor.groupIds },
      server: { id: server.id, status: server.status },
      tool: {
        name: toolName,
        is_write: isWriteTool(toolName),
        ...(meta
          ? { domain: meta.domain, action: meta.action, risk: meta.risk, executor_kind: meta.executorKind, credential_kinds: meta.credentialKinds }
          : {})
      },
      matched_bindings: decision.matchedBindings,
      effective_constraints: decision.effectiveConstraints,
      connector,
      final,
      decision
    };
  });

  server.get<{ Querystring: { user_id?: string; server_id?: string } }>("/admin/policy/preview", async (request, reply) => {
    const admin = await requireAdmin(options.db, request, reply);
    if (!admin) return;
    if (!request.query.user_id || !request.query.server_id) return error(reply, 400, "validation_error");
    if (!(await canManageServer(options.db, admin, request.query.server_id))) return error(reply, 403, "admin_denied");
    if (admin.role !== "global_admin" && !(await canManageUser(options.db, admin, request.query.user_id))) return error(reply, 403, "admin_denied");
    const actor = await actorForUser(options.db, request.query.user_id);
    if (!actor) return error(reply, 404, "user_not_found");
    const serverRow = await getServer(options.db, request.query.server_id);
    if (!serverRow) return error(reply, 404, "server_not_found");
    const instances = await options.db.query<{ id: string; plugin_key: string; instance_name: string }>(
      "select id,plugin_key,instance_name from server_plugins where server_id=$1 and status='enabled' order by plugin_key,instance_name",
      [serverRow.id]
    );
    const decisions: Array<Record<string, unknown>> = [];
    for (const instance of instances.rows) {
      const plugin = PLUGIN_REGISTRY.get(instance.plugin_key);
      if (!plugin) continue;
      for (const tool of plugin.tools) {
        const decision = await evaluatePolicy(options.db, {
          userId: actor.userId, role: actor.role, groupIds: actor.groupIds,
          server: { id: serverRow.id, status: serverRow.status }, toolName: tool.name,
          pluginKey: plugin.key, instanceName: instance.instance_name, toolRisk: tool.risk,
          toolDomain: tool.domain, toolAction: tool.action,
          isWrite: tool.isWrite, input: {}
        });
        decisions.push({ server_plugin_id: instance.id, instance_name: instance.instance_name,
          plugin_key: plugin.key, tool_name: tool.name, domain: tool.domain, action: tool.action,
          risk: tool.risk, allowed: decision.allowed, reason: decision.reason });
      }
    }
    return { user_id: actor.userId, server_id: serverRow.id, decisions };
  });

  server.get<{
    Querystring: { user_id?: string; server_id?: string; tool_name?: string; status?: string };
  }>("/admin/audit-events", async (request) => {
    const filters: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      filters.push(sql.replace("?", `$${params.length}`));
    };
    if (request.query.user_id) add("actor_user_id = ?", request.query.user_id);
    if (request.query.server_id) add("server_id = ?", request.query.server_id);
    if (request.query.tool_name) add("tool_name = ?", request.query.tool_name);
    if (request.query.status) add("status = ?", request.query.status);
    const where = filters.length ? `where ${filters.join(" and ")}` : "";
    const result = await options.db.query(
      `select id, request_id, event_type, actor_user_id, actor_token_id, server_id, tool_name, status,
              input_summary, error_code, duration_ms, client_ip, user_agent, created_at
       from audit_events ${where} order by created_at desc limit 200`,
      params
    );
    return { audit_events: result.rows };
  });

  server.get<{
    Querystring: { user_id?: string; server_id?: string; tool_name?: string; status?: string; format?: string };
  }>("/admin/audit-export", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const filters: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      filters.push(sql.replace("?", `$${params.length}`));
    };
    if (request.query.user_id) add("actor_user_id = ?", request.query.user_id);
    if (request.query.server_id) add("server_id = ?", request.query.server_id);
    if (request.query.tool_name) add("tool_name = ?", request.query.tool_name);
    if (request.query.status) add("status = ?", request.query.status);
    const where = filters.length ? `where ${filters.join(" and ")}` : "";
    const result = await options.db.query(
      `select id, request_id, event_type, actor_user_id, actor_token_id, server_id, tool_name, status,
              input_summary, error_code, duration_ms, client_ip, user_agent, created_at
       from audit_events ${where} order by created_at desc limit 1000`,
      params
    );
    await auditFromRequest(options.db, request, {
      eventType: "audit_export",
      actorUserId: actor.id,
      status: "success",
      input: request.query
    });
    if (request.query.format === "csv") {
      reply.type("text/csv");
      return toCsv(result.rows);
    }
    return { audit_events: result.rows };
  });

  // -------------------------------------------------------------------------
  // MCP monitor (Fix C, Phase 1). Session list → drill-down traffic log, a
  // filtered global traffic view, per-event body reveal, and streamed export.
  // All admin-only and ownership-scoped (decision C5).
  // -------------------------------------------------------------------------

  // Session list: gap-sessionized, live/most-recent first, cursor-paginated.
  server.get<{
    Querystring: {
      idle_minutes?: string;
      limit?: string;
      cursor?: string;
      tool?: string;
      status?: string;
      server_id?: string;
      from?: string;
      to?: string;
      q?: string;
    };
  }>("/admin/mcp/sessions", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const idleMinutes = clampInt(request.query.idle_minutes, MCP_DEFAULT_IDLE_MINUTES, 1, 1440);
    const rowLimit = clampInt(request.query.limit, 100, 1, 500);
    const tokenIds = await mcpScopedTokenIds(options.db, actor);

    const params: unknown[] = [];
    const p = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const idleParam = p(`${idleMinutes} minutes`);
    let scopeSql = "";
    if (tokenIds) scopeSql = ` and ae.actor_token_id = any(${p(tokenIds)}::uuid[])`;

    const having: string[] = [];
    if (request.query.tool) having.push(`bool_or(m.tool_name = ${p(request.query.tool)})`);
    if (request.query.status === "errors") having.push("count(*) filter (where m.status <> 'success') > 0");
    else if (request.query.status) having.push(`bool_or(m.status = ${p(request.query.status)})`);
    if (request.query.server_id) having.push(`bool_or(m.server_id = ${p(request.query.server_id)}::uuid)`);
    const havingSql = having.length ? `having ${having.join(" and ")}` : "";

    const outer: string[] = [];
    if (request.query.from) outer.push(`sess.last_seen >= ${p(request.query.from)}::timestamptz`);
    if (request.query.to) outer.push(`sess.started_at <= ${p(request.query.to)}::timestamptz`);
    if (request.query.q) {
      const like = p(`%${request.query.q}%`);
      outer.push(`(sess.token_prefix ilike ${like} or sess.owner_email ilike ${like} or sess.client_ip ilike ${like} or sess.user_agent ilike ${like})`);
    }
    if (request.query.cursor) outer.push(`sess.last_seen < ${p(request.query.cursor)}::timestamptz`);
    const outerSql = outer.length ? `where ${outer.join(" and ")}` : "";
    const limitParam = p(rowLimit);

    const result = await options.db.query(
      `with calls as (
         select ae.id, ae.actor_token_id, ae.client_ip, ae.user_agent, ae.server_id, ae.tool_name, ae.status,
                ae.created_at, t.name as token_name, t.token_prefix,
                u.id as owner_id, u.email as owner_email, u.display_name as owner_name,
                lag(ae.created_at) over w as prev_at
         from audit_events ae
         join api_tokens t on t.id = ae.actor_token_id
         join users u on u.id = t.user_id
         where ae.event_type = 'mcp_tool_call' and ae.actor_token_id is not null${scopeSql}
         window w as (partition by ae.actor_token_id, ae.client_ip, ae.user_agent order by ae.created_at, ae.id)
       ),
       marked as (
         select c.*, sum(case when prev_at is null or created_at - prev_at > ${idleParam}::interval then 1 else 0 end)
                       over (partition by actor_token_id, client_ip, user_agent order by created_at, id) as session_seq
         from calls c
       ),
       sess as (
         select m.actor_token_id, m.token_name, m.token_prefix, m.owner_id, m.owner_email, m.owner_name,
                m.client_ip, m.user_agent,
                min(m.created_at) as started_at, max(m.created_at) as last_seen,
                count(*)::int as calls, count(*) filter (where m.status <> 'success')::int as errors,
                count(distinct m.server_id)::int as servers,
                (array_agg(m.id order by m.created_at asc, m.id asc))[1] as anchor_event_id
         from marked m
         group by m.actor_token_id, m.token_name, m.token_prefix, m.owner_id, m.owner_email, m.owner_name,
                  m.client_ip, m.user_agent, m.session_seq
         ${havingSql}
       )
       select * from sess ${outerSql} order by sess.last_seen desc, sess.anchor_event_id desc limit ${limitParam}`,
      params
    );

    const now = Date.now();
    const sessions = (result.rows as Array<Record<string, unknown>>).map((row) => {
      const startedAt = new Date(row.started_at as string);
      const lastSeen = new Date(row.last_seen as string);
      return {
        session_id: String(row.anchor_event_id),
        token_id: row.actor_token_id,
        token_name: row.token_name,
        token_prefix: row.token_prefix,
        owner_email: row.owner_email,
        owner_name: row.owner_name,
        client_ip: row.client_ip,
        user_agent: row.user_agent,
        started_at: row.started_at,
        last_seen: row.last_seen,
        duration_ms: lastSeen.getTime() - startedAt.getTime(),
        calls: row.calls,
        errors: row.errors,
        servers: row.servers,
        state: mcpSessionState(lastSeen, idleMinutes, now)
      };
    });
    const lastSession = sessions[sessions.length - 1];
    const nextCursor = sessions.length === rowLimit && lastSession ? toIso(lastSession.last_seen) : null;
    return { sessions, next_cursor: nextCursor, idle_minutes: idleMinutes, bodies_captured: options.config.mcpCaptureBodies };
  });

  // Per-session traffic log (drill-down). Newest-first; live-tail via ?since=<iso>.
  server.get<{ Params: { id: string }; Querystring: { idle_minutes?: string; since?: string } }>(
    "/admin/mcp/sessions/:id/traffic",
    async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply);
      if (!actor) return;
      if (!isUuid(request.params.id)) return error(reply, 400, "validation_error", "Malformed session id.");
      const tokenIds = await mcpScopedTokenIds(options.db, actor);
      const idleMinutes = clampInt(request.query.idle_minutes, MCP_DEFAULT_IDLE_MINUTES, 1, 1440);
      const rows = await mcpSessionEventRows(options.db, request.params.id, idleMinutes);
      const first = rows[0];
      const last = rows[rows.length - 1];
      if (!first || !last) return error(reply, 404, "session_not_found");
      if (tokenIds && !tokenIds.includes(String(first.actor_token_id))) return error(reply, 404, "session_not_found");

      const startedAt = new Date(first.created_at as string);
      const lastSeen = new Date(last.created_at as string);
      const errors = rows.filter((row) => row.status !== "success").length;
      const serverIds = new Set(rows.map((row) => row.server_id).filter(Boolean));
      const session = {
        session_id: request.params.id,
        token_id: first.actor_token_id,
        token_prefix: first.token_prefix ?? null,
        owner_email: first.owner_email ?? null,
        client_ip: first.client_ip ?? null,
        user_agent: first.user_agent ?? null,
        transport: "rest",
        started_at: first.created_at,
        last_seen: last.created_at,
        duration_ms: lastSeen.getTime() - startedAt.getTime(),
        calls: rows.length,
        errors,
        servers: serverIds.size,
        state: mcpSessionState(lastSeen, idleMinutes)
      };

      const since = request.query.since ? new Date(request.query.since).getTime() : null;
      const visible = since == null ? rows : rows.filter((row) => new Date(row.created_at as string).getTime() > since);
      const events = visible.map((row) => mcpTrafficView(row)).reverse(); // newest-first
      return { session, events, bodies_captured: options.config.mcpCaptureBodies };
    }
  );

  // Filtered global traffic view (token, user, server, tool, status, error_code, time, free-text).
  server.get<{ Querystring: McpTrafficFilters & { limit?: string } }>(
    "/admin/mcp/traffic",
    async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply);
      if (!actor) return;
      const rowLimit = clampInt(request.query.limit, 200, 1, 500);
      const tokenIds = await mcpScopedTokenIds(options.db, actor);
      const { sql: whereSql, params } = buildTrafficWhere(request.query, tokenIds);
      const p = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };
      let tail = "";
      if (request.query.since) tail += ` and ae.created_at > ${p(request.query.since)}::timestamptz`;
      if (request.query.cursor) tail += ` and ae.created_at < ${p(request.query.cursor)}::timestamptz`;
      const limitParam = p(rowLimit);
      const result = await options.db.query(
        `${MCP_TRAFFIC_SELECT}${whereSql}${tail} order by ae.created_at desc, ae.id desc limit ${limitParam}`,
        params
      );
      const rows = result.rows as Array<Record<string, unknown>>;
      const events = rows.map((row) => mcpTrafficView(row));
      const lastRow = rows[rows.length - 1];
      const nextCursor = rows.length === rowLimit && lastRow ? toIso(lastRow.created_at) : null;
      return { events, next_cursor: nextCursor };
    }
  );

  // One event's detail, decrypting the captured body when present. The reveal is
  // itself audited (decision C6).
  server.get<{ Params: { id: string } }>("/admin/mcp/events/:id", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    const result = await options.db.query(
      `select ae.id, ae.request_id, ae.actor_user_id, ae.actor_token_id, ae.server_id, ae.tool_name, ae.status,
              ae.error_code, ae.duration_ms, ae.client_ip, ae.user_agent, ae.input_summary, ae.encrypted_payload,
              ae.created_at, t.token_prefix, t.name as token_name, u.email as owner_email, u.display_name as owner_name,
              st.name as server_name
       from audit_events ae
       join api_tokens t on t.id = ae.actor_token_id
       join users u on u.id = t.user_id
       left join servers st on st.id = ae.server_id
       where ae.id = $1 and ae.event_type = 'mcp_tool_call'`,
      [request.params.id]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return error(reply, 404, "event_not_found");
    const tokenIds = await mcpScopedTokenIds(options.db, actor);
    if (tokenIds && !tokenIds.includes(String(row.actor_token_id))) return error(reply, 404, "event_not_found");

    const body = decodeBody((row.encrypted_payload as EncryptedPayload | null) ?? null, options.config);
    await auditFromRequest(options.db, request, {
      eventType: "mcp_body_reveal",
      actorUserId: actor.id,
      ...(row.server_id ? { serverId: String(row.server_id) } : {}),
      status: "success",
      input: { event_id: row.id, tool_name: row.tool_name }
    });
    return {
      event: {
        ...mcpTrafficView(row),
        request_id: row.request_id,
        actor_user_id: row.actor_user_id,
        owner_name: row.owner_name,
        body
      }
    };
  });

  // Session export (streamed). Full bodies only when capture (C1) is on; the export
  // action is audited (decisions C6, C9).
  server.get<{ Params: { id: string }; Querystring: { format?: string; idle_minutes?: string; reason?: string } }>(
    "/admin/mcp/sessions/:id/export",
    async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply);
      if (!actor) return;
      if (!isUuid(request.params.id)) return error(reply, 400, "validation_error", "Malformed session id.");
      const tokenIds = await mcpScopedTokenIds(options.db, actor);
      const idleMinutes = clampInt(request.query.idle_minutes, MCP_DEFAULT_IDLE_MINUTES, 1, 1440);
      const rows = await mcpSessionEventRows(options.db, request.params.id, idleMinutes);
      const first = rows[0];
      const last = rows[rows.length - 1];
      if (!first || !last) return error(reply, 404, "session_not_found");
      if (tokenIds && !tokenIds.includes(String(first.actor_token_id))) return error(reply, 404, "session_not_found");

      await auditFromRequest(options.db, request, {
        eventType: "mcp_export",
        actorUserId: actor.id,
        status: "success",
        input: {
          scope: "session",
          session_id: request.params.id,
          format: request.query.format === "json" ? "json" : "ndjson",
          bodies: options.config.mcpCaptureBodies,
          ...(request.query.reason ? { reason: request.query.reason } : {})
        }
      });

      const header = {
        session_id: request.params.id,
        token_prefix: first.token_prefix ?? null,
        owner_email: first.owner_email ?? null,
        client_ip: first.client_ip ?? null,
        user_agent: first.user_agent ?? null,
        started_at: first.created_at,
        last_seen: last.created_at,
        calls: rows.length,
        errors: rows.filter((row) => row.status !== "success").length,
        bodies_captured: options.config.mcpCaptureBodies,
        exported_at: new Date().toISOString()
      };
      const filename = `mcp-session-${request.params.id.slice(0, 12)}-${new Date().toISOString().slice(0, 10)}`;
      async function* iter() {
        for (const row of rows) yield row;
      }
      await streamMcpExport(reply, request.query.format ?? "ndjson", filename, header, iter(), options.config);
    }
  );

  // Filtered traffic export (streamed), honoring the same filters as /admin/mcp/traffic.
  server.get<{ Querystring: McpTrafficFilters & { format?: string; reason?: string } }>(
    "/admin/mcp/traffic/export",
    async (request, reply) => {
      const actor = await requireAdmin(options.db, request, reply);
      if (!actor) return;
      const tokenIds = await mcpScopedTokenIds(options.db, actor);
      await auditFromRequest(options.db, request, {
        eventType: "mcp_export",
        actorUserId: actor.id,
        status: "success",
        input: {
          scope: "traffic",
          format: request.query.format === "json" ? "json" : "ndjson",
          bodies: options.config.mcpCaptureBodies,
          filters: {
            token_id: request.query.token_id ?? null,
            user_id: request.query.user_id ?? null,
            server_id: request.query.server_id ?? null,
            tool: request.query.tool ?? null,
            status: request.query.status ?? null,
            error_code: request.query.error_code ?? null,
            from: request.query.from ?? null,
            to: request.query.to ?? null,
            q: request.query.q ?? null
          },
          ...(request.query.reason ? { reason: request.query.reason } : {})
        }
      });
      const header = {
        scope: "traffic",
        bodies_captured: options.config.mcpCaptureBodies,
        exported_at: new Date().toISOString()
      };
      const filename = `mcp-traffic-${new Date().toISOString().slice(0, 10)}`;
      await streamMcpExport(
        reply,
        request.query.format ?? "ndjson",
        filename,
        request.query.format === "json" ? header : null,
        mcpTrafficExportRows(options.db, request.query, tokenIds),
        options.config
      );
    }
  );

  server.get("/admin/security/status", async (request, reply) => {
    const actor = await requireAdmin(options.db, request, reply);
    if (!actor) return;
    return {
      sso: { configured: false, mode: "planned" },
      mfa: { available: false, enforced_for_admins: false },
      key_rotation: { supported_procedure: "docs/security-operations.md" },
      dependency_scans: { command: "npm audit --workspaces or configured scanner" },
      container_scans: { command: "trivy image <image> or configured scanner" }
    };
  });

  server.get("/mcp/tools", async (request, reply) => {
    const actor = await authenticateToken(options.db, request, reply);
    if (!actor) return;
    return { tools: await listAccessibleTools(options.db, actor) };
  });

  server.get<{ Params: { id: string }; Querystring: { expires?: string; signature?: string } }>("/mcp/artifacts/:id/download", async (request, reply) => {
    const actor = await authenticateToken(options.db, request, reply); if (!actor) return;
    const expires = Number(request.query.expires), signature = request.query.signature ?? "";
    if (!Number.isInteger(expires) || expires < Date.now() || expires > Date.now() + 5 * 60_000
      || !validArtifactDownloadSignature(options.config, request.params.id, actor.tokenId, expires, signature)) {
      return error(reply, 404, "artifact_not_found");
    }
    try {
      const resource = await readArtifactResource(options.db, artifactStore, actor, `aibroker://artifacts/${request.params.id}`);
      artifactMetrics.reads++;
      return reply.type(resource.mimeType).send(Buffer.from(resource.data));
    } catch (err) {
      const code = err instanceof Error ? err.message : "artifact_not_found";
      return error(reply, code === "artifact_expired" ? 410 : 404, code);
    }
  });

  // The one shared tool-call pipeline (Fix B): validate → rate-limit → execute → audit
  // (+ capture). Both /mcp/call and the native SDK /mcp endpoint below run through it.
  const mcpPipeline: McpPipeline = createMcpPipeline({
    db: options.db,
    config: options.config,
    isKnownTool,
    checkRateLimit,
    executeMcpTool: (db, config, actor, tool, input) => executeMcpTool(db, config, actor, tool, input, artifactStore),
    mapToolError,
    captureMcpBody,
    writeAudit: async ({ audit, actor, tool, input, status, errorCode, durationMs, encryptedPayload, result }) => {
      // Snapshot the tool's catalog classification so audit history survives later metadata
      // revisions, and record an optional caller-supplied reason (never required).
      const meta = TOOL_META.get(tool);
      const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined;
      const safeInput = browserAuditInput(tool, input);
      const resultSessionId = isBrokerToolResult(result) && typeof result.structuredContent.session_id === "string" ? result.structuredContent.session_id : undefined;
      const pluginTarget = typeof input.server_plugin_id === "string" ? await getServerPlugin(options.db, input.server_plugin_id) : null;
      await writeAuditEvent(options.db, {
        requestId: audit.requestId,
        eventType: "mcp_tool_call",
        actorUserId: actor.userId,
        actorTokenId: actor.tokenId,
        ...(pluginTarget ? { serverId: pluginTarget.server.id } : {}),
        toolName: tool,
        status,
        input: safeInput,
        ...(errorCode ? { errorCode } : {}),
        ...(errorCode ? { errorClass: classifyError(errorCode) } : {}),
        durationMs,
        ...(encryptedPayload != null ? { encryptedPayload } : {}),
        ...(audit.clientIp ? { clientIp: audit.clientIp } : {}),
        ...(audit.userAgent ? { userAgent: audit.userAgent } : {}),
        ...(meta ? { executorKind: meta.executorKind, toolDomain: meta.domain, toolAction: meta.action, toolRisk: meta.risk } : {}),
        ...(reason ? { reason } : {}),
        ...(typeof input.session_id === "string" ? { sessionId: input.session_id } : resultSessionId ? { sessionId: resultSessionId } : {})
      });
    }
  });

  const mcpAuditContext = (request: FastifyRequest): McpAuditContext => {
    const userAgent = userAgentOf(request);
    return {
      requestId: request.id,
      clientIp: request.ip,
      ...(userAgent ? { userAgent } : {})
    };
  };

  // /mcp/call is a labeled dev/smoke/scripting convenience only — NOT the MCP protocol
  // (decision B5). Native clients use the SDK-backed /mcp endpoint registered below.
  server.post<{ Body: { tool?: string; input?: Record<string, unknown> } }>("/mcp/call", async (request, reply) => {
    const actor = await authenticateToken(options.db, request, reply);
    if (!actor) return;
    try {
      const result = await mcpPipeline.run(actor, request.body.tool, request.body.input ?? {}, mcpAuditContext(request));
      return { result: isBrokerToolResult(result) ? result.structuredContent : result };
    } catch (err) {
      if (err instanceof McpToolError) return error(reply, err.status, err.code, err.message);
      throw err;
    }
  });

  // Native, SDK-backed Streamable-HTTP MCP endpoint (Fix B). Real MCP clients (Claude Code,
  // Cursor, VS Code) connect here directly; tools/list + tools/call share the pipeline above.
  registerMcpTransport(server, {
    serverName: MCP_SERVER_NAME,
    serverVersion: MCP_SERVER_VERSION,
    pipeline: mcpPipeline,
    authenticate: (request, reply) => authenticateToken(options.db, request, reply),
    auditContext: mcpAuditContext,
    listTools: (actor) => listAccessibleTools(options.db, actor),
    readResource: async (actor, uri) => {
      const resource = await readArtifactResource(options.db, artifactStore, actor, uri);
      artifactMetrics.reads++;
      return resource;
    }
  });

  return server;
}

async function bindingsQuery(db: pg.Pool, whereSql: string, params: unknown[]) {
  const where = whereSql ? `where ${whereSql}` : "";
  const result = await db.query(
    `select sb.id, sb.subject_type, sb.subject_id, sb.server_id, sb.policy_id, sb.constraints, sb.created_at, sb.updated_at,
            s.name as server_name,
            p.name as policy_name,
            p.built_in as policy_built_in,
            case when sb.subject_type = 'group' then g.name else u.display_name end as subject_name,
            u.email as subject_email
     from server_bindings sb
     join servers s on s.id = sb.server_id
     join policies p on p.id = sb.policy_id
     left join groups g on g.id = sb.subject_id and sb.subject_type = 'group'
     left join users u on u.id = sb.subject_id and sb.subject_type = 'user'
     ${where}
     order by s.name, sb.subject_type, subject_name`,
    params
  );
  return result.rows;
}

async function upsertBinding(
  db: pg.Pool,
  binding: {
    subjectType: "user" | "group";
    subjectId: string;
    serverId: string;
    policyId: string;
    constraints?: unknown;
    createdBy: string;
  }
): Promise<void> {
  const constraints = validateBindingConstraints(binding.constraints ?? {});
  await db.query(
    `insert into server_bindings (subject_type, subject_id, server_id, policy_id, constraints, created_by)
     values ($1,$2,$3,$4,$5::jsonb,$6)
     on conflict (subject_type, subject_id, server_id) do update set
       policy_id = excluded.policy_id,
       constraints = excluded.constraints,
       updated_at = now()`,
    [
      binding.subjectType,
      binding.subjectId,
      binding.serverId,
      binding.policyId,
      JSON.stringify(constraints),
      binding.createdBy
    ]
  );
}

async function executeMcpTool(
  db: pg.Pool,
  config: AIBrokerConfig,
  actor: TokenActor,
  toolName: string,
  input: Record<string, unknown>,
  artifactStore: ArtifactStore
): Promise<unknown> {
  const resolved = PLUGIN_REGISTRY.resolveTool(toolName);
  if (!resolved) throw toolError("validation_error", 400, "Unknown plugin tool");
  if (toolName === "wordpress.list_sites") return executeWordPressTool(db, config, actor, toolName, input, null);
  const serverPluginId = stringField(input, "server_plugin_id");
  const target = await getServerPlugin(db, serverPluginId);
  if (!target) throw toolError("server_plugin_not_found", 404);
  if (target.pluginKey !== resolved.plugin.key) throw toolError("plugin_tool_mismatch", 400);
  if (target.status !== "enabled") throw toolError("server_plugin_disabled", 403);
  if (target.server.status !== "active") throw toolError("server_disabled", 403);
  return resolved.plugin.execute(resolved.tool, input, {
    ...target,
    actorUserId: actor.userId,
    actorTokenId: actor.tokenId,
    ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
    services: { executors: { wordpress: (name: string, pluginInput: Record<string, unknown>) =>
      executeWordPressTool(db, config, actor, name, pluginInput, target),
      ssh: (name: string, pluginInput: Record<string, unknown>) =>
        executeSshTool(db, actor, name, pluginInput, target),
      postgres: (name: string, pluginInput: Record<string, unknown>) =>
        executePostgresTool(db, config, actor, name, pluginInput, target),
      playwright: (name: string, pluginInput: Record<string, unknown>) =>
        executePlaywrightTool(db, config, actor, name, pluginInput, target, artifactStore) } }
  });
}

function createArtifactStore(config: AIBrokerConfig): ArtifactStore {
  if (config.artifactBackend === "filesystem") {
    if (config.nodeEnv === "production" && !config.allowFilesystemArtifacts) throw new Error("Production requires S3 artifact storage");
    return new FilesystemArtifactStore(config.artifactFilesystemRoot);
  }
  if (!config.artifactS3Endpoint || !config.artifactS3Region || !config.artifactS3Bucket || !config.artifactS3AccessKeyId || !config.artifactS3SecretAccessKey) {
    throw new Error("S3 artifact storage configuration is incomplete");
  }
  return new S3ArtifactStore({ endpoint: config.artifactS3Endpoint, region: config.artifactS3Region,
    bucket: config.artifactS3Bucket, accessKeyId: config.artifactS3AccessKeyId, secretAccessKey: config.artifactS3SecretAccessKey });
}

function validatePlaywrightEnvironment(pluginConfig: Record<string, unknown>, server: { address: string }, config: AIBrokerConfig): void {
  const configured = [String(pluginConfig.base_url), ...(Array.isArray(pluginConfig.allowed_origins) ? pluginConfig.allowed_origins.map(String) : [])];
  for (const value of configured) {
    const url = new URL(value);
    if (url.protocol === "http:" && (!config.browserAllowPrivateTargets || url.hostname !== server.address)) {
      throw new Error("HTTP browser targets are allowed only for an explicitly registered local target when private browser targets are enabled");
    }
  }
}

async function cleanupExpiredArtifacts(db: pg.Pool, store: ArtifactStore): Promise<void> {
  const rows = await db.query<{ id: string; storage_key: string; server_id: string; server_plugin_id: string }>(
    `update browser_artifacts set status='deleting' where id in (
       select id from browser_artifacts where status in ('available','failed') and expires_at<=now() order by expires_at limit 50 for update skip locked
     ) returning id,storage_key,server_id,server_plugin_id`
  ).catch(() => ({ rows: [] as Array<{ id: string; storage_key: string; server_id: string; server_plugin_id: string }> }));
  for (const row of rows.rows) {
    try { await store.delete(row.storage_key); await db.query("update browser_artifacts set status='deleted',deleted_at=now(),cleanup_error=null where id=$1", [row.id]); }
    catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "cleanup_failed";
      await db.query("update browser_artifacts set status='failed',cleanup_error=$2 where id=$1", [row.id, message]);
      await writeAuditEvent(db, { requestId: `artifact-cleanup:${randomUUID()}`, eventType: "browser_artifact_cleanup",
        serverId: row.server_id, status: "failure", errorCode: "artifact_cleanup_failed",
        input: { artifact_id: row.id, server_plugin_id: row.server_plugin_id }, executorKind: "browser",
        toolDomain: "browser_artifacts", toolAction: "remove", toolRisk: "low" }).catch(() => undefined);
    }
  }
}

async function reconcileBrowserSessions(db: pg.Pool, config: AIBrokerConfig): Promise<void> {
  let workerLeases: Array<{ worker_lease_id: string }>;
  try {
    const listed = await browserRpc(config, {}, "/v1/sessions/list");
    workerLeases = Array.isArray(listed.leases) ? listed.leases.filter((item): item is { worker_lease_id: string } =>
      Boolean(item && typeof item === "object" && typeof (item as { worker_lease_id?: unknown }).worker_lease_id === "string")) : [];
  } catch { return; }
  const invalid = await db.query<{ id: string; worker_lease_id: string; server_id: string; expired: boolean }>(
    `select ls.id,ls.worker_lease_id,ls.server_id,(ls.idle_expires_at<=now() or ls.absolute_expires_at<=now()) as expired
     from leased_sessions ls
     left join api_tokens t on t.id=ls.actor_token_id
     join server_plugins sp on sp.id=ls.server_plugin_id
     join servers s on s.id=ls.server_id
     where ls.status in ('opening','active','closing') and
       (ls.idle_expires_at<=now() or ls.absolute_expires_at<=now() or ls.actor_token_id is null or t.revoked_at is not null or t.expires_at<=now()
        or sp.status<>'enabled' or s.status<>'active')`
  );
  for (const row of invalid.rows) {
    await browserRpc(config, { worker_lease_id: row.worker_lease_id }, "/v1/sessions/close").catch(() => undefined);
    await db.query(`update leased_sessions set status=$2,closed_at=now(),close_code=$3,version=version+1
      where id=$1 and status in ('opening','active','closing')`, [row.id, row.expired ? "expired" : "closed", row.expired ? "lease_expired" : "authority_revoked"]);
    await auditBrowserSessionLifecycle(db, row.id, row.server_id, row.expired ? "lease_expired" : "authority_revoked", "success");
  }
  const authorized = await db.query<{ id: string; worker_lease_id: string; server_plugin_id: string; actor_user_id: string; actor_token_id: string; role: string; user_status: string }>(
    `select ls.id,ls.worker_lease_id,ls.server_plugin_id,ls.actor_user_id,ls.actor_token_id,u.role,u.status as user_status
     from leased_sessions ls join users u on u.id=ls.actor_user_id where ls.status in ('opening','active','closing')`
  );
  for (const row of authorized.rows) {
    const target = await getServerPlugin(db, row.server_plugin_id); if (!target) continue;
    const groups = await db.query<{ group_id: string }>("select group_id from group_memberships where user_id=$1", [row.actor_user_id]);
    const actor: TokenActor = { tokenId: row.actor_token_id, userId: row.actor_user_id, role: row.role, status: row.user_status, groupIds: groups.rows.map((item) => item.group_id) };
    const decision = await evaluateAccess(db, actor, target.server, "playwright.open_session", false, { server_plugin_id: target.id }, target);
    if (!decision.allowed || actor.status !== "active") {
      await browserRpc(config, { worker_lease_id: row.worker_lease_id }, "/v1/sessions/close").catch(() => undefined);
      await db.query("update leased_sessions set status='closed',closed_at=now(),close_code='authorization_revoked',version=version+1 where id=$1 and status in ('opening','active','closing')", [row.id]);
      await auditBrowserSessionLifecycle(db, row.id, target.server.id, "authorization_revoked", "success");
    }
  }
  const active = await db.query<{ id: string; worker_lease_id: string; server_id: string; status: string; created_at: string }>("select id,worker_lease_id,server_id,status,created_at from leased_sessions where status in ('opening','active','closing')");
  const activeByLease = new Map(active.rows.map((row) => [row.worker_lease_id, row.id])), workerSet = new Set(workerLeases.map((row) => row.worker_lease_id));
  for (const lease of workerLeases) if (!activeByLease.has(lease.worker_lease_id)) {
    await browserRpc(config, { worker_lease_id: lease.worker_lease_id }, "/v1/sessions/close").catch(() => undefined);
  }
  for (const row of active.rows) if (!workerSet.has(row.worker_lease_id)
    && (row.status !== "opening" || new Date(row.created_at).getTime() < Date.now() - 30_000)) {
    await db.query(`update leased_sessions set status='failed',closed_at=now(),error_code='browser_session_lost',version=version+1
      where id=$1 and status in ('opening','active','closing')`, [row.id]);
    await auditBrowserSessionLifecycle(db, row.id, row.server_id, "browser_session_lost", "failure");
  }
}

async function auditBrowserSessionLifecycle(db: pg.Pool, sessionId: string, serverId: string, code: string, status: "success" | "failure"): Promise<void> {
  await writeAuditEvent(db, { requestId: `browser-session:${randomUUID()}`, eventType: "browser_session_reconcile", serverId,
    sessionId, status, ...(status === "failure" ? { errorCode: code } : {}), input: { session_id: sessionId, close_code: code },
    executorKind: "browser", toolDomain: "browser_inspection", toolAction: "operate", toolRisk: "medium" }).catch(() => undefined);
}

async function closeBrowserSessionsForPlugin(db: pg.Pool, config: AIBrokerConfig, serverPluginId: string, closeCode: string): Promise<void> {
  const active = await db.query<{ id: string; worker_lease_id: string }>(
    "select id,worker_lease_id from leased_sessions where server_plugin_id=$1 and status in ('opening','active','closing')", [serverPluginId]
  );
  for (const session of active.rows) await browserRpc(config, { worker_lease_id: session.worker_lease_id }, "/v1/sessions/close").catch(() => undefined);
  await db.query(`update leased_sessions set status='closed',closed_at=now(),close_code=$2,version=version+1
    where server_plugin_id=$1 and status in ('opening','active','closing')`, [serverPluginId, closeCode]);
}

async function closeBrowserSessionsForToken(db: pg.Pool, config: AIBrokerConfig, tokenId: string, closeCode: string): Promise<void> {
  const active = await db.query<{ id: string; worker_lease_id: string }>(
    "select id,worker_lease_id from leased_sessions where actor_token_id=$1 and status in ('opening','active','closing')", [tokenId]
  );
  for (const session of active.rows) await browserRpc(config, { worker_lease_id: session.worker_lease_id }, "/v1/sessions/close").catch(() => undefined);
  await db.query(`update leased_sessions set status='closed',closed_at=now(),close_code=$2,version=version+1
    where actor_token_id=$1 and status in ('opening','active','closing')`, [tokenId, closeCode]);
}

// Store (replace) a Playwright instance's authenticated browser state. Used by both the
// pasted-JSON credential form and the live browser capture.
async function storeBrowserStorageState(db: pg.Pool, config: AIBrokerConfig, target: ServerPluginTarget, raw: unknown): Promise<Record<string, unknown>> {
  try { assertAuthenticatedBrowserScope(target.config); }
  catch (err) { throw toolError("validation_error", 400, err instanceof Error ? err.message : "Invalid browser scope"); }
  const state = validateBrowserStorageState(filterStorageState(raw, target), target);
  const secret = { version: 1, allowedOrigins: target.config.allowed_origins, storageState: state };
  const encrypted = encryptJson(secret, loadEncryptionKey(config.encryptionKeyBase64));
  await db.query("update server_credentials set status='replaced',replaced_at=now() where server_plugin_id=$1 and kind='browser_storage_state' and status='active'", [target.id]);
  const credential = await db.query(
    `insert into server_credentials(server_plugin_id,kind,encrypted_payload) values($1,'browser_storage_state',$2::jsonb)
     returning id,server_plugin_id,kind,status,created_at`, [target.id, JSON.stringify(encrypted)]);
  await closeBrowserSessionsForPlugin(db, config, target.id, "credential_replaced");
  return credential.rows[0] as Record<string, unknown>;
}

// A live capture also collects cookies from CAPTCHA providers and other embedded origins;
// keep only what belongs to the instance's allowed origins.
function filterStorageState(raw: unknown, target: ServerPluginTarget): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const state = raw as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) return raw;
  const allowed = new Set((target.config.allowed_origins as unknown[]).map(String));
  const hosts = new Set([...allowed].map((origin) => new URL(origin).hostname));
  return {
    cookies: state.cookies.filter((cookie) => typeof (cookie as { domain?: unknown })?.domain === "string" && hosts.has(String((cookie as { domain: string }).domain).replace(/^\./, ""))),
    origins: state.origins.filter((origin) => { try { return allowed.has(new URL(String((origin as { origin?: unknown })?.origin)).origin); } catch { return false; } })
  };
}

// Browser settings for a live login capture of a site.
function captureBrowserDefaults(config: AIBrokerConfig, baseUrl: string, target: ServerPluginTarget) {
  const hostname = new URL(baseUrl).hostname;
  const allowPrivate = config.browserAllowPrivateTargets && (hostname === target.server.address
    || ["local", "throwaway"].includes(String(target.server.metadata.environment ?? "")));
  return {
    allow_private: allowPrivate, ...(allowPrivate ? { private_hostname: hostname } : {}),
    viewport: { width: 1280, height: 800 }, locale: "en-US", timezone: "UTC", color_scheme: "light" as const
  };
}

function validateBrowserStorageState(value: unknown, target: ServerPluginTarget): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw toolError("validation_error", 400, "Storage state must be an object.");
  const encoded = JSON.stringify(value); if (Buffer.byteLength(encoded) > 256 * 1024) throw toolError("validation_error", 400, "Storage state is too large.");
  const state = value as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins) || state.cookies.length > 200 || state.origins.length > 50) throw toolError("validation_error", 400, "Storage state must contain bounded cookies and origins arrays.");
  const allowed = new Set((target.config.allowed_origins as unknown[]).map(String));
  const hosts = new Set([...allowed].map((origin) => new URL(origin).hostname));
  for (const raw of state.cookies) {
    if (!raw || typeof raw !== "object" || typeof (raw as { domain?: unknown }).domain !== "string" || !hosts.has((raw as { domain: string }).domain.replace(/^\./, ""))) {
      throw toolError("browser_destination_denied", 403, "Cookie domain is outside the configured origins.");
    }
  }
  for (const raw of state.origins) {
    if (!raw || typeof raw !== "object" || typeof (raw as { origin?: unknown }).origin !== "string" || !allowed.has(new URL((raw as { origin: string }).origin).origin)) {
      throw toolError("browser_destination_denied", 403, "Storage origin is outside the configured origins.");
    }
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}

async function probePlaywrightCapabilities(db: pg.Pool, config: AIBrokerConfig, target: ServerPluginTarget, store: ArtifactStore) {
  const records: Array<{ capability: string; status: "available" | "unavailable"; executorKind: string; details?: Record<string, unknown>; errorCode?: string; errorMessage?: string }> = [];
  let runtime = false;
  try {
    const response = await fetch(new URL("/health/ready", config.browserWorkerUrl), { signal: AbortSignal.timeout(5000) });
    runtime = response.ok; const details = response.ok ? await response.json().catch(() => ({})) as Record<string, unknown> : {};
    records.push({ capability: "browser_runtime_available", status: response.ok ? "available" : "unavailable", executorKind: "browser", details });
    records.push({ capability: "chromium_launchable", status: response.ok ? "available" : "unavailable", executorKind: "browser", details });
  } catch { records.push({ capability: "browser_runtime_available", status: "unavailable", executorKind: "browser", errorCode: "browser_runtime_unavailable" }); }
  try { await store.health(); records.push({ capability: "artifact_store_available", status: "available", executorKind: "browser" }); }
  catch (error) { records.push({ capability: "artifact_store_available", status: "unavailable", executorKind: "browser", errorCode: "artifact_store_unavailable", errorMessage: error instanceof Error ? error.message : "unavailable" }); }
  if (runtime) {
    try {
      const state = await browserStorageState(db, config, target);
      const allowPrivate = allowPrivateBrowserTarget(config, target);
      const result = await browserRpc(config, { tool: "playwright.get_page_metadata", url: target.config.base_url,
        allowed_origins: target.config.allowed_origins, allowed_path_prefixes: target.config.allowed_path_prefixes ?? [],
        allow_private: allowPrivate,
        ...(allowPrivate ? { private_hostname: new URL(String(target.config.base_url)).hostname } : {}),
        viewport: { width: target.config.viewport_width, height: target.config.viewport_height }, locale: target.config.locale,
        timezone: target.config.timezone, color_scheme: target.config.color_scheme, wait_until: "load",
        ...(state ? { storage_state: state } : {}) });
      records.push({ capability: "base_origin_reachable", status: "available", executorKind: "browser", details: { final_url: result.final_url } });
      records.push({ capability: "tls_valid", status: String(target.config.base_url).startsWith("https:") ? "available" : "unavailable", executorKind: "browser" });
      if (state) records.push({ capability: "authentication_state_valid", status: "available", executorKind: "browser" });
    } catch (error) {
      records.push({ capability: "base_origin_reachable", status: "unavailable", executorKind: "browser", errorCode: mapToolError(error).code });
      if (await browserStorageState(db, config, target)) records.push({ capability: "authentication_state_valid", status: "unavailable", executorKind: "browser", errorCode: "browser_authentication_failed" });
    }
  }
  return records;
}

async function browserRpc(config: AIBrokerConfig, payload: Record<string, unknown>, path = "/v1/execute"): Promise<Record<string, unknown>> {
  const timestamp = String(Date.now()), nonce = randomUUID();
  const signature = createHmac("sha256", config.browserWorkerSecret).update(`${timestamp}.${nonce}.${JSON.stringify(payload)}`).digest("hex");
  let response: Response;
  try {
    response = await fetch(new URL(path, config.browserWorkerUrl), {
      method: "POST", headers: { "content-type": "application/json", "x-aib-timestamp": timestamp, "x-aib-nonce": nonce, "x-aib-signature": signature },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(config.browserRpcTimeoutMs)
    });
  } catch { throw toolError("browser_runtime_unavailable", 503, "The browser runtime is unavailable."); }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "browser_execution_failed";
    const statuses: Record<string, number> = {
      browser_destination_denied: 403,
      browser_output_too_large: 413,
      browser_runtime_unavailable: 503,
      browser_concurrency_limit: 429,
      browser_timeout: 504,
      browser_locator_ambiguous: 422,
      browser_locator_not_allowed: 422,
      browser_session_not_found: 404,
      browser_session_expired: 410,
      browser_session_busy: 409,
      browser_session_conflict: 409,
      browser_session_limit: 429,
      browser_navigation_failed: 502,
      browser_invalid_request: 400
    };
    throw toolError(code, statuses[code] ?? 502);
  }
  return body;
}

async function browserStorageState(db: pg.Pool, config: AIBrokerConfig, target: ServerPluginTarget): Promise<Record<string, unknown> | undefined> {
  const found = await db.query<{ encrypted_payload: EncryptedPayload }>(
    `select encrypted_payload from server_credentials where server_plugin_id=$1 and kind='browser_storage_state'
     and status='active' and (expires_at is null or expires_at>now()) order by created_at desc limit 1`, [target.id]
  );
  if (!found.rows[0]) return undefined;
  const payload = decryptJson<{ version: number; allowedOrigins: unknown[]; storageState: Record<string, unknown> }>(found.rows[0].encrypted_payload, loadEncryptionKey(config.encryptionKeyBase64));
  const configured = JSON.stringify(target.config.allowed_origins ?? []), bound = JSON.stringify(payload.allowedOrigins ?? []);
  if (payload.version !== 1 || configured !== bound) throw toolError("browser_credential_missing", 400, "Browser authentication state must be replaced after its origin scope changes.");
  // Also catches instances configured before path scoping was required for stored state.
  try { assertAuthenticatedBrowserScope(target.config); }
  catch (err) { throw toolError("browser_scope_required", 400, err instanceof Error ? err.message : "Invalid browser scope"); }
  return payload.storageState;
}

function browserUrl(input: Record<string, unknown>, target: ServerPluginTarget): string {
  const base = new URL(String(target.config.base_url));
  const requested = typeof input.url === "string" && input.url.trim() ? new URL(input.url, base) : base;
  if (requested.username || requested.password) throw toolError("browser_destination_denied", 403);
  const origins = Array.isArray(target.config.allowed_origins) ? target.config.allowed_origins.map(String) : [base.origin];
  const prefixes = Array.isArray(target.config.allowed_path_prefixes) ? target.config.allowed_path_prefixes.map(String) : [];
  if (!origins.includes(requested.origin) || (prefixes.length && !prefixes.some((prefix) => requested.pathname.startsWith(prefix)))) throw toolError("browser_destination_denied", 403);
  return requested.toString();
}

function allowPrivateBrowserTarget(config: AIBrokerConfig, target: ServerPluginTarget): boolean {
  const hostname = new URL(String(target.config.base_url)).hostname;
  return config.browserAllowPrivateTargets && (hostname === target.server.address
    || ["local", "throwaway"].includes(String(target.server.metadata.environment ?? "")));
}

async function executePlaywrightTool(db: pg.Pool, config: AIBrokerConfig, actor: TokenActor, tool: string,
  input: Record<string, unknown>, target: ServerPluginTarget, artifactStore: ArtifactStore): Promise<unknown> {
  const decision = await evaluateAccess(db, actor, target.server, tool, isWriteTool(tool), input, target);
  if (!decision.allowed) {
    if (typeof input.session_id === "string") await closeDeniedBrowserSession(db, config, actor, target, input.session_id);
    throw toolError(decision.reason, 403);
  }
  if (tool === "playwright.list_sessions") {
    const listed = await db.query<LeasedBrowserSession>(
      `select id,server_id,server_plugin_id,actor_user_id,actor_token_id,worker_lease_id,lease_slot,status,current_url,
              event_cursors,event_counts,idle_expires_at,absolute_expires_at,created_at,last_activity_at
       from leased_sessions where server_plugin_id=$1 and actor_user_id=$2 and actor_token_id=$3 order by created_at desc limit 50`,
      [target.id, actor.userId, actor.tokenId]
    );
    return browserResult({ sessions: listed.rows.map(publicBrowserSession) });
  }
  const allowPrivate = allowPrivateBrowserTarget(config, target);
  const commonPayload: Record<string, unknown> = {
    tool, url: browserUrl(input, target), allowed_origins: target.config.allowed_origins,
    allowed_path_prefixes: target.config.allowed_path_prefixes ?? [],
    allow_private: allowPrivate,
    ...(allowPrivate ? { private_hostname: new URL(String(target.config.base_url)).hostname } : {}),
    viewport: { width: Number(target.config.viewport_width), height: Number(target.config.viewport_height) },
    locale: target.config.locale, timezone: target.config.timezone, color_scheme: target.config.color_scheme,
    wait_until: ["load", "domcontentloaded", "settled"].includes(String(input.wait_until)) ? input.wait_until : "load",
    ...(input.full_page === true ? { full_page: true } : {}), ...(input.locator ? { locator: input.locator } : {}),
    ...(input.max_nodes ? { max_nodes: input.max_nodes } : {}),
    ...(Array.isArray(input.levels) ? { levels: input.levels } : {}),
    ...(typeof input.cursor === "number" ? { cursor: input.cursor } : {}),
    ...(typeof input.value === "string" ? { value: input.value } : {}),
    ...(Array.isArray(input.values) ? { values: input.values.map(String) } : {}),
    ...(typeof input.key === "string" ? { key: input.key } : {}),
    ...(typeof input.state === "string" ? { state: input.state } : {}),
    ...(typeof input.timeout_ms === "number" ? { timeout_ms: input.timeout_ms } : {})
  };
  if (tool === "playwright.open_session") return openBrowserSession(db, config, actor, target, commonPayload);
  const sessionId = typeof input.session_id === "string" ? input.session_id : null;
  const sessionOnly = new Set(["playwright.navigate", "playwright.close_session", "playwright.fill", "playwright.select_option", "playwright.press_key", "playwright.wait_for", "playwright.click"]);
  if (sessionOnly.has(tool) && !sessionId) throw toolError("browser_session_not_found", 404);
  const session = sessionId ? await requireBrowserSession(db, config, actor, target, sessionId) : null;
  if (tool === "playwright.close_session" && session) {
    await browserRpc(config, { worker_lease_id: session.worker_lease_id }, "/v1/sessions/close").catch(() => undefined);
    await db.query("update leased_sessions set status='closed',closed_at=now(),close_code='client_close',version=version+1 where id=$1 and status in ('opening','active','closing')", [session.id]);
    return browserResult({ session_id: session.id, status: "closed" });
  }
  if (!session) {
    const state = await browserStorageState(db, config, target); if (state) commonPayload.storage_state = state;
  } else commonPayload.worker_lease_id = session.worker_lease_id;
  const perform = async (transaction: Pick<pg.Pool, "query"> = db) => {
    const result = await browserRpc(config, commonPayload);
    if (session) await touchBrowserSession(transaction, session, tool, result);
    return result;
  };
  let result: Record<string, unknown>;
  try {
    if (tool === "playwright.click") {
      const idempotencyKey = stringField(input, "idempotency_key");
      if (idempotencyKey.length < 16) throw toolError("validation_error", 400, "idempotency_key must be at least 16 characters");
      result = await executeIdempotent(db, actor.tokenId, target.server.id, tool, idempotencyKey,
        sha256(JSON.stringify({ serverPluginId: target.id, sessionId, locator: input.locator })), perform);
    } else result = await perform();
  } catch (error) {
    const code = mapToolError(error).code;
    if (session && ["browser_session_not_found", "browser_session_expired"].includes(code)) {
      // Persist lifecycle failures after the idempotency transaction has rolled back.
      await db.query("update leased_sessions set status=$2,closed_at=now(),error_code=$3,version=version+1 where id=$1 and status in ('opening','active','closing')",
        [session.id, code === "browser_session_expired" ? "expired" : "failed", code]);
    }
    throw error;
  }
  if (tool !== "playwright.capture_screenshot") {
    return browserResult({ ...result, ...(session ? { session_id: session.id } : {}) });
  }
  if (typeof result.data_base64 !== "string") throw toolError("browser_execution_failed", 502);
  const bytes = Buffer.from(result.data_base64, "base64");
  const stored = await artifactStore.put(bytes, 10 * 1024 * 1024);
  const retention = Math.min(Number(target.config.artifact_retention_seconds ?? config.artifactDefaultRetentionSeconds), config.artifactMaxRetentionSeconds);
  const expiresAt = new Date(Date.now() + retention * 1000).toISOString();
  const inserted = await db.query<{ id: string }>(
    `insert into browser_artifacts(server_id,server_plugin_id,session_id,actor_user_id,actor_token_id,artifact_type,mime_type,byte_size,sha256,storage_backend,storage_key,redaction_status,expires_at)
     values($1,$2,$3,$4,$5,'screenshot','image/png',$6,$7,$8,$9,'unredacted',$10) returning id`,
    [target.server.id, target.id, session?.id ?? null, actor.userId, actor.tokenId, stored.size, stored.sha256, artifactStore.backend, stored.key, expiresAt]
  ).catch(async (error) => { await artifactStore.delete(stored.key).catch(() => undefined); throw error; });
  if (session) await db.query("update leased_sessions set event_counts=jsonb_set(event_counts,'{artifacts}',to_jsonb(coalesce((event_counts->>'artifacts')::int,0)+1)),version=version+1 where id=$1", [session.id]).catch(() => undefined);
  const id = inserted.rows[0]!.id, uri = `aibroker://artifacts/${id}`;
  const downloadExpires = Math.min(Date.now() + 5 * 60_000, new Date(expiresAt).getTime());
  const downloadSignature = artifactDownloadSignature(config, id, actor.tokenId, downloadExpires);
  const downloadUrl = new URL(`/mcp/artifacts/${id}/download`, config.publicUrl);
  downloadUrl.searchParams.set("expires", String(downloadExpires)); downloadUrl.searchParams.set("signature", downloadSignature);
  const artifact = { id, uri, mimeType: "image/png", size: stored.size, sha256: stored.sha256, expiresAt, redactionStatus: "unredacted" as const };
  const structuredContent = { final_url: result.final_url, title: result.title, status: result.status, ...(session ? { session_id: session.id } : {}),
    truncated: result.truncated, dropped_count: result.dropped_count,
    artifact: { id, uri, download_url: downloadUrl.toString(), mime_type: "image/png", size: stored.size, sha256: stored.sha256, redaction_status: "unredacted", expires_at: expiresAt } };
  return { kind: "broker_tool_result", structuredContent,
    content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }, { type: "text", text: JSON.stringify(structuredContent) }],
    artifacts: [artifact], auditSummary: { final_url: result.final_url, artifact_id: id, artifact_sha256: stored.sha256, artifact_size: stored.size } };
}

function browserResult(structuredContent: Record<string, unknown>) {
  return { kind: "broker_tool_result" as const, structuredContent,
    auditSummary: { final_url: structuredContent.final_url, session_id: structuredContent.session_id,
      truncated: structuredContent.truncated, dropped_count: structuredContent.dropped_count } };
}

function publicBrowserSession(session: LeasedBrowserSession) {
  return { id: session.id, status: session.status, current_url: session.current_url, created_at: session.created_at,
    last_activity_at: session.last_activity_at, idle_expires_at: session.idle_expires_at,
    absolute_expires_at: session.absolute_expires_at, event_counts: session.event_counts };
}

async function openBrowserSession(db: pg.Pool, config: AIBrokerConfig, actor: TokenActor, target: ServerPluginTarget,
  payload: Record<string, unknown>): Promise<unknown> {
  const client = await db.connect(); let session: LeasedBrowserSession | null = null;
  try {
    await client.query("begin");
    for (const key of [`browser-actor:${actor.tokenId}`, `browser-plugin:${target.id}`].sort()) await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
    await client.query(`update leased_sessions set status='expired',closed_at=now(),close_code='lease_expired',version=version+1
      where status in ('opening','active','closing') and (idle_expires_at<=now() or absolute_expires_at<=now()) and (actor_token_id=$1 or server_plugin_id=$2)`, [actor.tokenId, target.id]);
    const existing = await client.query("select 1 from leased_sessions where actor_token_id=$1 and status in ('opening','active','closing')", [actor.tokenId]);
    if (existing.rowCount) throw toolError("browser_session_limit", 409, "This token already owns an active browser session.");
    const occupied = await client.query<{ lease_slot: number }>("select lease_slot from leased_sessions where server_plugin_id=$1 and status in ('opening','active','closing') order by lease_slot", [target.id]);
    const used = new Set(occupied.rows.map((row) => Number(row.lease_slot))), slot = [1, 2].find((value) => !used.has(value));
    if (!slot) throw toolError("browser_session_limit", 429, "This browser target already has two active sessions.");
    const workerLeaseId = randomUUID();
    const inserted = await client.query<LeasedBrowserSession>(
      `insert into leased_sessions(resource_kind,server_id,server_plugin_id,actor_user_id,actor_token_id,worker_lease_id,lease_slot,viewport,idle_expires_at,absolute_expires_at)
       values('browser',$1,$2,$3,$4,$5,$6,$7::jsonb,now()+interval '5 minutes',now()+interval '15 minutes') returning *`,
      [target.server.id, target.id, actor.userId, actor.tokenId, workerLeaseId, slot,
       JSON.stringify({ width: target.config.viewport_width, height: target.config.viewport_height })]
    );
    session = inserted.rows[0]!; await client.query("commit");
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
  try {
    const state = await browserStorageState(db, config, target);
    const result = await browserRpc(config, { ...payload, worker_lease_id: session.worker_lease_id, ...(state ? { storage_state: state } : {}) });
    const activated = await db.query<LeasedBrowserSession>(
      `update leased_sessions set status='active',current_url=$2,last_activity_at=now(),idle_expires_at=least(now()+interval '5 minutes',absolute_expires_at),version=version+1
       where id=$1 and status='opening' returning *`, [session.id, result.final_url]
    );
    if (!activated.rows[0]) throw toolError("browser_session_conflict", 409);
    const { worker_lease_id: _workerLeaseId, ...publicResult } = result;
    return browserResult({ ...publicResult, session_id: session.id, status: "active",
      idle_expires_at: activated.rows[0].idle_expires_at, absolute_expires_at: activated.rows[0].absolute_expires_at });
  } catch (error) {
    await db.query("update leased_sessions set status='failed',closed_at=now(),error_code=$2,error_message=$3,version=version+1 where id=$1 and status in ('opening','active')",
      [session.id, mapToolError(error).code, (mapToolError(error).message ?? mapToolError(error).code).slice(0, 500)]).catch(() => undefined);
    await browserRpc(config, { worker_lease_id: session.worker_lease_id }, "/v1/sessions/close").catch(() => undefined);
    throw error;
  }
}

async function requireBrowserSession(db: pg.Pool, config: AIBrokerConfig, actor: TokenActor, target: ServerPluginTarget, sessionId: string): Promise<LeasedBrowserSession> {
  const found = await db.query<LeasedBrowserSession>("select * from leased_sessions where id=$1", [sessionId]);
  const session = found.rows[0];
  if (!session || session.actor_user_id !== actor.userId || session.actor_token_id !== actor.tokenId || session.server_plugin_id !== target.id) throw toolError("browser_session_not_found", 404);
  if (session.status !== "active") throw toolError(session.status === "expired" ? "browser_session_expired" : "browser_session_not_active", 409);
  if (new Date(session.idle_expires_at).getTime() <= Date.now() || new Date(session.absolute_expires_at).getTime() <= Date.now()) {
    await db.query("update leased_sessions set status='expired',closed_at=now(),close_code='lease_expired',version=version+1 where id=$1 and status='active'", [session.id]);
    await browserRpc(config, { worker_lease_id: session.worker_lease_id }, "/v1/sessions/close").catch(() => undefined);
    throw toolError("browser_session_expired", 410);
  }
  return session;
}

async function touchBrowserSession(db: Pick<pg.Pool, "query">, session: LeasedBrowserSession, tool: string, result: Record<string, unknown>): Promise<void> {
  const cursorKind = tool === "playwright.get_console_messages" ? "console" : tool === "playwright.get_page_errors" ? "errors" : null;
  await db.query(
    `update leased_sessions set current_url=coalesce($2,current_url),last_activity_at=now(),idle_expires_at=least(now()+interval '5 minutes',absolute_expires_at),
       event_cursors=case when $3::text is null then event_cursors else jsonb_set(event_cursors,array[$3::text],to_jsonb($4::int)) end,
       event_counts=jsonb_set(
         case when $3::text is null then event_counts else jsonb_set(event_counts,array[$3::text],to_jsonb($6::int)) end,
         '{dropped}',to_jsonb(greatest(coalesce((event_counts->>'dropped')::int,0),$5::int)),true),version=version+1
     where id=$1 and status='active'`,
    [session.id, typeof result.final_url === "string" ? result.final_url : null, cursorKind,
     Number(result.next_cursor ?? 0), Number(result.dropped_count ?? 0), Number(result.event_count ?? 0)]
  );
}

async function closeDeniedBrowserSession(db: pg.Pool, config: AIBrokerConfig, actor: TokenActor, target: ServerPluginTarget, sessionId: string): Promise<void> {
  const found = await db.query<{ id: string; worker_lease_id: string }>(
    `select id,worker_lease_id from leased_sessions where id=$1 and server_plugin_id=$2 and actor_user_id=$3 and actor_token_id=$4
     and status in ('opening','active','closing')`, [sessionId, target.id, actor.userId, actor.tokenId]
  );
  if (!found.rows[0]) return;
  await browserRpc(config, { worker_lease_id: found.rows[0].worker_lease_id }, "/v1/sessions/close").catch(() => undefined);
  await db.query("update leased_sessions set status='closed',closed_at=now(),close_code='authorization_revoked',version=version+1 where id=$1 and status in ('opening','active','closing')", [sessionId]);
}

async function readArtifactResource(db: pg.Pool, store: ArtifactStore, actor: TokenActor, uri: string): Promise<{ mimeType: string; data: Uint8Array }> {
  const match = /^aibroker:\/\/artifacts\/([0-9a-f-]{36})$/.exec(uri); if (!match) throw new Error("artifact_not_found");
  const result = await db.query<{ id: string; server_plugin_id: string; mime_type: string; byte_size: number; sha256: string; storage_key: string; status: string; expires_at: string; actor_user_id: string | null; actor_token_id: string | null }>(
    `select id,server_plugin_id,mime_type,byte_size,sha256,storage_key,status,expires_at,actor_user_id,actor_token_id from browser_artifacts where id=$1`, [match[1]]
  );
  const row = result.rows[0];
  if (!row) throw new Error("artifact_not_found");
  if (row.actor_user_id !== actor.userId || row.actor_token_id !== actor.tokenId) throw new Error("artifact_not_found");
  if (row.status !== "available" || new Date(row.expires_at).getTime() <= Date.now()) throw new Error("artifact_expired");
  const target = await getServerPlugin(db, row.server_plugin_id);
  if (!target || target.status !== "enabled" || target.pluginKey !== "playwright" || target.server.status !== "active") throw new Error("artifact_not_found");
  const decision = await evaluateAccess(db, actor, target.server, "playwright.capture_screenshot", false, { server_plugin_id: target.id }, target);
  if (!decision.allowed) throw new Error("artifact_not_found");
  const expectedSize = Number(row.byte_size);
  const data = await store.get(row.storage_key, Math.min(expectedSize, 10 * 1024 * 1024));
  if (data.byteLength !== expectedSize) throw new Error("artifact_integrity_failed");
  if (createHash("sha256").update(data).digest("hex") !== row.sha256) throw new Error("artifact_integrity_failed");
  await writeAuditEvent(db, { requestId: `artifact:${randomUUID()}`, eventType: "browser_artifact_read",
    actorUserId: actor.userId, actorTokenId: actor.tokenId, serverId: target.server.id, status: "success",
    input: { server_plugin_id: target.id, artifact_id: row.id, byte_size: expectedSize, sha256: row.sha256 },
    executorKind: "browser", toolDomain: "browser_artifacts", toolAction: "read", toolRisk: "low" });
  return { mimeType: row.mime_type, data };
}

function artifactDownloadSignature(config: AIBrokerConfig, artifactId: string, tokenId: string, expires: number): string {
  return createHmac("sha256", config.sessionSecret).update(`${artifactId}.${tokenId}.${expires}`).digest("hex");
}

function validArtifactDownloadSignature(config: AIBrokerConfig, artifactId: string, tokenId: string, expires: number, signature: string): boolean {
  const expected = Buffer.from(artifactDownloadSignature(config, artifactId, tokenId, expires), "hex");
  let supplied: Buffer; try { supplied = Buffer.from(signature, "hex"); } catch { return false; }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function executeSshTool(
  db: pg.Pool,
  actor: TokenActor,
  tool: string,
  input: Record<string, unknown>,
  target: ServerPluginTarget
): Promise<unknown> {
  const decision = await evaluateAccess(db, actor, target.server, tool, isWriteTool(tool), input, target);
  if (!decision.allowed) throw toolError(decision.reason, 403);
  if (tool === "ssh.run_command") {
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!reason) throw toolError("reason_required", 400, "Break-glass SSH commands require a justification.");
    const full = await db.query(
      `select 1 from server_bindings sb join policy_plugin_intents pi on pi.policy_id=sb.policy_id
       where sb.server_id=$1 and pi.plugin_key='ssh' and pi.access_level='full'
         -- An instance-specific intent overrides the policy-wide one (same rule as evaluatePolicy).
         and (pi.instance_name=$4 or (pi.instance_name is null and not exists (
           select 1 from policy_plugin_intents override_intent
           where override_intent.policy_id=pi.policy_id and override_intent.plugin_key=pi.plugin_key and override_intent.instance_name=$4
         )))
         and ((sb.subject_type='user' and sb.subject_id=$2) or (sb.subject_type='group' and sb.subject_id=any($3::uuid[]))) limit 1`,
      [target.server.id, actor.userId, actor.groupIds, target.instanceName]
    );
    if (!full.rowCount) throw toolError("full_grant_required", 403, "Raw SSH commands require an explicit Full SSH grant.");
    const key = stringField(input, "idempotency_key");
    const hash = sha256(JSON.stringify({ serverPluginId: target.id, tool, command: input.command, reason }));
    return executeIdempotent(db, actor.tokenId, target.server.id, tool, key, hash, async (client) => {
      const queued = await enqueueHostOperation(db, actor, target.server.id, tool, input, "ssh", target.id, client);
      await writeAuditEvent(client, {
        requestId: `break-glass:${queued.operation_id}`, eventType: "break_glass_used", actorUserId: actor.userId,
        actorTokenId: actor.tokenId, serverId: target.server.id, toolName: tool, status: "success",
        input: { command: input.command, server_plugin_id: target.id }, reason, executorKind: "ssh",
        operationId: queued.operation_id, toolDomain: "host", toolAction: "operate", toolRisk: "critical"
      });
      return queued;
    });
  }
  const enqueue = (client?: pg.PoolClient) => enqueueHostOperation(db, actor, target.server.id, tool, input, "ssh", target.id, client);
  if (!isWriteTool(tool)) return enqueue();
  const key = stringField(input, "idempotency_key");
  const hash = sha256(JSON.stringify({ serverPluginId: target.id, tool, input: { ...input, idempotency_key: undefined } }));
  return executeIdempotent(db, actor.tokenId, target.server.id, tool, key, hash, enqueue);
}

async function executePostgresTool(
  db: pg.Pool,
  config: AIBrokerConfig,
  actor: TokenActor,
  tool: string,
  input: Record<string, unknown>,
  target: ServerPluginTarget
): Promise<unknown> {
  const decision = await evaluateAccess(db, actor, target.server, tool, isWriteTool(tool), input, target);
  if (!decision.allowed) throw toolError(decision.reason, 403);
  const allowedSchemas = new Set((Array.isArray(target.config.allowed_schemas) ? target.config.allowed_schemas : ["public"]).map(String));
  const schema = typeof input.schema === "string" ? input.schema : null;
  if (schema && !allowedSchemas.has(schema)) throw toolError("constraint_failed", 403, `Schema ${schema} is outside the configured scope.`);
  if (tool === "postgres.run_sql") {
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!reason) throw toolError("reason_required", 400);
    const full = await db.query(
      `select 1 from server_bindings sb join policy_plugin_intents pi on pi.policy_id=sb.policy_id
       where sb.server_id=$1 and pi.plugin_key='postgres' and pi.access_level='full'
         -- An instance-specific intent overrides the policy-wide one (same rule as evaluatePolicy).
         and (pi.instance_name=$4 or (pi.instance_name is null and not exists (
           select 1 from policy_plugin_intents override_intent
           where override_intent.policy_id=pi.policy_id and override_intent.plugin_key=pi.plugin_key and override_intent.instance_name=$4
         )))
         and ((sb.subject_type='user' and sb.subject_id=$2) or (sb.subject_type='group' and sb.subject_id=any($3::uuid[]))) limit 1`,
      [target.server.id, actor.userId, actor.groupIds, target.instanceName]
    );
    if (!full.rowCount) throw toolError("full_grant_required", 403, "Unrestricted SQL requires an explicit Full Postgres grant.");
    const key = stringField(input, "idempotency_key");
    const hash = sha256(JSON.stringify({ serverPluginId: target.id, sql: input.sql, parameters: input.parameters, reason }));
    return executeIdempotent(db, actor.tokenId, target.server.id, tool, key, hash, async (client) => {
      const queued = await enqueueHostOperation(db, actor, target.server.id, tool, input, "postgres", target.id, client);
      await writeAuditEvent(client, { requestId: `break-glass:${queued.operation_id}`, eventType: "break_glass_used",
        actorUserId: actor.userId, actorTokenId: actor.tokenId, serverId: target.server.id, toolName: tool,
        status: "success", input: { sql: input.sql, parameters: input.parameters, server_plugin_id: target.id }, reason,
        executorKind: "postgres", operationId: queued.operation_id, toolDomain: "postgres_data", toolAction: "operate", toolRisk: "critical" });
      return queued;
    });
  }
  const credential = await getPostgresCredential(db, config, target.id);
  const pool = new PgPool({ connectionString: credential.connectionString, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  try {
    if (tool === "postgres.list_tables") {
      const params: unknown[] = schema ? [schema] : [Array.from(allowedSchemas)];
      const query = schema
        ? `select table_schema,table_name,table_type from information_schema.tables where table_schema=$1 order by table_schema,table_name limit 1000`
        : `select table_schema,table_name,table_type from information_schema.tables where table_schema=any($1::text[]) order by table_schema,table_name limit 1000`;
      const result = await pool.query(query, params); return { rows: result.rows };
    }
    if (tool === "postgres.read_rows") {
      const table = postgresIdentifier(input.table, "table");
      const selectedSchema = postgresIdentifier(schema, "schema");
      const limit = Math.min(500, Math.max(1, Number(input.limit ?? 100)));
      const result = await pool.query(`select * from ${quotePgIdentifier(selectedSchema)}.${quotePgIdentifier(table)} limit $1`, [limit]);
      return { rows: result.rows, row_count: result.rowCount };
    }
    if (tool === "postgres.run_named_query") {
      const name = String(input.name ?? "");
      const named = target.config.named_queries && typeof target.config.named_queries === "object" ? target.config.named_queries as Record<string, unknown> : {};
      const sql = named[name];
      if (typeof sql !== "string" || !/^\s*(select|with)\b/i.test(sql)) throw toolError("named_query_not_found", 404);
      const result = await pool.query(sql, Array.isArray(input.parameters) ? input.parameters : []);
      return { rows: result.rows, row_count: result.rowCount };
    }
    throw toolError("validation_error", 400);
  } finally { credential.connectionString = ""; await pool.end(); }
}

async function executeWordPressTool(
  db: pg.Pool,
  config: AIBrokerConfig,
  actor: TokenActor,
  tool: string,
  input: Record<string, unknown>,
  target: ServerPluginTarget | null
): Promise<unknown> {
  if (tool === "wordpress.list_sites") {
    const result = await db.query(
      `select distinct sp.id as server_plugin_id,sp.instance_name,sp.plugin_key,s.id as server_id,s.name,s.address,s.status
       from servers s
       join server_plugins sp on sp.server_id=s.id and sp.plugin_key='wordpress' and sp.status='enabled'
       join server_bindings sb on sb.server_id = s.id
       join policies p on p.id = sb.policy_id
       join policy_permissions pp on pp.policy_id = p.id
       where s.status = 'active'
         and pp.effect = 'allow'
         and pp.tool_name = any($4::text[])
         and (pp.instance_name=sp.instance_name or (pp.instance_name is null and not exists (
           select 1 from policy_plugin_intents oi where oi.policy_id=p.id and oi.plugin_key=sp.plugin_key and oi.instance_name=sp.instance_name
         )))
         and (
           (sb.subject_type = 'user' and sb.subject_id = $1)
           or (sb.subject_type = 'group' and sb.subject_id = any($2::uuid[]))
         )
         and not exists (
           select 1
           from server_bindings deny_sb
           join policy_permissions deny_pp on deny_pp.policy_id = deny_sb.policy_id
           where deny_sb.server_id = s.id
             and deny_pp.effect = 'deny'
             and deny_pp.tool_name = any($4::text[])
             and (deny_pp.instance_name=sp.instance_name or (deny_pp.instance_name is null and not exists (
               select 1 from policy_plugin_intents doi where doi.policy_id=deny_sb.policy_id and doi.plugin_key=sp.plugin_key and doi.instance_name=sp.instance_name
             )))
             and (
               (deny_sb.subject_type = 'user' and deny_sb.subject_id = $1)
               or (deny_sb.subject_type = 'group' and deny_sb.subject_id = any($2::uuid[]))
             )
         )
       order by s.name
       limit $3`,
      [actor.userId, actor.groupIds, limit(input.limit), ALL_TOOL_NAMES]
    );
    return { servers: result.rows, next_cursor: null };
  }

  if (!target) throw toolError("server_plugin_not_found", 404);
  const server = target.server;
  const decision = await evaluateAccess(db, actor, server, tool, isWriteTool(tool), input, target);
  if (!decision.allowed) throw toolError(decision.reason, 403);
  const callsPerMinute = decision.effectiveConstraints["rateLimit.callsPerMinute"];
  if (typeof callsPerMinute === "number") {
    const rate = await consumeRateBucket(db, `constraint:${actor.userId}:${server.id}:${tool}`, callsPerMinute);
    if (!rate.allowed) throw toolError("rate_limited", 429, rate.reason);
  }
  // Policy only rejects an explicit over-limit request, so an omitted limit must be
  // clamped here too — otherwise the handler's default (50) exceeds maxResults.
  const maxResults = decision.effectiveConstraints.maxResults;
  if (typeof maxResults === "number") {
    input = { ...input, limit: Math.min(typeof input.limit === "number" ? input.limit : maxResults, maxResults) };
  }
  const backupAge = decision.effectiveConstraints.requiredBackupMaxAgeHours;
  if (typeof backupAge === "number") {
    const recent = await db.query("select 1 from backups where server_id=$1 and status in ('available','verified') and created_at>now()-($2::text||' hours')::interval limit 1", [server.id, backupAge]);
    if (!recent.rowCount) throw toolError("backup_prerequisite_not_met", 409, `Policy requires a backup no older than ${backupAge} hours.`);
  }
  if (tool.startsWith("network_")) {
    const network = await db.query("select 1 from wordpress_networks where primary_server_id=$1 and status='active'", [server.id]);
    if (!network.rowCount) throw toolError("network_target_required", 409, "Network operations must target the network's primary server binding.");
  }

  // Typed REST tools run through the shared handler registry. The REST credential
  // is fetched once here, the client is built
  // with the connector's SSRF/timeout/size hardening, and mutations go through the same
  // idempotency machinery as the Phase 1 page tools. last_used_at is bumped only after the
  // handler actually completes a request.
  // Page-builder tools (AB-ELEMENTOR) run on the shared REST credential plus, where
  // REST cannot do the job, the calling user's own WordPress login session.
  const builderHandler = PAGE_BUILDER_TOOL_HANDLERS[tool];
  if (builderHandler) {
    const credential = await requireRestCredential(db, config, target.id, true);
    let sessionCredentialId: string | null = null;
    let sessionLoad: ReturnType<typeof loadWordPressSession> | undefined;
    const ctx: PageBuilderToolCtx = {
      toolName: tool,
      input,
      rest: restClient(config, server, credential.payload),
      session: async () => {
        sessionLoad ??= loadWordPressSession(db, config, target, actor.userId);
        const loaded = await sessionLoad;
        sessionCredentialId = loaded?.credentialId ?? null;
        return loaded?.client ?? null;
      },
      snapshots: snapshotStore(db, target.id, actor.userId),
      pluginConfig: target.config,
      idempotent: <T,>(action: () => Promise<T>) => {
        const idempotencyKey = stringField(input, "idempotency_key");
        const { idempotency_key: _omit, ...rest } = input;
        const inputHash = sha256(JSON.stringify({ serverId: server.id, tool, rest }));
        return executeIdempotent(db, actor.tokenId, server.id, tool, idempotencyKey, inputHash, action);
      },
      toolError
    };
    try {
      const result = await builderHandler(ctx);
      await db.query("update server_credentials set last_used_at = now() where id = any($1::uuid[])",
        [[credential.id, ...(sessionCredentialId ? [sessionCredentialId] : [])]]);
      return result;
    } catch (err) {
      if (err instanceof WordPressSessionError && err.code === "wordpress_session_expired" && sessionCredentialId) {
        await markSessionExpired(db, sessionCredentialId);
      }
      throw err;
    }
  }

  const restHandler = REST_TOOL_HANDLERS[tool];
  if (restHandler) {
    const credential = await requireRestCredential(db, config, target.id, true);
    const client = restClient(config, server, credential.payload);
    const ctx: RestToolCtx = {
      input,
      client,
      idempotent: <T,>(action: () => Promise<T>) => {
        const idempotencyKey = stringField(input, "idempotency_key");
        const { idempotency_key: _omit, ...rest } = input;
        const inputHash = sha256(JSON.stringify({ serverId: server.id, tool, rest }));
        return executeIdempotent(db, actor.tokenId, server.id, tool, idempotencyKey, inputHash, action);
      },
      toolError
    };
    const result = await restHandler(ctx);
    await db.query("update server_credentials set last_used_at = now() where id = $1", [credential.id]);
    return result;
  }

  if (tool === "wordpress.get_site_summary") {
    const credential = await requireRestCredential(db, config, target.id, true);
    const client = restClient(config, server, credential.payload);
    const summary = await client.getServerSummary();
    return { server: { ...server, ...summary } };
  }

  if (tool === "wordpress.list_pages") {
    const credential = await requireRestCredential(db, config, target.id, true);
    const client = restClient(config, server, credential.payload);
    return client.listPages({
      ...(Array.isArray(input.status) ? { status: input.status.map(String) } : {}),
      ...(typeof input.search === "string" ? { search: input.search } : {}),
      limit: limit(input.limit),
      ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {})
    });
  }

  if (tool === "wordpress.get_page") {
    const credential = await requireRestCredential(db, config, target.id, true);
    const client = restClient(config, server, credential.payload);
    return { page: await client.getPage(stringField(input, "page_id"), input.include_content !== false) };
  }

  if (tool === "wordpress.list_posts") {
    const credential = await requireRestCredential(db, config, target.id, true);
    return restClient(config, server, credential.payload).listPosts(listInput(input));
  }

  if (tool === "wordpress.get_post") {
    const credential = await requireRestCredential(db, config, target.id, true);
    return { post: await restClient(config, server, credential.payload).getPost(stringField(input, "id"), input.include_content !== false) };
  }

  if (tool === "wordpress.list_media") {
    const credential = await requireRestCredential(db, config, target.id, true);
    return restClient(config, server, credential.payload).listMedia(listInput(input));
  }

  if (tool === "wordpress.get_media") {
    const credential = await requireRestCredential(db, config, target.id, true);
    return { media: await restClient(config, server, credential.payload).getMedia(stringField(input, "id")) };
  }

  if (tool === "wordpress.list_taxonomies") {
    const credential = await requireRestCredential(db, config, target.id, true);
    return { taxonomies: await restClient(config, server, credential.payload).listTaxonomies() };
  }

  if (tool === "wordpress.list_terms") {
    const credential = await requireRestCredential(db, config, target.id, true);
    return restClient(config, server, credential.payload).listTerms(stringField(input, "taxonomy"), listInput(input));
  }

  if (tool === "wordpress.list_custom_post_types") {
    const credential = await requireRestCredential(db, config, target.id, true);
    return { custom_post_types: await restClient(config, server, credential.payload).listCustomPostTypes() };
  }

  if (TOOL_META.get(tool)?.executorKind === "wp_cli") {
    const enqueue = (client?: pg.PoolClient) => enqueueHostOperation(db, actor, server.id, tool, input, "ssh", undefined, client);
    if (isWriteTool(tool)) {
      const idempotencyKey = stringField(input, "idempotency_key");
      const inputHash = sha256(JSON.stringify({ serverId: server.id, tool, input: { ...input, idempotency_key: undefined } }));
      return executeIdempotent(db, actor.tokenId, server.id, tool, idempotencyKey, inputHash, enqueue);
    }
    return enqueue();
  }
  if (TOOL_META.get(tool)?.executorKind === "workspace") {
    const enqueue = (client?: pg.PoolClient) => enqueueHostOperation(db, actor, server.id, tool, input, "ssh", undefined, client);
    if (isWriteTool(tool)) {
      const key=stringField(input,"idempotency_key"); const hash=sha256(JSON.stringify({serverId:server.id,tool,input:{...input,idempotency_key:undefined}}));
      return executeIdempotent(db,actor.tokenId,server.id,tool,key,hash,enqueue);
    }
    return enqueue();
  }
  if (["database","hosting"].includes(TOOL_META.get(tool)?.executorKind ?? "")) {
    const executor=TOOL_META.get(tool)!.executorKind;const enqueue=(client?: pg.PoolClient)=>enqueueHostOperation(db,actor,server.id,tool,input,executor==="hosting"?"hosting":"ssh",undefined,client);
    if(isWriteTool(tool)){const key=stringField(input,"idempotency_key");const hash=sha256(JSON.stringify({serverId:server.id,tool,input:{...input,idempotency_key:undefined}}));return executeIdempotent(db,actor.tokenId,server.id,tool,key,hash,enqueue);}return enqueue();
  }

  if (tool === "wordpress.create_draft_page") {
    const idempotencyKey = stringField(input, "idempotency_key");
    const title = stringField(input, "title");
    const content = stringField(input, "content");
    const slug = typeof input.slug === "string" ? input.slug : null;
    const inputHash = sha256(JSON.stringify({ serverId: server.id, title, slug, content }));
    return executeIdempotent(db, actor.tokenId, server.id, tool, idempotencyKey, inputHash, async (transaction) => {
      const credential = await requireRestCredential(transaction, config, target.id, true);
      const client = restClient(config, server, credential.payload);
      return { page: await client.createDraftPage({ title, slug, content }), idempotency_key: idempotencyKey };
    });
  }

  if (tool === "wordpress.update_draft_page") {
    const idempotencyKey = stringField(input, "idempotency_key");
    const pageId = stringField(input, "page_id");
    const expectedRevisionId = stringField(input, "expected_revision_id");
    const title = typeof input.title === "string" ? input.title : null;
    const content = typeof input.content === "string" ? input.content : null;
    const inputHash = sha256(JSON.stringify({ serverId: server.id, pageId, expectedRevisionId, title, content }));
    return executeIdempotent(db, actor.tokenId, server.id, tool, idempotencyKey, inputHash, async (transaction) => {
      const credential = await requireRestCredential(transaction, config, target.id, true);
      const page = await restClient(config, server, credential.payload).updateDraftPage({ pageId, expectedRevisionId, title, content });
      return { page, idempotency_key: idempotencyKey };
    });
  }

  if (tool === "wordpress.publish_page") {
    const idempotencyKey = stringField(input, "idempotency_key");
    const pageId = stringField(input, "page_id");
    const inputHash = sha256(JSON.stringify({ serverId: server.id, pageId }));
    return executeIdempotent(db, actor.tokenId, server.id, tool, idempotencyKey, inputHash, async (transaction) => {
      const credential = await requireRestCredential(transaction, config, target.id, true);
      const page = await restClient(config, server, credential.payload).publishDraftPage(pageId);
      return { page, idempotency_key: idempotencyKey };
    });
  }

  throw toolError("validation_error", 400);
}

export async function executeIdempotent<T>(
  db: pg.Pool,
  tokenId: string,
  serverId: string,
  toolName: string,
  idempotencyKey: string,
  inputHash: string,
  action: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const lockKey = `${tokenId}:${serverId}:${toolName}:${idempotencyKey}`;
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
    const existing = await client.query<{ input_hash: string; response_payload: T }>(
      `select input_hash, response_payload from idempotency_keys
       where actor_token_id = $1 and server_id = $2 and tool_name = $3 and idempotency_key = $4`,
      [tokenId, serverId, toolName, idempotencyKey]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].input_hash !== inputHash) throw toolError("idempotency_conflict", 409);
      await client.query("commit");
      return existing.rows[0].response_payload;
    }
    const response = await action(client);
    await client.query(
      `insert into idempotency_keys (actor_token_id, server_id, tool_name, idempotency_key, input_hash, response_payload)
       values ($1,$2,$3,$4,$5,$6::jsonb)`,
      [tokenId, serverId, toolName, idempotencyKey, inputHash, JSON.stringify(response)]
    );
    await client.query("commit");
    return response;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// Report whether the executor and credential a tool needs are actually available for a
// server. This is capability/connector state only — it never affects authorization, it just
// explains why an allowed operation might still fail to run (WPB-ACCESS decision 9).
async function describeConnectorAvailability(
  db: pg.Pool,
  serverId: string,
  meta: ToolDefinition | undefined
): Promise<{
  required_executor: string | null;
  required_credentials: string[];
  credential_status: "present" | "missing" | "not_required";
  executor_status: "available" | "unavailable" | "unknown";
  connector_mode?: string | null;
}> {
  const requiredExecutor = meta?.executorKind ?? null;
  const requiredCredentials = meta?.credentialKinds ?? [];

  let credentialStatus: "present" | "missing" | "not_required" = "not_required";
  if (requiredCredentials.length > 0) {
    const found = await db.query(
      `select 1 from server_credentials sc join server_plugins sp on sp.id=sc.server_plugin_id
       where sp.server_id = $1 and sp.status='enabled' and sc.status = 'active' and sc.kind = any($2::text[])
         and (expires_at is null or expires_at > now()) limit 1`,
      [serverId, requiredCredentials]
    );
    credentialStatus = found.rowCount ? "present" : "missing";
  }

  let executorStatus: "available" | "unavailable" | "unknown" = "unknown";
  if (requiredExecutor === "internal") {
    executorStatus = "available";
  } else if (requiredExecutor) {
    // Map executor kind to the discovered capability that gates it.
    const capability =
      requiredExecutor === "rest" ? "rest_reachable"
        : requiredExecutor === "wp_cli" || requiredExecutor === "host_session" ? "ssh_configured"
          : requiredExecutor === "browser" ? "browser_runtime_available" : null;
    if (capability) {
      const cap = await db.query<{ status: string }>(
        "select sc.status from server_capabilities sc join server_plugins sp on sp.id=sc.server_plugin_id where sp.server_id = $1 and sp.status='enabled' and sc.capability = $2",
        [serverId, capability]
      );
      const status = cap.rows[0]?.status;
      executorStatus = status === "available" ? "available" : status === "unavailable" ? "unavailable" : "unknown";
    }
  }

  let connectorMode: string | null = null;
  if (requiredExecutor === "wp_cli" || requiredExecutor === "workspace" || requiredExecutor === "host_session") {
    const configured = await db.query<{ mode: string }>("select mode from ssh_connectors where server_id=$1", [serverId]);
    connectorMode = configured.rows[0]?.mode ?? null;
  }
  return {
    required_executor: requiredExecutor,
    required_credentials: requiredCredentials,
    credential_status: credentialStatus,
    executor_status: executorStatus,
    connector_mode: connectorMode
  };
}

async function evaluateAccess(
  db: pg.Pool,
  actor: TokenActor,
  server: ServerRow,
  toolName: string,
  isWrite: boolean,
  input: Record<string, unknown>,
  target?: Pick<ServerPluginTarget, "pluginKey" | "instanceName">
) {
  const metadata = TOOL_META.get(toolName);
  return evaluatePolicy(db, {
    userId: actor.userId,
    role: actor.role,
    groupIds: actor.groupIds,
    server: { id: server.id, status: server.status },
    toolName,
    pluginKey: target?.pluginKey ?? metadata?.name.split(".")[0] ?? toolName.split(".")[0]!,
    instanceName: target?.instanceName ?? null,
    ...(metadata?.risk ? { toolRisk: metadata.risk } : {}),
    ...(metadata?.domain ? { toolDomain: metadata.domain } : {}),
    ...(metadata?.action ? { toolAction: metadata.action } : {}),
    isWrite,
    input
  });
}

async function checkRateLimit(
  db: pg.Pool,
  actor: TokenActor,
  toolName: string,
  serverPluginId: string
): Promise<{ allowed: boolean; reason?: string }> {
  const buckets = [
    { key: `token:${actor.tokenId}`, max: 120 },
    { key: `user:${actor.userId}`, max: 240 },
    { key: `server_plugin:${serverPluginId}`, max: 300 },
    { key: `server_plugin_tool:${serverPluginId}:${toolName}`, max: 120 }
  ];
  const client = await db.connect();
  try {
    await client.query("begin");
    // Lock every bucket in stable order so concurrent requests cannot all pass
    // the count-before-insert window (and cannot deadlock each other).
    for (const bucket of [...buckets].sort((a, b) => a.key.localeCompare(b.key))) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [bucket.key]);
      const count = await client.query<{ count: number }>(
        "select count(*)::int as count from rate_limit_events where bucket = $1 and created_at > now() - interval '1 minute'",
        [bucket.key]
      );
      if (Number(count.rows[0]?.count ?? 0) >= bucket.max) {
        await client.query("rollback");
        return { allowed: false, reason: `${bucket.key} exceeded ${bucket.max}/minute` };
      }
    }
    await client.query("insert into rate_limit_events (bucket) select unnest($1::text[])", [buckets.map((bucket) => bucket.key)]);
    await client.query("delete from rate_limit_events where created_at < now() - interval '10 minutes'");
    await client.query("commit");
    return { allowed: true };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// Single-bucket sliding-window limiter over rate_limit_events, used for policy-configured
// per-tool limits (the rateLimit.callsPerMinute constraint).
async function consumeRateBucket(db: pg.Pool, bucket: string, max: number): Promise<{ allowed: boolean; reason?: string }> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [bucket]);
    const count = await client.query<{ count: number }>(
      "select count(*)::int as count from rate_limit_events where bucket = $1 and created_at > now() - interval '1 minute'",
      [bucket]
    );
    if (Number(count.rows[0]?.count ?? 0) >= max) {
      await client.query("rollback");
      return { allowed: false, reason: `policy limit of ${max}/minute exceeded` };
    }
    await client.query("insert into rate_limit_events (bucket) values ($1)", [bucket]);
    await client.query("commit");
    return { allowed: true };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function sessionClaims(request: FastifyRequest, secret: string): Promise<{ sub: string; ep: number } | null> {
  const token = request.headers["x-aibroker-session"];
  if (!token || Array.isArray(token)) return null;
  return verifySessionToken(token, secret);
}

// A token is only valid for the epoch it was issued under; see migration 008.
function sessionEpochMatches(user: AdminUser, claims: { ep: number }): boolean {
  return (user.session_epoch ?? 0) === claims.ep;
}

async function requireAdmin(db: pg.Pool, request: FastifyRequest, reply: FastifyReply): Promise<AdminUser | null> {
  const claims = await sessionClaims(request, request.server.config.sessionSecret);
  if (!claims) {
    reply.code(401).send({ error: "admin_auth_required" });
    return null;
  }
  const result = await db.query<AdminUser>(
    "select id, owner_user_id, email, display_name, role, status, password_change_required, session_epoch from users where id = $1",
    [claims.sub]
  );
  const user = result.rows[0];
  if (user && !sessionEpochMatches(user, claims)) {
    reply.code(401).send({ error: "admin_auth_required" });
    return null;
  }
  if (!user || user.status !== "active" || !["global_admin", "team_admin"].includes(user.role)) {
    reply.code(403).send({ error: "admin_denied" });
    return null;
  }
  if (user.password_change_required) {
    reply.code(403).send({ error: "password_change_required" });
    return null;
  }
  return user;
}

async function requireGlobalAdmin(db: pg.Pool, request: FastifyRequest, reply: FastifyReply): Promise<AdminUser | null> {
  const actor = await requireAdmin(db, request, reply);
  if (!actor) return null;
  if (actor.role !== "global_admin") {
    reply.code(403).send({ error: "global_admin_required" });
    return null;
  }
  return actor;
}

// Any active authenticated user (regular users and auditors included). Used by
// self-service /me/* routes. Same header-based identity as requireAdmin, but no
// role gate — governance is enforced per-route by scoping rows to the actor.
async function requireUser(db: pg.Pool, request: FastifyRequest, reply: FastifyReply): Promise<AdminUser | null> {
  const claims = await sessionClaims(request, request.server.config.sessionSecret);
  if (!claims) {
    reply.code(401).send({ error: "auth_required" });
    return null;
  }
  const result = await db.query<AdminUser>(
    "select id, owner_user_id, email, display_name, role, status, password_change_required, session_epoch from users where id = $1",
    [claims.sub]
  );
  const user = result.rows[0];
  if (!user || user.status !== "active" || !sessionEpochMatches(user, claims)) {
    reply.code(401).send({ error: "auth_required" });
    return null;
  }
  if (user.password_change_required) {
    reply.code(403).send({ error: "password_change_required" });
    return null;
  }
  return user;
}

async function canManageUser(db: Pick<pg.Pool, "query">, actor: AdminUser, userId: string): Promise<boolean> {
  if (actor.role === "global_admin") return true;
  if (actor.id === userId) return false;
  const result = await db.query(
    `with recursive scope as (
       select id from users where owner_user_id = $1
       union all
       select child.id from users child join scope s on child.owner_user_id = s.id
     )
     select 1 from scope where id = $2 limit 1`,
    [actor.id, userId]
  );
  return Boolean(result.rowCount);
}

async function isLastGlobalAdmin(db: Pick<pg.Pool, "query">, userId: string): Promise<boolean> {
  const others = await db.query(
    "select 1 from users where role = 'global_admin' and status = 'active' and id <> $1 limit 1",
    [userId]
  );
  return !others.rowCount;
}

async function canUseOwner(db: Pick<pg.Pool, "query">, actor: AdminUser, ownerUserId: string): Promise<boolean> {
  if (actor.role === "global_admin") return true;
  if (actor.id === ownerUserId) return true;
  return canManageUser(db, actor, ownerUserId);
}

async function canManageGroup(db: Pick<pg.Pool, "query">, actor: AdminUser, groupId: string): Promise<boolean> {
  if (actor.role === "global_admin") return true;
  const result = await db.query<{ owner_user_id: string | null }>("select owner_user_id from groups where id = $1", [groupId]);
  const ownerUserId = result.rows[0]?.owner_user_id;
  if (!ownerUserId) return false;
  return canUseOwner(db, actor, ownerUserId);
}

// Servers a non-global admin manages: those bound to a user or group in their ownership scope.
const MANAGED_SERVERS_SQL = `with recursive scope as (
       select $1::uuid as id union all
       select u.id from users u join scope on u.owner_user_id = scope.id
     )
     select s.id from servers s
     where exists (
         select 1 from server_bindings sb
         where sb.server_id = s.id and (
           (sb.subject_type = 'user' and sb.subject_id in (select id from scope))
           or (sb.subject_type = 'group' and sb.subject_id in (select id from groups where owner_user_id in (select id from scope)))
         )
     )`;

async function canManageServer(db: Pick<pg.Pool, "query">, actor: AdminUser, serverId: string): Promise<boolean> {
  if (actor.role === "global_admin") return true;
  const result = await db.query(`select 1 from (${MANAGED_SERVERS_SQL}) managed where managed.id = $2 limit 1`, [actor.id, serverId]);
  return Boolean(result.rowCount);
}

// null means unrestricted (global admin).
async function managedServerIds(db: Pick<pg.Pool, "query">, actor: AdminUser): Promise<string[] | null> {
  if (actor.role === "global_admin") return null;
  const result = await db.query<{ id: string }>(MANAGED_SERVERS_SQL, [actor.id]);
  return result.rows.map((row) => row.id);
}

async function canManagePolicy(db: Pick<pg.Pool, "query">, actor: AdminUser, policyId: string): Promise<boolean> {
  if (actor.role === "global_admin") return true;
  const result = await db.query(
    `with recursive scope as (
       select $1::uuid as id
       union all select child.id from users child join scope parent on child.owner_user_id=parent.id
     )
     select 1 from policies p where p.id=$2 and p.built_in=false and p.created_by in (select id from scope) limit 1`,
    [actor.id, policyId]
  );
  return Boolean(result.rowCount);
}

function normalizePolicyIntent(raw: unknown): PolicyPluginIntent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Each policy intent must be an object.");
  const value = raw as Record<string, unknown>;
  const pluginKey = String(value.plugin_key ?? value.pluginKey ?? "");
  const plugin = PLUGIN_REGISTRY.get(pluginKey);
  if (!plugin) throw new Error(`Unknown plugin: ${pluginKey}`);
  const mode = value.mode === "advanced" ? "advanced" : value.mode === "simple" ? "simple" : null;
  if (!mode) throw new Error("Policy intent mode must be simple or advanced.");
  const accessLevel = String(value.access_level ?? value.accessLevel ?? "none") as AccessLevel;
  if (!ACCESS_LEVELS.includes(accessLevel)) throw new Error(`Invalid access level: ${accessLevel}`);
  const requestedCeiling = value.risk_ceiling ?? value.riskCeiling;
  const riskCeiling = mode === "simple"
    ? plugin.accessLevels[accessLevel].riskCeiling
    : requestedCeiling == null || requestedCeiling === "none" ? null : String(requestedCeiling) as PolicyPluginIntent["riskCeiling"];
  if (riskCeiling !== null && !["low", "medium", "high", "critical"].includes(riskCeiling)) throw new Error("Invalid risk ceiling.");
  const instanceNameValue = value.instance_name ?? value.instanceName;
  const instanceName = instanceNameValue == null || String(instanceNameValue).trim() === "" ? null : String(instanceNameValue).trim();
  const grants = value.grants && typeof value.grants === "object" && !Array.isArray(value.grants)
    ? value.grants as Record<string, string[]>
    : {};
  for (const [domain, actions] of Object.entries(grants)) {
    if (!plugin.domains.some((item) => item.key === domain) || !Array.isArray(actions) || actions.some((action) => !TOOL_ACTIONS.includes(action as never))) {
      throw new Error(`Invalid advanced grant: ${domain}`);
    }
  }
  const rawDeniedTools = value.denied_tools ?? value.deniedTools;
  const deniedTools = Array.isArray(rawDeniedTools)
    ? rawDeniedTools.map(String)
    : [];
  if (deniedTools.some((name) => !plugin.tools.some((tool) => tool.name === name))) throw new Error("A denied tool does not belong to this plugin.");
  const constraints = value.constraints && typeof value.constraints === "object" && !Array.isArray(value.constraints)
    ? value.constraints as Record<string, Record<string, unknown>>
    : {};
  for (const [toolName, constraint] of Object.entries(constraints)) validateConstraints(toolName, constraint);
  return { pluginKey, instanceName, mode, accessLevel, riskCeiling, grants, deniedTools, constraints };
}

function intentNeedsFullConfirmation(intent: PolicyPluginIntent): boolean {
  return intent.accessLevel === "full" || intent.riskCeiling === "critical"
    || Object.values(intent.grants ?? {}).some((actions) => actions.includes("operate"));
}

async function replacePolicyIntents(db: pg.Pool, policyId: string, intents: PolicyPluginIntent[]): Promise<void> {
  const reviewed = await db.query<{ name: string }>("select name from tool_definitions where is_enabled=true and reviewed=true");
  const reviewedTools = new Set(reviewed.rows.map((row) => row.name));
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("delete from policy_permissions where policy_id=$1", [policyId]);
    await client.query("delete from policy_plugin_intents where policy_id=$1", [policyId]);
    for (const intent of intents) {
      const stored = await client.query<{ id: string }>(
        `insert into policy_plugin_intents(policy_id,plugin_key,instance_name,mode,access_level,risk_ceiling,grants,denied_tools,constraints)
         values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) returning id`,
        [policyId, intent.pluginKey, intent.instanceName ?? null, intent.mode, intent.accessLevel, intent.riskCeiling,
         JSON.stringify(intent.grants ?? {}), JSON.stringify(intent.deniedTools ?? []), JSON.stringify(intent.constraints ?? {})]
      );
      const plugin = PLUGIN_REGISTRY.get(intent.pluginKey)!;
      for (const permission of materializePluginIntent(plugin, intent, reviewedTools)) {
        const constraints = validateConstraints(permission.toolName, permission.constraints);
        await client.query(
          `insert into policy_permissions(policy_id,tool_name,effect,constraints,policy_intent_id,instance_name,risk_ceiling)
           values($1,$2,$3,$4::jsonb,$5,$6,$7)`,
          [policyId, permission.toolName, permission.effect, JSON.stringify(constraints), stored.rows[0]!.id,
           intent.instanceName ?? null, permission.riskCeiling]
        );
      }
    }
    await client.query("update policies set updated_at=now() where id=$1", [policyId]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function rematerializePolicyIntents(db: pg.Pool): Promise<void> {
  const policies = await db.query<{ policy_id: string }>("select distinct policy_id from policy_plugin_intents");
  for (const row of policies.rows) {
    const stored = await db.query<Record<string, unknown>>(
      "select plugin_key,instance_name,mode,access_level,risk_ceiling,grants,denied_tools,constraints from policy_plugin_intents where policy_id=$1",
      [row.policy_id]
    );
    await replacePolicyIntents(db, row.policy_id, stored.rows.map(normalizePolicyIntent));
  }
}

async function canManageBindingSubject(
  db: Pick<pg.Pool, "query">,
  actor: AdminUser,
  subjectType: "user" | "group",
  subjectId: string
): Promise<boolean> {
  if (subjectType === "user") return canManageUser(db, actor, subjectId);
  return canManageGroup(db, actor, subjectId);
}

async function authenticateToken(db: pg.Pool, request: FastifyRequest, reply: FastifyReply): Promise<TokenActor | null> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) {
    error(reply, 401, "unauthenticated");
    return null;
  }
  const prefix = token.slice(0, 12);
  const result = await db.query(
    `select t.id as token_id, t.token_hash, t.expires_at, t.revoked_at, u.id as user_id, u.role, u.status
     from api_tokens t join users u on u.id = t.user_id where t.token_prefix = $1`,
    [prefix]
  );
  const row = result.rows.find((candidate) => verifyApiToken(token, candidate.token_hash));
  if (!row) {
    error(reply, 401, "unauthenticated");
    return null;
  }
  if (row.revoked_at) {
    error(reply, 401, "token_revoked");
    return null;
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    error(reply, 401, "token_expired");
    return null;
  }
  if (row.status !== "active") {
    error(reply, 403, "user_disabled");
    return null;
  }
  await db.query("update api_tokens set last_used_at = now() where id = $1", [row.token_id]);
  const groups = await db.query("select group_id from group_memberships where user_id = $1", [row.user_id]);
  return {
    tokenId: row.token_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    groupIds: groups.rows.map((group) => group.group_id)
  };
}

// Failed-login throttling. The window must stay within the 10-minute retention that
// checkRateLimit prunes rate_limit_events to.
const LOGIN_FAILURES_PER_EMAIL = 10;
const LOGIN_FAILURES_PER_IP = 50;

async function loginThrottled(db: pg.Pool, email: string, ip: string): Promise<boolean> {
  const result = await db.query<{ email_failures: number; ip_failures: number }>(
    `select count(*) filter (where bucket = $1)::int as email_failures,
            count(*) filter (where bucket = $2)::int as ip_failures
     from rate_limit_events where bucket in ($1, $2) and created_at > now() - interval '10 minutes'`,
    [`login_fail:email:${email}`, `login_fail:ip:${ip}`]
  );
  const row = result.rows[0];
  return Number(row?.email_failures ?? 0) >= LOGIN_FAILURES_PER_EMAIL || Number(row?.ip_failures ?? 0) >= LOGIN_FAILURES_PER_IP;
}

async function recordLoginFailure(db: pg.Pool, email: string, ip: string): Promise<void> {
  await db.query("insert into rate_limit_events (bucket) values ($1), ($2)", [`login_fail:email:${email}`, `login_fail:ip:${ip}`]);
}

// Always run one scrypt verification, even for unknown or inactive users, so response
// time does not reveal whether an account exists.
let dummyPasswordHash: Promise<string> | undefined;
async function checkPassword(user: { status: string; password_hash: string } | undefined, password: string): Promise<boolean> {
  const hash = user?.password_hash ?? await (dummyPasswordHash ??= hashPassword(randomUUID()));
  const matches = await verifyPassword(password, hash);
  return Boolean(user && user.status === "active" && matches);
}

async function findUserByEmail(
  db: pg.Pool,
  email: string
): Promise<(AdminUser & { password_hash: string }) | undefined> {
  const result = await db.query<AdminUser & { password_hash: string }>(
    "select id, owner_user_id, email, display_name, password_hash, role, status, password_change_required, session_epoch from users where email = $1",
    [email]
  );
  return result.rows[0];
}

async function actorForUser(db: pg.Pool, userId: string): Promise<TokenActor | null> {
  const user = await db.query<AdminUser>(
    "select id, owner_user_id, email, display_name, role, status, password_change_required from users where id = $1",
    [userId]
  );
  const row = user.rows[0];
  if (!row) return null;
  const groups = await db.query("select group_id from group_memberships where user_id = $1", [userId]);
  return { tokenId: "", userId, role: row.role, status: row.status, groupIds: groups.rows.map((g) => g.group_id) };
}

async function getServer(db: pg.Pool, serverId: string): Promise<ServerRow | null> {
  const result = await db.query<ServerRow>("select * from servers where id = $1", [serverId]);
  return result.rows[0] ?? null;
}

async function getServerPlugin(db: Pick<pg.Pool, "query">, serverPluginId: string): Promise<ServerPluginTarget | null> {
  const result = await db.query<{
    id: string; plugin_key: string; instance_name: string; status: "enabled" | "disabled" | "removed";
    config: Record<string, unknown>; server_id: string; server_name: string; address: string;
    server_status: string; metadata: Record<string, unknown>;
  }>(
    `select sp.id,sp.plugin_key,sp.instance_name,sp.status,sp.config,s.id as server_id,s.name as server_name,
            s.address,s.status as server_status,s.metadata
     from server_plugins sp join servers s on s.id=sp.server_id where sp.id=$1`, [serverPluginId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const server = { id: row.server_id, name: row.server_name, address: row.address,
    base_url: "", status: row.server_status, capabilities: {}, metadata: row.metadata ?? {} } as ServerRow & { metadata: Record<string, unknown> };
  const config = interpolateServerConfig(row.config ?? {}, server) as Record<string, unknown>;
  server.base_url = typeof config.base_url === "string" ? config.base_url : `https://${server.address}`;
  return { id: row.id, pluginKey: row.plugin_key, instanceName: row.instance_name, status: row.status, config, server };
}

async function listAccessibleTools(db: Pick<pg.Pool, "query">, actor: TokenActor): Promise<ToolDefinition[]> {
  const result = await db.query<{ name: string }>(
    `select distinct td.name
     from tool_definitions td
     join server_plugins sp on sp.plugin_key=td.plugin_key and sp.status='enabled'
     join servers s on s.id=sp.server_id and s.status='active'
     join server_bindings sb on sb.server_id=s.id
     join policy_permissions pp on pp.policy_id=sb.policy_id and pp.tool_name=td.name and pp.effect='allow'
     where td.is_enabled=true and ((sb.subject_type='user' and sb.subject_id=$1)
       or (sb.subject_type='group' and sb.subject_id=any($2::uuid[])))
       and (pp.instance_name=sp.instance_name or (pp.instance_name is null and not exists (
         select 1 from policy_plugin_intents oi where oi.policy_id=sb.policy_id and oi.plugin_key=sp.plugin_key and oi.instance_name=sp.instance_name
       )))
       and not exists (
         select 1 from server_bindings dsb join policy_permissions dpp on dpp.policy_id=dsb.policy_id
         where dsb.server_id=s.id and dpp.tool_name=td.name and dpp.effect='deny'
           and (dpp.instance_name=sp.instance_name or (dpp.instance_name is null and not exists (
             select 1 from policy_plugin_intents doi where doi.policy_id=dsb.policy_id and doi.plugin_key=sp.plugin_key and doi.instance_name=sp.instance_name
           )))
           and ((dsb.subject_type='user' and dsb.subject_id=$1) or (dsb.subject_type='group' and dsb.subject_id=any($2::uuid[])))
       )`, [actor.userId, actor.groupIds]
  );
  const allowed = new Set(result.rows.map((row) => row.name));
  return PLUGIN_REGISTRY.tools().filter((tool) => allowed.has(tool.name));
}

async function probeWordPressCapabilities(db: pg.Pool, config: AIBrokerConfig, target: ServerPluginTarget) {
  const credential = await getRestCredential(db, config, target.id, true);
  if (!credential) throw toolError("credential_missing", 400, "Add a WordPress application-password credential before testing the connection.");
  const discovery = await restClient(config, target.server, credential.payload).discoverCapabilities();
  const yn = (value: boolean): "available" | "unavailable" => value ? "available" : "unavailable";
  const detail = { wordpress_version: discovery.wordpressVersion, is_multisite: discovery.isMultisite,
    namespaces: discovery.namespaces, content_types: discovery.contentTypes, taxonomies: discovery.taxonomies };
  return [
    { capability: "rest_reachable", status: yn(discovery.reachable), executorKind: "rest", credentialId: credential.id, details: detail,
      ...(!discovery.reachable ? { errorCode: discovery.errorCode, errorMessage: discovery.errorMessage } : {}) },
    { capability: "rest_authenticated", status: yn(discovery.authenticated), executorKind: "rest", credentialId: credential.id,
      ...(!discovery.authenticated ? { errorCode: discovery.errorCode, errorMessage: discovery.errorMessage } : {}) },
    { capability: "media_upload", status: yn(discovery.mediaSupported), executorKind: "rest", credentialId: credential.id,
      ...(!discovery.mediaSupported && discovery.errorCode ? { errorCode: discovery.errorCode, errorMessage: discovery.errorMessage } : {}) },
    ...(discovery.authenticated ? await probePageBuilders(restClient(config, target.server, credential.payload), credential.id) : [])
  ];
}

// One capability per registered page-builder adapter, e.g. "elementor_page_builder",
// with version, REST-meta and cache-refresh details for the admin Capabilities tab.
async function probePageBuilders(client: WordPressRestClient, credentialId: string) {
  return Promise.all(PAGE_BUILDER_ADAPTERS.map(async (adapter) => {
    const capability = `${adapter.key}_page_builder`;
    try {
      const detected = await adapter.detect(client);
      return { capability, status: detected.active ? "available" as const : "unavailable" as const, executorKind: "rest", credentialId,
        details: { version: detected.version, ...detected.details } };
    } catch (err) {
      return { capability, status: "unknown" as const, executorKind: "rest", credentialId, errorCode: mapToolError(err).code };
    }
  }));
}

async function probeSshCapabilities(db: pg.Pool, config: AIBrokerConfig, target: ServerPluginTarget) {
  const connector = await db.query<{
    credential_id: string; encrypted_payload: EncryptedPayload; host: string; port: number; username: string;
  }>(
    `select c.credential_id,sc.encrypted_payload,c.host,c.port,c.username
     from ssh_connectors c join server_credentials sc on sc.id=c.credential_id
     where c.server_plugin_id=$1 and sc.status='active'`, [target.id]
  );
  const row = connector.rows[0];
  if (!row) throw toolError("credential_missing", 400, "Provision the confined SSH account before testing it.");
  const credential = decryptJson<{ privateKey: string; knownHostsLine: string }>(row.encrypted_payload, loadEncryptionKey(config.encryptionKeyBase64));
  try {
    const result = await executeSshCommand({ host: row.host, port: row.port, username: row.username,
      privateKey: credential.privateKey, knownHostsLine: credential.knownHostsLine,
      command: ["aibroker-probe"], timeoutMs: 20_000, maxOutputBytes: 64 * 1024 });
    const available = result.exitCode === 0;
    await db.query("update ssh_connectors set connection_status=$2,last_tested_at=now(),updated_at=now() where server_plugin_id=$1",
      [target.id, available ? "available" : "unavailable"]);
    return [
      { capability: "ssh_configured", status: available ? "available" as const : "unavailable" as const,
        executorKind: "ssh", credentialId: row.credential_id, details: { confined_user: row.username } },
      { capability: "workspace_confined", status: available ? "available" as const : "unknown" as const,
        executorKind: "ssh", credentialId: row.credential_id, details: { workspace_root: target.config.workspace_root } }
    ];
  } finally { credential.privateKey = ""; }
}

async function probePostgresCapabilities(db: pg.Pool, config: AIBrokerConfig, target: ServerPluginTarget) {
  const credential = await getPostgresCredential(db, config, target.id);
  const pool = new PgPool({ connectionString: credential.connectionString, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  try {
    const result = await pool.query<{ version: string; database: string; role: string }>("select version(),current_database() database,current_user role");
    await db.query("update postgres_connectors set connection_status='available',last_tested_at=now(),updated_at=now() where server_plugin_id=$1", [target.id]);
    return [{ capability: "postgres_connected", status: "available" as const, executorKind: "postgres", credentialId: credential.id, details: result.rows[0] }];
  } catch (err) {
    await db.query("update postgres_connectors set connection_status='unavailable',last_tested_at=now(),updated_at=now() where server_plugin_id=$1", [target.id]);
    throw err;
  } finally { credential.connectionString = ""; await pool.end(); }
}

async function getPostgresCredential(db: pg.Pool, config: AIBrokerConfig, serverPluginId: string): Promise<{ id: string; connectionString: string }> {
  const result = await db.query<{ id: string; encrypted_payload: EncryptedPayload }>(
    `select sc.id,sc.encrypted_payload from postgres_connectors pc join server_credentials sc on sc.id=pc.credential_id
     where pc.server_plugin_id=$1 and sc.status='active' and (sc.expires_at is null or sc.expires_at>now())`, [serverPluginId]
  );
  const row = result.rows[0]; if (!row) throw toolError("postgres_credential_missing", 400);
  const payload = decryptJson<{ connectionString: string }>(row.encrypted_payload, loadEncryptionKey(config.encryptionKeyBase64));
  return { id: row.id, connectionString: payload.connectionString };
}

function postgresIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw toolError("validation_error", 400, `Invalid Postgres ${label}.`);
  return value;
}
function normalizePostgresConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const config = { ...raw };
  config.port = typeof config.port === "string" ? Number(config.port) : (config.port ?? 5432);
  if (!Number.isInteger(config.port) || Number(config.port) < 1 || Number(config.port) > 65535) throw new Error("invalid_postgres_port");
  config.database = postgresIdentifier(config.database ?? "postgres", "database");
  config.scoped_role = postgresIdentifier(config.scoped_role ?? "aibroker_scoped", "role");
  if (typeof config.allowed_schemas === "string") config.allowed_schemas = config.allowed_schemas.split(",").map((item) => item.trim()).filter(Boolean);
  if (!Array.isArray(config.allowed_schemas) || config.allowed_schemas.length === 0) throw new Error("invalid_postgres_schemas");
  config.allowed_schemas = config.allowed_schemas.map((item) => postgresIdentifier(item, "schema"));
  if (typeof config.named_queries === "string") config.named_queries = JSON.parse(config.named_queries || "{}");
  if (!config.named_queries || typeof config.named_queries !== "object" || Array.isArray(config.named_queries)) throw new Error("invalid_postgres_named_queries");
  for (const [name, sql] of Object.entries(config.named_queries as Record<string, unknown>)) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name) || typeof sql !== "string" || !/^\s*(select|with)\b/i.test(sql)) throw new Error("invalid_postgres_named_query");
  }
  return config;
}
function quotePgIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function quotePgLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

async function createPostgresSandbox(databaseUrl: string): Promise<Record<string, unknown>> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `aib_sandbox_${suffix}`;
  const username = `aib_sandbox_${suffix}`;
  const password = `${randomUUID()}${randomUUID()}`;
  const admin = new URL(databaseUrl); admin.pathname = "/postgres";
  const pool = new PgPool({ connectionString: admin.toString(), max: 1, connectionTimeoutMillis: 10_000 });
  try {
    // This disposable identity is the one-time sandbox administrator. CREATEROLE lets
    // the normal plugin onboarding flow mint its separate scoped identity, mirroring production.
    await pool.query(`create role ${quotePgIdentifier(username)} login createrole password ${quotePgLiteral(password)}`);
    try { await pool.query(`create database ${quotePgIdentifier(database)} owner ${quotePgIdentifier(username)}`); }
    catch (err) { await pool.query(`drop role if exists ${quotePgIdentifier(username)}`); throw err; }
  } finally { await pool.end(); }
  const scoped = new URL(databaseUrl);
  scoped.pathname = `/${database}`; scoped.username = username; scoped.password = password;
  return { connection_config: { address: scoped.hostname, host: scoped.hostname, port: Number(scoped.port || 5432), database,
    allowed_schemas: ["public"], ephemeral: true, resource_database: database, resource_role: username },
    secrets: { username, password, connection_string: scoped.toString() } };
}

async function teardownPostgresSandbox(databaseUrl: string, rawConfig: unknown): Promise<void> {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig as Record<string, unknown> : {};
  const database = postgresIdentifier(config.resource_database, "sandbox database");
  const role = postgresIdentifier(config.resource_role, "sandbox role");
  const admin = new URL(databaseUrl); admin.pathname = "/postgres";
  const pool = new PgPool({ connectionString: admin.toString(), max: 1, connectionTimeoutMillis: 10_000 });
  try {
    await pool.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()", [database]);
    await pool.query(`drop database if exists ${quotePgIdentifier(database)}`);
    await pool.query(`drop role if exists ${quotePgIdentifier(role)}`);
  } finally { await pool.end(); }
}

async function provisionPostgresRole(input: { credential: { connectionString: string }; role: string; password: string; database: string; schemas: string[] }): Promise<void> {
  const pool = new PgPool({ connectionString: input.credential.connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const role = quotePgIdentifier(input.role), password = quotePgLiteral(input.password), database = quotePgIdentifier(input.database);
    const exists = await pool.query("select 1 from pg_roles where rolname=$1", [input.role]);
    await pool.query(exists.rowCount ? `alter role ${role} login password ${password}` : `create role ${role} login password ${password}`);
    await pool.query(`grant connect on database ${database} to ${role}`);
    for (const schemaName of input.schemas) {
      const schema = quotePgIdentifier(postgresIdentifier(schemaName, "schema"));
      await pool.query(`grant usage on schema ${schema} to ${role}`);
      await pool.query(`grant select on all tables in schema ${schema} to ${role}`);
      await pool.query(`alter default privileges in schema ${schema} grant select on tables to ${role}`).catch(() => undefined);
    }
  } finally { await pool.end(); }
}

async function deprovisionPostgresRole(input: { credential: { connectionString: string }; role: string }): Promise<void> {
  const pool = new PgPool({ connectionString: input.credential.connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const role = quotePgIdentifier(input.role);
    await pool.query("select pg_terminate_backend(pid) from pg_stat_activity where usename=$1 and pid<>pg_backend_pid()", [input.role]);
    // Revoke schema/table/default-privilege ACL dependencies established during
    // provisioning before dropping the login itself. PostgreSQL requires membership
    // in the target role for DROP OWNED; the bootstrap CREATEROLE identity grants
    // itself temporary membership, which disappears when the role is dropped.
    const current = await pool.query<{ current_user: string }>("select current_user");
    const administrator = quotePgIdentifier(current.rows[0]!.current_user);
    await pool.query(`grant ${role} to ${administrator}`);
    // Full access may have created objects. Preserve them by transferring ownership
    // to the administrator before DROP OWNED removes only the scoped role's grants.
    await pool.query(`reassign owned by ${role} to ${administrator}`);
    await pool.query(`drop owned by ${role}`);
    await pool.query(`drop role if exists ${role}`);
  } finally { await pool.end(); }
}

async function getRestCredential(
  db: Pick<pg.Pool, "query">,
  config: AIBrokerConfig,
  targetId: string,
  isServerPlugin = false
): Promise<{ id: string; payload: RestCredentialPayload; expires_at: string | null } | null> {
  const result = await db.query<{ id: string; encrypted_payload: EncryptedPayload; expires_at: string | null }>(
    `select id, encrypted_payload, expires_at from server_credentials
     where ${isServerPlugin ? "server_plugin_id" : "server_id"} = $1 and kind = 'wordpress_rest_application_password' and status = 'active'
       and (expires_at is null or expires_at > now())
     order by created_at desc limit 1`,
    [targetId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    payload: decryptJson<RestCredentialPayload>(row.encrypted_payload, loadEncryptionKey(config.encryptionKeyBase64)),
    expires_at: row.expires_at ?? null
  };
}

export async function enqueueHostOperation(
  db: pg.Pool,
  actor: TokenActor,
  serverId: string,
  toolName: string,
  input: Record<string, unknown>,
  connectorKind: "ssh" | "hosting" | "postgres",
  serverPluginId?: string,
  transaction?: pg.PoolClient
): Promise<{ operation_id: string; status: "queued" }> {
  const queryDb = transaction ?? db;
  const connector = connectorKind === "ssh"
    ? await queryDb.query("select 1 from ssh_connectors c join server_credentials sc on sc.id=c.credential_id where c.server_id=$1 and sc.status='active'", [serverId])
    : connectorKind === "hosting"
      ? await queryDb.query("select 1 from hosting_providers p join server_credentials sc on sc.id=p.credential_id where p.server_id=$1 and sc.status='active'", [serverId])
      : await queryDb.query("select 1 from postgres_connectors p join server_credentials sc on sc.id=p.credential_id where p.server_plugin_id=$1 and sc.status='active'", [serverPluginId]);
  if (!connector.rowCount) throw toolError(`${connectorKind}_credential_missing`, 400, `No active ${connectorKind} connector is configured for this server.`);
  const client = transaction ?? await db.connect();
  try {
    if (!transaction) await client.query("begin");
    const persistedInput = toolName === "ssh.run_command" || toolName === "postgres.run_sql" ? input : redactObject(input);
    const operation = await client.query<{ id: string }>(
      `insert into host_operations(server_id, server_plugin_id, actor_user_id, actor_token_id, tool_name, input, reason)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7) returning id`,
      [serverId, serverPluginId ?? null, actor.userId, actor.tokenId, toolName, JSON.stringify(persistedInput), typeof input.reason === "string" ? input.reason : null]
    );
    const operationId = operation.rows[0]!.id;
    const job = await client.query<{ id: string }>(
      "insert into jobs(kind, server_id, payload) values ($3,$1,jsonb_build_object('operation_id',$2::text)) returning id",
      [serverId, operationId, connectorKind === "hosting" ? "provider.operation" : connectorKind === "postgres" ? "database.operation" : "host.wp_cli"]
    );
    await client.query("update host_operations set job_id=$2 where id=$1", [operationId, job.rows[0]!.id]);
    if (!transaction) await client.query("commit");
    return { operation_id: operationId, status: "queued" };
  } catch (error) {
    if (!transaction) await client.query("rollback");
    throw error;
  } finally { if (!transaction) client.release(); }
}

async function requireRestCredential(
  db: Pick<pg.Pool, "query">,
  config: AIBrokerConfig,
  targetId: string,
  isServerPlugin = false
): Promise<{ id: string; payload: RestCredentialPayload }> {
  const credential = await getRestCredential(db, config, targetId, isServerPlugin);
  if (!credential) {
    throw toolError(
      "credential_missing",
      400,
      "No REST credential registered for this server — add one under Servers → REST credential."
    );
  }
  return credential;
}

function restClient(config: AIBrokerConfig, server: ServerRow, credentials: RestCredentialPayload): WordPressRestClient {
  return new WordPressRestClient({
    baseUrl: server.base_url,
    credentials,
    allowPrivateTargets: config.allowPrivateConnectorTargets
  });
}

async function scalar(db: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ count: number }>(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function defaultMcpServerName(db: pg.Pool): Promise<string> {
  const result = await db.query<{ value: string }>(
    "select value from app_settings where key = 'default_mcp_server_name'"
  );
  return result.rows[0]?.value ?? DEFAULT_MCP_SERVER_NAME;
}

function publicUser(user: AdminUser): Omit<AdminUser, "status"> & { status: string } {
  return {
    id: user.id,
    owner_user_id: user.owner_user_id ?? null,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    password_change_required: user.password_change_required
  };
}

function shouldEnforcePasswordPolicy(config: AIBrokerConfig): boolean {
  return !["development", "test"].includes(config.nodeEnv);
}

async function auditFromRequest(
  db: pg.Pool,
  request: FastifyRequest,
  input: {
    eventType: string;
    status: "success" | "failure" | "denied";
    actorUserId?: string;
    actorTokenId?: string;
    serverId?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    errorCode?: string;
    durationMs?: number;
    encryptedPayload?: unknown;
    reason?: string;
    sessionId?: string;
    operationId?: string;
    executorKind?: string;
  }
): Promise<void> {
  const userAgent = userAgentOf(request);
  await writeAuditEvent(db, {
    requestId: request.id,
    eventType: input.eventType,
    status: input.status,
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    ...(input.actorTokenId ? { actorTokenId: input.actorTokenId } : {}),
    ...(input.serverId ? { serverId: input.serverId } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.input ? { input: input.input } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode, errorClass: classifyError(input.errorCode) } : {}),
    ...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
    ...(input.encryptedPayload != null ? { encryptedPayload: input.encryptedPayload } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.executorKind ? { executorKind: input.executorKind } : {}),
    clientIp: request.ip,
    ...(userAgent ? { userAgent } : {})
  });
}

// Full-fidelity MCP body capture (decision C1), gated by AIBROKER_MCP_CAPTURE_BODIES.
// Encrypts the request input alongside the tool's result or error into the existing
// audit_events.encrypted_payload column. Secret redaction still applies to the stored
// body so app passwords / bearer tokens never land in the vault in the clear. Returns
// undefined (leaving the column null) when capture is off, so the monitor degrades to
// metadata + redacted summary.
function captureMcpBody(
  config: AIBrokerConfig,
  tool: string,
  input: Record<string, unknown>,
  outcome: { result: unknown } | { error: { code: string; message?: string } }
): unknown {
  if (!config.mcpCaptureBodies) return undefined;
  const body: Record<string, unknown> = { input: redactObject(browserAuditInput(tool, input)) };
  if ("result" in outcome) {
    body.result = redactValue(auditSafeToolResult(outcome.result));
  } else {
    body.error = outcome.error;
  }
  return encryptJson(body, loadEncryptionKey(config.encryptionKeyBase64));
}

function browserAuditInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!tool.startsWith("playwright.")) return input;
  const safe = { ...input };
  if (tool === "playwright.fill" && "value" in safe) safe.value = "[REDACTED]";
  if (tool === "playwright.select_option" && "values" in safe) safe.values = "[REDACTED]";
  return safe;
}

function userAgentOf(request: FastifyRequest): string | undefined {
  const value = request.headers["user-agent"];
  return Array.isArray(value) ? value.join(", ") : value;
}

function error(reply: FastifyReply, status: number, code: string, message?: string): { error: string; message?: string } {
  reply.code(status);
  return { error: code, ...(message ? { message } : {}) };
}

function toolError(code: string, status = 400, message?: string): Error & { code: string; status: number } {
  const err = new Error(message ?? code) as Error & { code: string; status: number };
  err.code = code;
  err.status = status;
  return err;
}

function mapToolError(err: unknown): { code: string; status: number; message?: string } {
  if (err instanceof WordPressSessionError) return { code: err.code, status: err.statusCode, message: err.message };
  if (err instanceof WordPressRestError) {
    // Distinguish credential rejection, a missing endpoint/resource, and connector faults
    // (timeouts, oversized responses) from a generic WordPress error. The
    // WordPress error code is surfaced verbatim where present; the message never contains
    // request credentials (normalizeWpError strips the body to code+message only).
    const connectorCodes = new Set(["timeout", "response_too_large", "too_many_redirects", "connector_unavailable", "bad_redirect", "invalid_response"]);
    if (err.wpCode && connectorCodes.has(err.wpCode)) return { code: err.wpCode, status: err.statusCode, message: err.message };
    if (err.statusCode === 401 || err.statusCode === 403) return { code: err.wpCode ?? "wordpress_forbidden", status: err.statusCode, message: err.message };
    if (err.statusCode === 404) return { code: err.wpCode ?? "wordpress_not_found", status: 404, message: err.message };
    if (err.statusCode === 409) return { code: err.wpCode ?? "revision_conflict", status: 409, message: err.message };
    if (err.statusCode === 413 || err.statusCode === 415) return { code: err.wpCode ?? "media_rejected", status: err.statusCode, message: err.message };
    return { code: err.wpCode ?? "wordpress_error", status: err.statusCode >= 500 ? 502 : err.statusCode, message: err.message };
  }
  if (err && typeof err === "object" && "code" in err && "status" in err) {
    const tool = err as { code: string; status: number; message?: string };
    return { code: tool.code, status: tool.status, ...(tool.message ? { message: tool.message } : {}) };
  }
  return {
    code: "connector_unavailable",
    status: 500,
    ...(err instanceof Error ? { message: err.message } : {})
  };
}

// Structured error classification for audit (Phase 1.7): a small, stable set that later
// phases and dashboards can group by, distinct from the free-form error_code.
function classifyError(code: string): string {
  if (["explicit_deny", "not_granted", "risk_ceiling", "constraint_failed", "policy_denied", "constraints_denied", "server_disabled"].includes(code)) return "authorization";
  if (["credential_missing", "connector_unavailable", "executor_unavailable", "wordpress_error"].includes(code)) return "connector";
  if (["validation_error", "invalid_constraints"].includes(code)) return "validation";
  if (code === "rate_limited") return "rate_limit";
  if (code.endsWith("_not_found")) return "not_found";
  return "execution";
}

function isRole(value: string): boolean {
  return ["global_admin", "team_admin", "auditor", "user"].includes(value);
}

function roleRank(role: string): number {
  return { user: 1, auditor: 2, team_admin: 3, global_admin: 4 }[role] ?? 0;
}

const OWNER_ROLES = new Set(["team_admin", "global_admin"]);

function canOwnRole(ownerRole: string, targetRole: string): boolean {
  return OWNER_ROLES.has(ownerRole) && roleRank(ownerRole) >= roleRank(targetRole);
}

function isUserStatus(value: unknown): value is string {
  return ["active", "invited", "disabled", "deleted"].includes(String(value));
}

function sessionModeCompatible(requested: "read" | "constrained_shell" | "full_shell" | "root_access", configured: string): boolean {
  if (requested === "root_access") return configured === "root_access";
  if (requested === "full_shell") return configured === "full_shell" || configured === "root_access";
  if (requested === "constrained_shell") return configured === "constrained_shell";
  return configured === "constrained_shell";
}

function knownHostsMatchesFingerprint(line: string, fingerprint: string): boolean {
  const fields=line.trim().split(/\s+/); const key=fields.length>=3?fields[2]:null;
  if(!key||line.includes("\n")||line.includes("\r"))return false;
  try{const digest=createHash("sha256").update(Buffer.from(key,"base64")).digest("base64").replace(/=+$/g,"");return fingerprint===`SHA256:${digest}`;}catch{return false;}
}

function isKnownTool(value: unknown): value is string {
  return typeof value === "string" && TOOL_META.has(value);
}

function stringField(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) throw toolError("validation_error", 400);
  return value;
}

function limit(value: unknown): number {
  return Math.max(1, Math.min(100, typeof value === "number" ? Math.trunc(value) : 50));
}

function listInput(input: Record<string, unknown>): { status?: string[]; search?: string; limit: number; cursor?: string } {
  return {
    ...(Array.isArray(input.status) ? { status: input.status.map(String) } : {}),
    ...(typeof input.search === "string" ? { search: input.search } : {}),
    limit: limit(input.limit),
    ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {})
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0] ?? {});
  const escape = (value: unknown) => {
    const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n");
}

// ---------------------------------------------------------------------------
// MCP monitor (Fix C, Phase 1): derive sessions + traffic from audit_events.
// A "session" is a maximal run of one token's mcp_tool_call events sharing
// client_ip + user_agent with no idle gap longer than the threshold (decision
// C2). Sessions are recomputed on read, so changing the threshold just re-buckets
// history. Everything here is admin-only and ownership-scoped (decision C5).
// ---------------------------------------------------------------------------

const MCP_DEFAULT_IDLE_MINUTES = 5;
const MCP_LIVE_WINDOW_MS = 90_000; // last-seen within this ⇒ "live", else "active" within idle window
const MCP_EXPORT_MAX_ROWS = 50_000; // cap very large exports (decision C9)
const MCP_EXPORT_BATCH = 500;

interface McpTrafficFilters {
  token_id?: string;
  user_id?: string;
  server_id?: string;
  tool?: string;
  status?: string; // success | failure | denied | errors
  error_code?: string;
  from?: string;
  to?: string;
  q?: string;
  since?: string;
  cursor?: string;
}

// The synthetic session id is the anchor (first) event's uuid. It is short (URL-safe,
// under Fastify's param length cap), stable as a live session accrues more calls, and
// self-describing: the traffic/export queries re-derive the token + client_ip + user_agent
// partition from the anchor event itself, so no server-side session state is needed.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(raw)));
}

function mcpSessionState(lastSeen: Date, idleMinutes: number, now = Date.now()): "live" | "active" | "ended" {
  const age = now - lastSeen.getTime();
  if (age <= MCP_LIVE_WINDOW_MS) return "live";
  if (age <= idleMinutes * 60_000) return "active";
  return "ended";
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

// team_admin sees only sessions/traffic for tokens owned by itself or a descendant
// in the ownership tree (decision C5). Returns null for global_admin (unrestricted),
// otherwise the in-scope token id list (possibly empty ⇒ sees nothing).
async function mcpScopedTokenIds(db: pg.Pool, actor: AdminUser): Promise<string[] | null> {
  if (actor.role === "global_admin") return null;
  const result = await db.query<{ id: string }>(
    `select tk.id from api_tokens tk
     where tk.user_id in (
       with recursive scope as (
         select $1::uuid as id
         union all
         select u.id from users u join scope s on u.owner_user_id = s.id
       ) select id from scope
     )`,
    [actor.id]
  );
  return result.rows.map((row) => row.id);
}

function decodeBody(payload: EncryptedPayload | null, config: AIBrokerConfig): unknown {
  if (!payload) return null;
  try {
    return decryptJson(payload, loadEncryptionKey(config.encryptionKeyBase64));
  } catch {
    return null;
  }
}

// All mcp_tool_call events belonging to one derived session, oldest-first. Derives the
// (token, ip, ua) partition from the anchor event, re-runs the gap sessionization for it,
// and keeps only the run that contains the anchor — so the result is exactly one session's
// traffic. Empty when the anchor id is unknown or not an mcp_tool_call event.
async function mcpSessionEventRows(
  db: pg.Pool,
  anchorId: string,
  idleMinutes: number
): Promise<Array<Record<string, unknown>>> {
  const result = await db.query(
    `with anchor as (
       select actor_token_id, client_ip, user_agent
       from audit_events where id = $1 and event_type = 'mcp_tool_call' and actor_token_id is not null
     ),
     calls as (
       select ae.*, lag(ae.created_at) over w as prev_at
       from audit_events ae, anchor a
       where ae.event_type = 'mcp_tool_call' and ae.actor_token_id = a.actor_token_id
         and ae.client_ip is not distinct from a.client_ip and ae.user_agent is not distinct from a.user_agent
       window w as (order by ae.created_at, ae.id)
     ),
     marked as (
       select c.*, sum(case when prev_at is null or created_at - prev_at > $2::interval then 1 else 0 end)
                     over (order by created_at, id) as session_seq
       from calls c
     ),
     target as (select session_seq from marked where id = $1 limit 1)
     select m.id, m.request_id, m.actor_user_id, m.actor_token_id, m.server_id, m.tool_name, m.status,
            m.error_code, m.duration_ms, m.client_ip, m.user_agent, m.input_summary, m.encrypted_payload,
            m.created_at, t.token_prefix, u.email as owner_email, st.name as server_name
     from marked m
     join api_tokens t on t.id = m.actor_token_id
     join users u on u.id = t.user_id
     left join servers st on st.id = m.server_id
     where m.session_seq = (select session_seq from target)
     order by m.created_at, m.id`,
    [anchorId, `${idleMinutes} minutes`]
  );
  return result.rows as Array<Record<string, unknown>>;
}

// Traffic list row as sent to the monitor: metadata + redacted summary always; full
// body is never inlined here — it is revealed per-event via /admin/mcp/events/:id
// (audited) or included in exports when capture is on.
function mcpTrafficView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    created_at: row.created_at,
    tool: row.tool_name,
    status: row.status,
    error_code: row.error_code,
    duration_ms: row.duration_ms,
    server_id: row.server_id,
    server_name: row.server_name ?? null,
    client_ip: row.client_ip,
    user_agent: row.user_agent,
    token_id: row.actor_token_id,
    token_prefix: row.token_prefix ?? null,
    token_name: row.token_name ?? null,
    owner_email: row.owner_email ?? null,
    input_summary: row.input_summary,
    has_body: Boolean(row.has_body ?? row.encrypted_payload != null)
  };
}

// One exported event line: metadata + redacted summary + the decrypted full body when
// capture (C1) was on for that call. Bodies were themselves secret-redacted before
// encryption, so no app password / bearer token is ever emitted in the clear.
function mcpExportRow(row: Record<string, unknown>, config: AIBrokerConfig): Record<string, unknown> {
  return {
    id: row.id,
    request_id: row.request_id ?? null,
    created_at: row.created_at,
    tool: row.tool_name,
    status: row.status,
    error_code: row.error_code,
    duration_ms: row.duration_ms,
    server_id: row.server_id,
    server_name: row.server_name ?? null,
    client_ip: row.client_ip,
    user_agent: row.user_agent,
    token_prefix: row.token_prefix ?? null,
    owner_email: row.owner_email ?? null,
    input_summary: row.input_summary,
    body: decodeBody((row.encrypted_payload as EncryptedPayload | null) ?? null, config)
  };
}

// Build the shared filter WHERE fragment (after `where ae.event_type='mcp_tool_call'`)
// for the global traffic list and its export, so both honor the exact same filters
// (decision C9) and ownership scope. Returns the SQL fragment and its ordered params;
// callers continue param numbering from params.length.
function buildTrafficWhere(filters: McpTrafficFilters, tokenIds: string[] | null): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const conds: string[] = [];
  const p = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (tokenIds) conds.push(`ae.actor_token_id = any(${p(tokenIds)}::uuid[])`);
  if (filters.token_id) conds.push(`ae.actor_token_id = ${p(filters.token_id)}::uuid`);
  if (filters.user_id) conds.push(`ae.actor_user_id = ${p(filters.user_id)}::uuid`);
  if (filters.server_id) conds.push(`ae.server_id = ${p(filters.server_id)}::uuid`);
  if (filters.tool) conds.push(`ae.tool_name = ${p(filters.tool)}`);
  if (filters.status) conds.push(filters.status === "errors" ? "ae.status <> 'success'" : `ae.status = ${p(filters.status)}`);
  if (filters.error_code) conds.push(`ae.error_code = ${p(filters.error_code)}`);
  if (filters.from) conds.push(`ae.created_at >= ${p(filters.from)}::timestamptz`);
  if (filters.to) conds.push(`ae.created_at <= ${p(filters.to)}::timestamptz`);
  if (filters.q) {
    const like = p(`%${filters.q}%`);
    conds.push(`(ae.tool_name ilike ${like} or ae.error_code ilike ${like} or ae.client_ip ilike ${like} or t.token_prefix ilike ${like} or u.email ilike ${like})`);
  }
  return { sql: conds.length ? ` and ${conds.join(" and ")}` : "", params };
}

const MCP_TRAFFIC_SELECT = `
  select ae.id, ae.request_id, ae.actor_user_id, ae.actor_token_id, ae.server_id, ae.tool_name, ae.status,
         ae.error_code, ae.duration_ms, ae.client_ip, ae.user_agent, ae.input_summary,
         (ae.encrypted_payload is not null) as has_body, ae.encrypted_payload, ae.created_at,
         t.token_prefix, t.name as token_name, u.email as owner_email, u.display_name as owner_name, st.name as server_name
  from audit_events ae
  join api_tokens t on t.id = ae.actor_token_id
  join users u on u.id = t.user_id
  left join servers st on st.id = ae.server_id
  where ae.event_type = 'mcp_tool_call'`;

// Stream export rows to the client without buffering the whole result set: NDJSON is
// one event per line; JSON is a single { session, events[] } object. Uses reply.hijack()
// so we own the raw socket and can backpressure on each write.
async function streamMcpExport(
  reply: FastifyReply,
  format: string,
  filename: string,
  header: Record<string, unknown> | null,
  rows: AsyncIterable<Record<string, unknown>>,
  config: AIBrokerConfig
): Promise<void> {
  const ndjson = format !== "json";
  reply.raw.setHeader("Content-Type", ndjson ? "application/x-ndjson; charset=utf-8" : "application/json; charset=utf-8");
  reply.raw.setHeader("Content-Disposition", `attachment; filename="${filename}.${ndjson ? "ndjson" : "json"}"`);
  reply.hijack();
  const write = (chunk: string) =>
    new Promise<void>((resolve, reject) => reply.raw.write(chunk, (err) => (err ? reject(err) : resolve())));
  try {
    if (!ndjson) {
      await write(`{"session":${JSON.stringify(header ?? null)},"events":[`);
    } else if (header) {
      await write(`${JSON.stringify({ type: "session", ...header })}\n`);
    }
    let first = true;
    for await (const row of rows) {
      const line = JSON.stringify(mcpExportRow(row, config));
      if (ndjson) await write(`${line}\n`);
      else {
        await write(first ? line : `,${line}`);
        first = false;
      }
    }
    if (!ndjson) await write("]}");
  } finally {
    reply.raw.end();
  }
}

// Keyset-paginated (created_at, id) descending generator over the filtered traffic set,
// so a filtered export streams in bounded batches and stops at MCP_EXPORT_MAX_ROWS.
async function* mcpTrafficExportRows(
  db: pg.Pool,
  filters: McpTrafficFilters,
  tokenIds: string[] | null
): AsyncGenerator<Record<string, unknown>> {
  let after: { createdAt: string; id: string } | null = null;
  let emitted = 0;
  for (;;) {
    const { sql: whereSql, params } = buildTrafficWhere(filters, tokenIds);
    const p = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    let keyset = "";
    if (after) {
      const createdAtParam = p(after.createdAt);
      const idParam = p(after.id);
      keyset = ` and (ae.created_at, ae.id) < (${createdAtParam}::timestamptz, ${idParam}::uuid)`;
    }
    const limitParam = p(MCP_EXPORT_BATCH);
    const result = await db.query(
      `${MCP_TRAFFIC_SELECT}${whereSql}${keyset} order by ae.created_at desc, ae.id desc limit ${limitParam}`,
      params
    );
    const batch = result.rows as Array<Record<string, unknown>>;
    if (batch.length === 0) return;
    for (const row of batch) {
      yield row;
      emitted += 1;
      if (emitted >= MCP_EXPORT_MAX_ROWS) return;
    }
    const last = batch[batch.length - 1];
    if (!last) return;
    after = { createdAt: toIso(last.created_at), id: String(last.id) };
    if (batch.length < MCP_EXPORT_BATCH) return;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    db: pg.Pool;
    config: AIBrokerConfig;
  }
}
