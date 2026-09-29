import {
  validateToolMetadata,
  type CredentialKind,
  type ExecutorKind,
  type ToolAction,
  type ToolCatalogMetadata,
  type ToolDomain,
  type ToolRisk
} from "./catalog.js";
import { REST_TOOL_DEFINITIONS } from "./rest-definitions.js";
import { PAGE_BUILDER_TOOL_DEFINITIONS } from "./page-builder-definitions.js";
import { HOST_SESSION_TOOL_DEFINITIONS, HOST_TOOL_DEFINITIONS, WORKSPACE_TOOL_DEFINITIONS } from "./host-definitions.js";
import { HOSTING_TOOL_DEFINITIONS, MULTISITE_TOOL_DEFINITIONS, RECOVERY_TOOL_DEFINITIONS } from "./operations-definitions.js";

export interface ToolDefinition {
  name: string;
  version: number;
  category: "read" | "write" | "diagnostic";
  isWrite: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  // Catalog metadata (WPB-ACCESS Phase 1). The permission matrix and authorization
  // documentation are driven by these fields, never by tool-name prefixes.
  domain: ToolDomain;
  action: ToolAction;
  risk: ToolRisk;
  reversible: boolean;
  executorKind: ExecutorKind;
  credentialKinds: CredentialKind[];
  supportsDryRun: boolean;
  isLongRunning: boolean;
  description: string;
  constraintsSchema?: Record<string, unknown>;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required
});

const REST_CRED: CredentialKind[] = ["wordpress_rest_application_password"];
const SSH_CRED: CredentialKind[] = ["ssh_private_key"];

// Per-tool catalog metadata, keyed by stable tool name. Every enabled tool must have a
// complete entry here; validateToolMetadata enforces it at build/seed time.
const METADATA: Record<string, ToolCatalogMetadata> = {
  "wordpress.list_sites": {
    domain: "site_settings",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "internal",
    credentialKinds: [],
    supportsDryRun: false,
    isLongRunning: false,
    description: "List WordPress servers the caller can access through a matching serverPlugin binding."
  },
  "wordpress.get_site_summary": {
    domain: "site_settings",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "Read summary identity and metadata for a single serverPlugin over the WordPress REST API."
  },
  "wordpress.list_pages": {
    domain: "content",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "List pages with optional status and search filters."
  },
  "wordpress.get_page": {
    domain: "content",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "Read a single page, optionally including rendered content."
  },
  "wordpress.create_draft_page": {
    domain: "content",
    action: "create",
    risk: "medium",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "Create a new draft page. Requires an idempotency key."
  },
  "wordpress.update_draft_page": {
    domain: "content",
    action: "change",
    risk: "medium",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "Update a draft page. Requires an expected revision id and idempotency key."
  },
  "wordpress.publish_page": {
    domain: "content",
    action: "change",
    risk: "medium",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "Transition a draft page to published state."
  },
  "wordpress.list_posts": {
    domain: "content",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "List posts with pagination."
  },
  "wordpress.get_post": {
    domain: "content",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "Read a single post, optionally including rendered content."
  },
  "wordpress.list_media": {
    domain: "media",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "List media library items with pagination."
  },
  "wordpress.get_media": {
    domain: "media",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "Read a single media attachment's metadata."
  },
  "wordpress.list_taxonomies": {
    domain: "taxonomy",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "List the taxonomies exposed by the serverPlugin's REST API."
  },
  "wordpress.list_terms": {
    domain: "taxonomy",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "List terms within a taxonomy."
  },
  "wordpress.list_custom_post_types": {
    domain: "content",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "rest",
    credentialKinds: REST_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "List custom post types discoverable through the REST API."
  },
  "wordpress.list_plugins": {
    domain: "plugins",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "wp_cli",
    credentialKinds: SSH_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "List installed plugins, versions, and update availability."
  },
  "wordpress.list_themes": {
    domain: "themes",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "wp_cli",
    credentialKinds: SSH_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "List installed themes and their status."
  },
  "wordpress.get_active_theme": {
    domain: "themes",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "wp_cli",
    credentialKinds: SSH_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "Inspect the currently active theme."
  },
  "wordpress.run_health_check": {
    domain: "diagnostics_logs",
    action: "read",
    risk: "low",
    reversible: true,
    executorKind: "wp_cli",
    credentialKinds: SSH_CRED,
    supportsDryRun: false,
    isLongRunning: false,
    description: "Run a bounded serverPlugin-health diagnostic."
  }
};

function withMetadata(base: Omit<ToolDefinition, keyof ToolCatalogMetadata>): ToolDefinition {
  const meta = METADATA[base.name];
  const problems = validateToolMetadata(base.name, meta);
  if (problems.length) throw new Error(`Invalid tool metadata: ${problems.join("; ")}`);
  return { ...base, ...meta! };
}

