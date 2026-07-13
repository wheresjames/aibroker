import { constraintsAllowInput, intersectConstraints, type ConstraintMap } from "@aibroker/core";

export type GrantEffect = "allow" | "deny";
export type GrantSubjectType = "user" | "group";

export interface PolicyBindingMatch {
  bindingId: string;
  subjectType: GrantSubjectType;
  subjectId: string;
  serverId: string;
  policyId: string;
  policyName: string;
  policyBuiltIn: boolean;
  permissionId: string;
  toolName: string;
  effect: GrantEffect;
  policyConstraints: Record<string, unknown>;
  bindingConstraints: Record<string, unknown>;
  effectiveConstraints: ConstraintMap;
}

export interface PolicyRequest {
  userId: string;
  role: "global_admin" | "team_admin" | "auditor" | "user" | string;
  groupIds: string[];
  server: {
    id: string;
    status?: string;
  };
  toolName: string;
  pluginKey?: string;
  instanceName?: string | null;
  toolRisk?: "low" | "medium" | "high" | "critical";
  toolDomain?: string;
  toolAction?: string;
  isWrite: boolean;
  input?: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  matchedBinding?: PolicyBindingMatch;
  matchedBindings: PolicyBindingMatch[];
  effectiveConstraints: ConstraintMap;
}

