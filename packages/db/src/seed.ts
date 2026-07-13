import { loadConfig } from "@aibroker/core";
import { validateToolMetadata } from "@aibroker/mcp-tools";
import { hashPassword } from "@aibroker/auth";
import { BUILT_IN_PLUGINS, wordpressPlugin } from "@aibroker/plugin-catalog";
import { materializePluginIntent, type AccessLevel, type BrokerPlugin, type PolicyPluginIntent } from "@aibroker/plugin-sdk";
import { createPool } from "./pool.js";

const PLUGINS: BrokerPlugin[] = [...BUILT_IN_PLUGINS];
const PLUGIN_BY_KEY = new Map(PLUGINS.map((plugin) => [plugin.key, plugin]));

export async function seedToolDefinitions(connectionString: string): Promise<void> {
  const pool = createPool(connectionString);
  try {
    // Refuse to seed a catalog with incomplete metadata: an enabled tool without full
    // domain/action/risk/executor metadata cannot be placed in the permission matrix.
    for (const plugin of PLUGINS) {
      await pool.query(
      `insert into plugins (key,name,version,description,cardinality,min_role_to_enable,config_schema,credential_kinds,domains,access_levels)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb)
       on conflict(key) do update set name=excluded.name,version=excluded.version,description=excluded.description,
         cardinality=excluded.cardinality,min_role_to_enable=excluded.min_role_to_enable,config_schema=excluded.config_schema,
         credential_kinds=excluded.credential_kinds,domains=excluded.domains,access_levels=excluded.access_levels,updated_at=now()`,
        [plugin.key, plugin.name, plugin.version, plugin.description,
         plugin.cardinality, plugin.minRoleToEnable, JSON.stringify(plugin.configSchema),
         JSON.stringify(plugin.credentialKinds), JSON.stringify(plugin.domains),
         JSON.stringify(plugin.accessLevels)]
      );
      const catalog = plugin.tools;
      const problems = catalog.flatMap((tool) => validateToolMetadata(tool.name, tool));
      if (problems.length) throw new Error(`Refusing to seed tools with incomplete metadata:\n${problems.join("\n")}`);

      for (const tool of catalog) {
        await pool.query(
        `insert into tool_definitions (
          name, version, category, input_schema, output_schema, is_write, is_enabled,
          domain, action, risk, reversible, executor_kind, credential_kinds,
          supports_dry_run, is_long_running, description, constraints_schema, plugin_key, updated_at
        ) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,true,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16::jsonb,$17,now())
        on conflict (name, version) do update set
          category = excluded.category,
          input_schema = excluded.input_schema,
          output_schema = excluded.output_schema,
          is_write = excluded.is_write,
          is_enabled = excluded.is_enabled,
          domain = excluded.domain,
          action = excluded.action,
          risk = excluded.risk,
          reversible = excluded.reversible,
          executor_kind = excluded.executor_kind,
          credential_kinds = excluded.credential_kinds,
          supports_dry_run = excluded.supports_dry_run,
          is_long_running = excluded.is_long_running,
          description = excluded.description,
          constraints_schema = excluded.constraints_schema,
          plugin_key = excluded.plugin_key,
          updated_at = now()`,
        [
          tool.name,
          tool.version,
          tool.category,
          JSON.stringify(tool.inputSchema),
          JSON.stringify(tool.outputSchema),
          tool.isWrite,
          tool.domain,
          tool.action,
          tool.risk,
          tool.reversible,
          tool.executorKind,
          JSON.stringify(tool.credentialKinds),
          tool.supportsDryRun,
          tool.isLongRunning,
          tool.description,
          tool.constraintsSchema ? JSON.stringify(tool.constraintsSchema) : null,
          plugin.key
        ]
        );
      }
    }

    // On a fresh baseline (no bindings configured yet) the whole catalog is reviewed. Once
    // access is configured, a subsequently added tool stays unreviewed and ungranted until
    // an administrator reviews it — new authority never lands silently on existing policies.
    await pool.query(
      "update tool_definitions set reviewed = true where reviewed = false and not exists (select 1 from server_bindings)"
    );

    await seedBuiltInPolicies(pool);
    await rematerializeStoredIntents(pool);
  } finally {
    await pool.end();
  }
}

async function rematerializeStoredIntents(pool: ReturnType<typeof createPool>): Promise<void> {
  const reviewed = await pool.query<{ name: string }>("select name from tool_definitions where is_enabled=true and reviewed=true");
  const reviewedTools = new Set(reviewed.rows.map((row) => row.name));
  const stored = await pool.query<{
    id: string; policy_id: string; plugin_key: string; instance_name: string | null; mode: "simple" | "advanced";
    access_level: AccessLevel; risk_ceiling: PolicyPluginIntent["riskCeiling"]; grants: Record<string, string[]>;
    denied_tools: string[]; constraints: Record<string, Record<string, unknown>>;
  }>("select id,policy_id,plugin_key,instance_name,mode,access_level,risk_ceiling,grants,denied_tools,constraints from policy_plugin_intents");
  for (const row of stored.rows) {
    const plugin = PLUGIN_BY_KEY.get(row.plugin_key);
    if (!plugin) continue;
    const intent: PolicyPluginIntent = {
      pluginKey: row.plugin_key, instanceName: row.instance_name, mode: row.mode, accessLevel: row.access_level,
      riskCeiling: row.risk_ceiling, grants: row.grants ?? {}, deniedTools: row.denied_tools ?? [], constraints: row.constraints ?? {}
    };
    await pool.query("delete from policy_permissions where policy_intent_id=$1", [row.id]);
    for (const permission of materializePluginIntent(plugin, intent, reviewedTools)) {
      await pool.query(
        `insert into policy_permissions(policy_id,tool_name,effect,constraints,policy_intent_id,instance_name,risk_ceiling)
         values($1,$2,$3,$4::jsonb,$5,$6,$7)`,
        [row.policy_id, permission.toolName, permission.effect, JSON.stringify(permission.constraints), row.id,
         row.instance_name, permission.riskCeiling]
      );
    }
  }
}