const RAW_TOOL_DEFINITIONS: ToolDefinition[] = [
  withMetadata({
    name: "wordpress.list_sites",
    version: 1,
    category: "read",
    isWrite: false,
    inputSchema: objectSchema({
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      cursor: { type: ["string", "null"] }
    }),
    outputSchema: objectSchema({ servers: { type: "array" }, next_cursor: { type: ["string", "null"] } }, ["servers"])
  }),
  withMetadata({
    name: "wordpress.get_site_summary",
    version: 1,
    category: "read",
    isWrite: false,
    inputSchema: objectSchema({ server_plugin_id: { type: "string", format: "uuid" } }, ["server_plugin_id"]),
    outputSchema: objectSchema({ serverPlugin: { type: "object" } }, ["serverPlugin"])
  }),
  withMetadata({
    name: "wordpress.list_pages",
    version: 1,
    category: "read",
    isWrite: false,
    inputSchema: objectSchema(
      {
        server_plugin_id: { type: "string", format: "uuid" },
        status: { type: "array", items: { type: "string" }, default: ["publish"] },
        search: { type: ["string", "null"] },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        cursor: { type: ["string", "null"] }
      },
      ["server_plugin_id"]
    ),
    outputSchema: objectSchema({ pages: { type: "array" }, next_cursor: { type: ["string", "null"] } }, ["pages"])
  }),
  withMetadata({
    name: "wordpress.get_page",
    version: 1,
    category: "read",
    isWrite: false,
    inputSchema: objectSchema(
      {
        server_plugin_id: { type: "string", format: "uuid" },
        page_id: { type: "string" },
        include_content: { type: "boolean", default: true }
      },
      ["server_plugin_id", "page_id"]
    ),
    outputSchema: objectSchema({ page: { type: "object" } }, ["page"])
  }),
  withMetadata({
    name: "wordpress.create_draft_page",
    version: 1,
    category: "write",
    isWrite: true,
    inputSchema: objectSchema(
      {
        server_plugin_id: { type: "string", format: "uuid" },
        title: { type: "string", minLength: 1 },
        slug: { type: ["string", "null"] },
        content: { type: "string" },
        idempotency_key: { type: "string", minLength: 16 }
      },
      ["server_plugin_id", "title", "content", "idempotency_key"]
    ),
    outputSchema: objectSchema({ page: { type: "object" }, idempotency_key: { type: "string" } }, ["page", "idempotency_key"])
  }),
  withMetadata({
    name: "wordpress.update_draft_page",
    version: 1,
    category: "write",
    isWrite: true,
    inputSchema: objectSchema(
      {
        server_plugin_id: { type: "string", format: "uuid" },
        page_id: { type: "string" },
        title: { type: ["string", "null"] },
        content: { type: ["string", "null"] },
        expected_revision_id: { type: "string" },
        idempotency_key: { type: "string", minLength: 16 }
      },
      ["server_plugin_id", "page_id", "expected_revision_id", "idempotency_key"]
    ),
    outputSchema: objectSchema({ page: { type: "object" }, idempotency_key: { type: "string" } }, ["page", "idempotency_key"])
  }),
  withMetadata({
    name: "wordpress.publish_page",
    version: 1,
    category: "write",
    isWrite: true,
    inputSchema: objectSchema(
      {
        server_plugin_id: { type: "string", format: "uuid" },
        page_id: { type: "string" },
        idempotency_key: { type: "string", minLength: 16 }
      },
      ["server_plugin_id", "page_id", "idempotency_key"]
    ),
    outputSchema: objectSchema({ page: { type: "object" } }, ["page"])
  }),
  ...[
    "wordpress.list_posts",
    "wordpress.get_post",
    "wordpress.list_media",
    "wordpress.get_media",
    "wordpress.list_taxonomies",
    "wordpress.list_terms",
    "wordpress.list_custom_post_types"
  ].map((name): ToolDefinition =>
    withMetadata({
      name,
      version: 1,
      category: "read",
      isWrite: false,
      inputSchema: objectSchema({
        server_plugin_id: { type: "string", format: "uuid" },
        id: { type: ["string", "null"] },
        taxonomy: { type: ["string", "null"] },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        cursor: { type: ["string", "null"] }
      }, ["server_plugin_id"]),
      outputSchema: objectSchema({ result: { type: "object" } }, ["result"])
    })
  ),
  ...[
    "wordpress.list_plugins",
    "wordpress.list_themes",
    "wordpress.get_active_theme",
    "wordpress.run_health_check"
  ].map((name): ToolDefinition =>
    withMetadata({
      name,
      version: 1,
      category: "diagnostic",
      isWrite: false,
      inputSchema: objectSchema({ server_plugin_id: { type: "string", format: "uuid" } }, ["server_plugin_id"]),
      outputSchema: objectSchema({ result: { type: "object" } }, ["result"])
    })
  ),
  ...REST_TOOL_DEFINITIONS,
  ...PAGE_BUILDER_TOOL_DEFINITIONS,
  ...HOST_TOOL_DEFINITIONS,
  ...WORKSPACE_TOOL_DEFINITIONS,
  ...HOST_SESSION_TOOL_DEFINITIONS,
  ...RECOVERY_TOOL_DEFINITIONS,
  ...HOSTING_TOOL_DEFINITIONS,
  ...MULTISITE_TOOL_DEFINITIONS
];

// Some focused definition modules intentionally supersede the original MVP shapes.
// Publish one stable definition per name/version, preferring the later plugin-owned form.
export const MVP_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...new Map(RAW_TOOL_DEFINITIONS.map((tool) => [`${tool.name}@${tool.version}`, tool])).values()
];