export interface PolicyQueryHandle {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

interface PermissionRow {
  binding_id: string;
  subject_type: GrantSubjectType;
  subject_id: string;
  server_id: string;
  policy_id: string;
  policy_name: string;
  policy_built_in: boolean;
  permission_id: string;
  tool_name: string;
  effect: GrantEffect;
  policy_constraints: Record<string, unknown>;
  binding_constraints: Record<string, unknown>;
  risk_ceiling?: "low" | "medium" | "high" | "critical" | null;
  tool_risk?: "low" | "medium" | "high" | "critical" | null;
}

const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;

export async function evaluatePolicy(db: PolicyQueryHandle, request: PolicyRequest): Promise<PolicyDecision> {
  if (request.server.status === "disabled") {
    return denied("server_disabled");
  }
  const result = await db.query<PermissionRow>(
    `select
       sb.id as binding_id,
       sb.subject_type,
       sb.subject_id,
       sb.server_id,
       p.id as policy_id,
       p.name as policy_name,
       p.built_in as policy_built_in,
       pp.id as permission_id,
       pp.tool_name,
       pp.effect,
       pp.constraints as policy_constraints,
       sb.constraints as binding_constraints,
       pp.risk_ceiling,
       td.risk as tool_risk
     from server_bindings sb
     join policies p on p.id = sb.policy_id
     join policy_permissions pp on pp.policy_id = p.id
     join tool_definitions td on td.name = pp.tool_name and td.is_enabled = true
     where sb.server_id = $1
       and pp.tool_name = $2
       and (
         $5::text is null
         or pp.instance_name = $5
         or (pp.instance_name is null and not exists (
           select 1 from policy_plugin_intents override_intent
           where override_intent.policy_id=p.id and override_intent.plugin_key=$6 and override_intent.instance_name=$5
         ))
       )
       and (
         (sb.subject_type = 'user' and sb.subject_id = $3)
         or (sb.subject_type = 'group' and sb.subject_id = any($4::uuid[]))
       )
     order by pp.effect desc, sb.created_at`,
    [request.server.id, request.toolName, request.userId, request.groupIds, request.instanceName ?? null, request.pluginKey ?? null]
  );

  const matchedBindings: PolicyBindingMatch[] = [];
  for (const row of result.rows) {
    try {
      matchedBindings.push({
        bindingId: row.binding_id,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        serverId: row.server_id,
        policyId: row.policy_id,
        policyName: row.policy_name,
        policyBuiltIn: row.policy_built_in,
        permissionId: row.permission_id,
        toolName: row.tool_name,
        effect: row.effect,
        policyConstraints: row.policy_constraints ?? {},
        bindingConstraints: row.binding_constraints ?? {},
        effectiveConstraints: intersectConstraints(request.toolName, row.policy_constraints ?? {}, row.binding_constraints ?? {})
      });
    } catch {
      matchedBindings.push({
        bindingId: row.binding_id,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        serverId: row.server_id,
        policyId: row.policy_id,
        policyName: row.policy_name,
        policyBuiltIn: row.policy_built_in,
        permissionId: row.permission_id,
        toolName: row.tool_name,
        effect: "deny",
        policyConstraints: row.policy_constraints ?? {},
        bindingConstraints: row.binding_constraints ?? {},
        effectiveConstraints: {}
      });
    }
  }

  const deny = matchedBindings.find((binding) => binding.effect === "deny");
  if (deny) {
    return { allowed: false, reason: "explicit_deny", matchedBinding: deny, matchedBindings, effectiveConstraints: deny.effectiveConstraints };
  }

  const allowedRows = result.rows.filter((row) => row.effect === "allow");
  const withinRisk = (row: PermissionRow) => {
    const risk = request.toolRisk ?? row.tool_risk;
    return !risk || !row.risk_ceiling || RISK_RANK[risk] <= RISK_RANK[row.risk_ceiling];
  };
  const allowIndex = result.rows.findIndex((row, index) => row.effect === "allow" && withinRisk(row)
    && constraintsAllowInput(matchedBindings[index]!.effectiveConstraints, request.input ?? {}));
  const allow = allowIndex >= 0 ? matchedBindings[allowIndex] : undefined;
  if (allow) {
    return { allowed: true, reason: "policy_allow", matchedBinding: allow, matchedBindings, effectiveConstraints: allow.effectiveConstraints };
  }

  if (allowedRows.length && allowedRows.every((row) => !withinRisk(row))) {
    return { allowed: false, reason: "risk_ceiling", matchedBindings, effectiveConstraints: {} };
  }

  if (matchedBindings.some((binding) => binding.effect === "allow")) {
    return { allowed: false, reason: "constraint_failed", matchedBindings, effectiveConstraints: {} };
  }

  if (request.pluginKey && request.toolRisk && request.toolDomain && request.toolAction) {
    const intentMatches = await db.query<{ risk_ceiling: keyof typeof RISK_RANK | null }>(
      `select pi.risk_ceiling
       from server_bindings sb
       join policy_plugin_intents pi on pi.policy_id=sb.policy_id and pi.plugin_key=$5
       join plugins plugin on plugin.key=pi.plugin_key
       where sb.server_id=$1
         and ((sb.subject_type='user' and sb.subject_id=$2) or (sb.subject_type='group' and sb.subject_id=any($3::uuid[])))
         and (
           $4::text is null or pi.instance_name=$4
           or (pi.instance_name is null and not exists (
             select 1 from policy_plugin_intents override_intent
             where override_intent.policy_id=pi.policy_id and override_intent.plugin_key=pi.plugin_key and override_intent.instance_name=$4
           ))
         )
         and (
           (pi.mode='simple' and (plugin.access_levels -> pi.access_level -> 'toolNames') ? $6)
           or (pi.mode='advanced' and coalesce((pi.grants -> $7) ? $8,false))
         )`,
      [request.server.id, request.userId, request.groupIds, request.instanceName ?? null, request.pluginKey,
       request.toolName, request.toolDomain, request.toolAction]
    );
    if (intentMatches.rows.length && intentMatches.rows.every((row) => row.risk_ceiling !== null
      && RISK_RANK[request.toolRisk!] > RISK_RANK[row.risk_ceiling!])) {
      return { allowed: false, reason: "risk_ceiling", matchedBindings, effectiveConstraints: {} };
    }
  }

  return { allowed: false, reason: "not_granted", matchedBindings, effectiveConstraints: {} };
}

function denied(reason: string): PolicyDecision {
  return { allowed: false, reason, matchedBindings: [], effectiveConstraints: {} };
}