async function seedBuiltInPolicies(pool: ReturnType<typeof createPool>): Promise<void> {
  const reviewed = await pool.query<{ name: string }>("select name from tool_definitions where is_enabled=true and reviewed=true");
  const reviewedTools = new Set(reviewed.rows.map((row) => row.name));
  const personas: Array<{ name: string; description: string; level: AccessLevel }> = [
    { name: "Read only", description: "Explore WordPress without changing anything.", level: "read" },
    { name: "Content contributors", description: "Create new drafts without changing or removing existing work.", level: "contribute" },
    { name: "WordPress managers", description: "Manage the WordPress application without critical host-level operations.", level: "manage" },
    { name: "Break-glass WordPress", description: "Full WordPress access, including critical and Operate tools.", level: "full" },
    { name: "Denied", description: "No WordPress access. Default deny remains in force.", level: "none" }
  ];

  for (const persona of personas) {
    const policy = await pool.query<{ id: string; seed_intent: boolean }>(
      `insert into policies (name, description, built_in)
       values ($1, $2, true)
       on conflict (name) do update set description = excluded.description, built_in = true, updated_at = now()
       returning id, ((xmax = 0) or not exists(select 1 from server_bindings)) as seed_intent`,
      [persona.name, persona.description]
    );
    const policyId = policy.rows[0]!.id;
    if (!policy.rows[0]!.seed_intent) continue;
    const level = wordpressPlugin.accessLevels[persona.level];
    const intent: PolicyPluginIntent = {
      pluginKey: wordpressPlugin.key,
      mode: "simple",
      accessLevel: persona.level,
      riskCeiling: level.riskCeiling
    };
    const stored = await pool.query<{ id: string }>(
      `insert into policy_plugin_intents(policy_id,plugin_key,mode,access_level,risk_ceiling)
       values($1,$2,'simple',$3,$4)
       on conflict(policy_id,plugin_key,instance_name) do update set mode='simple',access_level=excluded.access_level,
         risk_ceiling=excluded.risk_ceiling,grants='{}',denied_tools='[]',constraints='{}',updated_at=now()
       returning id`,
      [policyId, wordpressPlugin.key, persona.level, level.riskCeiling]
    );
    await pool.query("delete from policy_permissions where policy_id=$1", [policyId]);
    for (const permission of materializePluginIntent(wordpressPlugin, intent, reviewedTools)) {
      await pool.query(
        `insert into policy_permissions(policy_id,tool_name,effect,constraints,policy_intent_id,risk_ceiling)
         values($1,$2,$3,$4::jsonb,$5,$6)`,
        [policyId, permission.toolName, permission.effect, JSON.stringify(permission.constraints), stored.rows[0]!.id, permission.riskCeiling]
      );
    }
  }

  // Retire the pre-Phase-1 built-in policies, but only when they are genuinely unused: a
  // fresh install created them empty (they were populated by the old seed at runtime, no
  // longer), while an upgraded database keeps whatever rows and bindings it already has.
  await pool.query(
    `delete from policies
     where built_in = true
       and name not in ('Read only', 'Content contributors', 'WordPress managers', 'Break-glass WordPress', 'Denied')
       and not exists (select 1 from policy_permissions pp where pp.policy_id = policies.id)
       and not exists (select 1 from server_bindings sb where sb.policy_id = policies.id)`
  );
}

export async function seedDevelopmentAdmin(connectionString: string, env = process.env): Promise<void> {
  const email = env.AIBROKER_SEED_ADMIN_EMAIL;
  const password = env.AIBROKER_SEED_ADMIN_PASSWORD;
  const displayName = env.AIBROKER_SEED_ADMIN_NAME ?? "AIBroker Admin";
  if (!email || !password) {
    console.log("Skipping admin seed because AIBROKER_SEED_ADMIN_EMAIL or AIBROKER_SEED_ADMIN_PASSWORD is unset");
    return;
  }

  const pool = createPool(connectionString);
  try {
    const passwordHash = await hashPassword(password);
    await pool.query(
      `insert into users (email, display_name, password_hash, password_change_required, role, status)
       values ($1, $2, $3, true, 'global_admin', 'active')
       on conflict (email) do nothing`,
      [email.trim().toLowerCase(), displayName, passwordHash]
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  await seedToolDefinitions(config.databaseUrl);
  await seedDevelopmentAdmin(config.databaseUrl);
  console.log(`Seeded ${PLUGINS.reduce((count, plugin) => count + plugin.tools.length, 0)} tool definitions`);
}
