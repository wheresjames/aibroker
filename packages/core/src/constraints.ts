export type ConstraintValue = string[] | number;
export type ConstraintMap = Record<string, ConstraintValue>;

const CONSTRAINT_TOOLS: Record<string, Set<string>> = {
  requiredBackupMaxAgeHours: new Set(["backup_restore", "deployment_snapshot_restore", "database_optimize", "database_import", "database_search_replace", "database_restore_snapshot", "hosting_deploy", "hosting_rollback", "network_update_core_database", "network_migrate_domain"]),
  "rateLimit.callsPerMinute": new Set([
    "wordpress.get_site_summary",
    "wordpress.list_pages",
    "wordpress.get_page",
    "wordpress.list_posts",
    "wordpress.get_post",
    "wordpress.list_media",
    "wordpress.get_media",
    "wordpress.list_taxonomies",
    "wordpress.list_terms",
    "wordpress.list_custom_post_types",
    "wordpress.list_plugins",
    "wordpress.list_themes",
    "wordpress.get_active_theme",
    "wordpress.run_health_check",
    "wordpress.create_draft_page",
    "wordpress.update_draft_page",
    "wordpress.publish_page"
  ]),
  maxResults: new Set(["wordpress.list_pages", "wordpress.list_posts", "wordpress.list_media", "wordpress.list_terms", "wordpress.list_custom_post_types"]),
  allowedStatuses: new Set(["wordpress.list_pages", "wordpress.list_posts"]),
  allowedTaxonomy: new Set(["wordpress.list_terms"])
};

const NUMERIC_KEYS = new Set(["rateLimit.callsPerMinute", "maxResults", "requiredBackupMaxAgeHours"]);
const ARRAY_KEYS = new Set(["allowedStatuses", "allowedTaxonomy"]);

export function normalizeConstraints(raw: unknown): ConstraintMap {
  if (!isPlainObject(raw)) return {};
  const normalized: ConstraintMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "rateLimit" && isPlainObject(value) && value.callsPerMinute != null) {
      normalized["rateLimit.callsPerMinute"] = value.callsPerMinute as ConstraintValue;
      continue;
    }
    normalized[key] = value as ConstraintValue;
  }
  return normalized;
}

export function validateConstraints(toolName: string, raw: unknown): ConstraintMap {
  const constraints = normalizeConstraints(raw);
  for (const [key, value] of Object.entries(constraints)) {
    const appliesTo = knownConstraintTools(key);
    if (!appliesTo.has(toolName)) throw new Error(`constraint_not_applicable:${key}`);
    validateConstraintValue(key, value);
  }
  return constraints;
}

export function validateBindingConstraints(raw: unknown): ConstraintMap {
  const constraints = normalizeConstraints(raw);
  for (const [key, value] of Object.entries(constraints)) {
    knownConstraintTools(key);
    validateConstraintValue(key, value);
  }
  return constraints;
}

export function intersectConstraints(toolName: string, policyRaw: unknown, bindingRaw: unknown): ConstraintMap {
  const policy = validateConstraints(toolName, policyRaw);
  const binding = applicableBindingConstraints(toolName, bindingRaw);
  const merged: ConstraintMap = { ...policy };

  for (const [key, bindingValue] of Object.entries(binding)) {
    const policyValue = policy[key];
    if (NUMERIC_KEYS.has(key)) {
      if (policyValue != null && (bindingValue as number) > (policyValue as number)) {
        throw new Error(`constraint_widening:${key}`);
      }
      merged[key] = policyValue == null ? bindingValue : Math.min(policyValue as number, bindingValue as number);
      continue;
    }

    const bindingArray = bindingValue as string[];
    if (policyValue == null) {
      merged[key] = [...bindingArray];
      continue;
    }
    const policySet = new Set(policyValue as string[]);
    if (bindingArray.some((item) => !policySet.has(item))) {
      throw new Error(`constraint_widening:${key}`);
    }
    merged[key] = bindingArray.filter((item) => policySet.has(item));
  }

  return merged;
}

function applicableBindingConstraints(toolName: string, raw: unknown): ConstraintMap {
  const constraints = validateBindingConstraints(raw);
  const applicable: ConstraintMap = {};
  for (const [key, value] of Object.entries(constraints)) {
    if (knownConstraintTools(key).has(toolName)) applicable[key] = value;
  }
  return applicable;
}

export function constraintsAllowInput(constraints: ConstraintMap, input: Record<string, unknown>): boolean {
  const maxResults = constraints.maxResults;
  if (typeof maxResults === "number" && typeof input.limit === "number" && input.limit > maxResults) return false;

  const statuses = constraints.allowedStatuses;
  if (Array.isArray(statuses) && input.status != null) {
    const requested = Array.isArray(input.status) ? input.status.map(String) : [String(input.status)];
    if (requested.some((status) => !statuses.includes(status))) return false;
  }

  const taxonomies = constraints.allowedTaxonomy;
  if (Array.isArray(taxonomies) && input.taxonomy != null && !taxonomies.includes(String(input.taxonomy))) return false;

  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function knownConstraintTools(key: string): Set<string> {
  const appliesTo = CONSTRAINT_TOOLS[key];
  if (!appliesTo) throw new Error(`unknown_constraint:${key}`);
  return appliesTo;
}

function validateConstraintValue(key: string, value: ConstraintValue): void {
  if (NUMERIC_KEYS.has(key) && (!Number.isInteger(value) || (value as number) <= 0)) {
    throw new Error(`invalid_constraint:${key}`);
  }
  if (ARRAY_KEYS.has(key) && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
    throw new Error(`invalid_constraint:${key}`);
  }
}
