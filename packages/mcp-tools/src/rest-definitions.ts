import { validateToolMetadata, type CredentialKind, type ToolAction, type ToolDomain, type ToolRisk } from "./catalog.js";
import type { ToolDefinition } from "./definitions.js";

// Typed WordPress REST tools. Each definition carries full catalog metadata so it
// lands in the permission matrix under the right domain/action/risk with no name-based
// inference, and starts ungranted until an administrator reviews it.

const REST: CredentialKind[] = ["wordpress_rest_application_password"];

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required
});

const SITE = { server_plugin_id: { type: "string", format: "uuid" } };
const IDEMPOTENT = { idempotency_key: { type: "string", minLength: 16 } };
const RESULT_OUT = obj({ result: { type: "object" } }, ["result"]);

interface Meta {
  domain: ToolDomain;
  action: ToolAction;
  risk: ToolRisk;
  reversible: boolean;
  isWrite: boolean;
  description: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  credentials?: CredentialKind[];
}

function def(name: string, meta: Meta): ToolDefinition {
  const definition: ToolDefinition = {
    name,
    version: 1,
    category: meta.isWrite ? "write" : "read",
    isWrite: meta.isWrite,
    inputSchema: meta.input,
    outputSchema: meta.output ?? RESULT_OUT,
    domain: meta.domain,
    action: meta.action,
    risk: meta.risk,
    reversible: meta.reversible,
    executorKind: "rest",
    credentialKinds: meta.credentials ?? REST,
    supportsDryRun: false,
    isLongRunning: false,
    description: meta.description
  };
  const problems = validateToolMetadata(name, definition);
  if (problems.length) throw new Error(`Invalid REST tool metadata: ${problems.join("; ")}`);
  return definition;
}

// Content type param shared by the generalized content engine (post | page | CPT rest_base).
const CONTENT_TYPE = { type: { type: "string", minLength: 1, default: "post" } };

export const REST_TOOL_DEFINITIONS: ToolDefinition[] = [
  // --- Content & revisions ---
  def("wordpress.list_content", {
    domain: "content", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "List posts, pages, or a discovered REST-visible custom post type.",
    input: obj({ ...SITE, ...CONTENT_TYPE, status: { type: ["string", "null"] }, search: { type: ["string", "null"] }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, cursor: { type: ["string", "null"] } }, ["server_plugin_id"])
  }),
  def("wordpress.get_content", {
    domain: "content", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "Read a post, page, or discovered REST-visible custom post type entry.",
    input: obj({ ...SITE, ...CONTENT_TYPE, id: { type: "string" } }, ["server_plugin_id", "id"])
  }),
  def("wordpress.create_content", {
    domain: "content", action: "create", risk: "medium", reversible: true, isWrite: true,
    description: "Create a post, page, or custom post type entry in any status (draft/pending/private/future/publish).",
    input: obj({ ...SITE, ...CONTENT_TYPE, title: { type: "string" }, content: { type: "string" }, excerpt: { type: ["string", "null"] }, slug: { type: ["string", "null"] }, status: { type: "string", default: "draft" }, author: { type: ["integer", "null"] }, parent: { type: ["integer", "null"] }, template: { type: ["string", "null"] }, sticky: { type: ["boolean", "null"] }, featured_media: { type: ["integer", "null"] }, ...IDEMPOTENT }, ["server_plugin_id", "idempotency_key"])
  }),
  def("wordpress.update_content", {
    domain: "content", action: "change", risk: "medium", reversible: true, isWrite: true,
    description: "Update an existing content item. Requires the expected revision id to avoid overwriting concurrent edits.",
    input: obj({ ...SITE, ...CONTENT_TYPE, id: { type: "string" }, title: { type: ["string", "null"] }, content: { type: ["string", "null"] }, excerpt: { type: ["string", "null"] }, slug: { type: ["string", "null"] }, expected_revision_id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "expected_revision_id", "idempotency_key"])
  }),
  def("wordpress.set_content_status", {
    domain: "content", action: "change", risk: "medium", reversible: true, isWrite: true,
    description: "Transition a content item to a new status (draft/pending/private/future/publish).",
    input: obj({ ...SITE, ...CONTENT_TYPE, id: { type: "string" }, status: { type: "string" }, expected_revision_id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "status", "expected_revision_id", "idempotency_key"])
  }),
  def("wordpress.set_featured_media", {
    domain: "content", action: "change", risk: "low", reversible: true, isWrite: true,
    description: "Set or clear the featured media (image) for a content item.",
    input: obj({ ...SITE, ...CONTENT_TYPE, id: { type: "string" }, media_id: { type: ["integer", "null"] }, expected_revision_id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "expected_revision_id", "idempotency_key"])
  }),
  def("wordpress.trash_content", {
    domain: "content", action: "remove", risk: "medium", reversible: true, isWrite: true,
    description: "Move a content item to the trash (reversible).",
    input: obj({ ...SITE, ...CONTENT_TYPE, id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),
  def("wordpress.restore_trashed_content", {
    domain: "content", action: "change", risk: "low", reversible: true, isWrite: true,
    description: "Restore a trashed content item back to draft.",
    input: obj({ ...SITE, ...CONTENT_TYPE, id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),
  def("wordpress.delete_content_permanently", {
    domain: "content", action: "remove", risk: "high", reversible: false, isWrite: true,
    description: "Permanently delete a content item. Irreversible; a separate permission from trash.",
    input: obj({ ...SITE, ...CONTENT_TYPE, id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),
  def("wordpress.batch_create_content", {
    domain: "content", action: "create", risk: "medium", reversible: true, isWrite: true,
    description: "Create up to 25 content items in one bounded batch.",
    input: obj({ ...SITE, ...CONTENT_TYPE, items: { type: "array", maxItems: 25, items: { type: "object" } }, ...IDEMPOTENT }, ["server_plugin_id", "items", "idempotency_key"])
  }),
  def("wordpress.list_revisions", {
    domain: "content", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "List revisions for a content item.",
    input: obj({ ...SITE, ...CONTENT_TYPE, id: { type: "string" } }, ["server_plugin_id", "id"])
  }),
  def("wordpress.get_revision", {
    domain: "content", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "Read a single revision of a content item.",
    input: obj({ ...SITE, ...CONTENT_TYPE, id: { type: "string" }, revision_id: { type: "string" } }, ["server_plugin_id", "id", "revision_id"])
  }),
  def("wordpress.restore_revision", {
    domain: "content", action: "change", risk: "medium", reversible: true, isWrite: true,
    description: "Restore a content item to a prior revision's title/content/excerpt.",
    input: obj({ ...SITE, ...CONTENT_TYPE, id: { type: "string" }, revision_id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "revision_id", "idempotency_key"])
  }),

  // --- Media ---
  def("wordpress.get_media", {
    domain: "media", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "Read one media attachment and its metadata.",
    input: obj({ ...SITE, id: { type: "string" } }, ["server_plugin_id", "id"])
  }),
  def("wordpress.search_media", {
    domain: "media", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "Search the media library by term, media type, or MIME type.",
    input: obj({ ...SITE, search: { type: ["string", "null"] }, media_type: { type: ["string", "null"] }, mime_type: { type: ["string", "null"] }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, cursor: { type: ["string", "null"] } }, ["server_plugin_id"])
  }),
  def("wordpress.update_media", {
    domain: "media", action: "change", risk: "low", reversible: true, isWrite: true,
    description: "Update media title, caption, alt text, or description.",
    input: obj({ ...SITE, id: { type: "string" }, title: { type: ["string", "null"] }, caption: { type: ["string", "null"] }, alt_text: { type: ["string", "null"] }, description: { type: ["string", "null"] }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),
  def("wordpress.upload_media", {
    domain: "media", action: "create", risk: "medium", reversible: true, isWrite: true,
    description: "Upload media bytes (base64). Enforces a MIME allowlist and size limit.",
    input: obj({ ...SITE, filename: { type: "string", minLength: 1 }, mime_type: { type: "string", minLength: 1 }, data_base64: { type: "string", minLength: 1 }, title: { type: ["string", "null"] }, alt_text: { type: ["string", "null"] }, ...IDEMPOTENT }, ["server_plugin_id", "filename", "mime_type", "data_base64", "idempotency_key"])
  }),
  def("wordpress.ingest_media_from_url", {
    domain: "media", action: "create", risk: "medium", reversible: true, isWrite: true,
    description: "Fetch media from an allowed URL (SSRF-protected) and add it to the library.",
    input: obj({ ...SITE, url: { type: "string", minLength: 1 }, filename: { type: ["string", "null"] }, title: { type: ["string", "null"] }, ...IDEMPOTENT }, ["server_plugin_id", "url", "idempotency_key"])
  }),
  def("wordpress.trash_media", {
    domain: "media", action: "remove", risk: "medium", reversible: true, isWrite: true,
    description: "Move a media attachment to the trash.",
    input: obj({ ...SITE, id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),
  def("wordpress.delete_media_permanently", {
    domain: "media", action: "remove", risk: "high", reversible: false, isWrite: true,
    description: "Permanently delete a media attachment. Irreversible; separate from trash.",
    input: obj({ ...SITE, id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),

  // --- Taxonomy ---
  def("wordpress.get_term", {
    domain: "taxonomy", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "Read a single taxonomy term.",
    input: obj({ ...SITE, taxonomy: { type: "string" }, id: { type: "string" } }, ["server_plugin_id", "taxonomy", "id"])
  }),
  def("wordpress.create_term", {
    domain: "taxonomy", action: "create", risk: "low", reversible: true, isWrite: true,
    description: "Create a taxonomy term (category, tag, or custom).",
    input: obj({ ...SITE, taxonomy: { type: "string" }, name: { type: "string", minLength: 1 }, slug: { type: ["string", "null"] }, description: { type: ["string", "null"] }, parent: { type: ["integer", "null"] }, ...IDEMPOTENT }, ["server_plugin_id", "taxonomy", "name", "idempotency_key"])
  }),
  def("wordpress.update_term", {
    domain: "taxonomy", action: "change", risk: "low", reversible: true, isWrite: true,
    description: "Update a taxonomy term.",
    input: obj({ ...SITE, taxonomy: { type: "string" }, id: { type: "string" }, name: { type: ["string", "null"] }, slug: { type: ["string", "null"] }, description: { type: ["string", "null"] }, ...IDEMPOTENT }, ["server_plugin_id", "taxonomy", "id", "idempotency_key"])
  }),
  def("wordpress.delete_term", {
    domain: "taxonomy", action: "remove", risk: "medium", reversible: false, isWrite: true,
    description: "Delete a taxonomy term (terms have no trash; this is permanent).",
    input: obj({ ...SITE, taxonomy: { type: "string" }, id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "taxonomy", "id", "idempotency_key"])
  }),
  def("wordpress.assign_terms", {
    domain: "taxonomy", action: "change", risk: "low", reversible: true, isWrite: true,
    description: "Assign the given taxonomy terms to a content item (replaces the current set for that taxonomy).",
    input: obj({ ...SITE, ...CONTENT_TYPE, id: { type: "string" }, taxonomy_rest_base: { type: "string" }, term_ids: { type: "array", items: { type: "integer" } }, ...IDEMPOTENT }, ["server_plugin_id", "id", "taxonomy_rest_base", "term_ids", "idempotency_key"])
  }),

  // --- Comments ---
  def("wordpress.list_comments", {
    domain: "comments", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "List comments, optionally filtered by post or status. Personal data is minimized.",
    input: obj({ ...SITE, post: { type: ["string", "null"] }, status: { type: ["string", "null"] }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, cursor: { type: ["string", "null"] } }, ["server_plugin_id"])
  }),
  def("wordpress.get_comment", {
    domain: "comments", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "Read a single comment.",
    input: obj({ ...SITE, id: { type: "string" } }, ["server_plugin_id", "id"])
  }),
  def("wordpress.create_comment", {
    domain: "comments", action: "create", risk: "low", reversible: true, isWrite: true,
    description: "Create a comment or reply on a post.",
    input: obj({ ...SITE, post: { type: "string" }, content: { type: "string", minLength: 1 }, parent: { type: ["integer", "null"] }, ...IDEMPOTENT }, ["server_plugin_id", "post", "content", "idempotency_key"])
  }),
  def("wordpress.update_comment", {
    domain: "comments", action: "change", risk: "low", reversible: true, isWrite: true,
    description: "Edit a comment's content.",
    input: obj({ ...SITE, id: { type: "string" }, content: { type: "string", minLength: 1 }, ...IDEMPOTENT }, ["server_plugin_id", "id", "content", "idempotency_key"])
  }),
  def("wordpress.set_comment_status", {
    domain: "comments", action: "change", risk: "medium", reversible: true, isWrite: true,
    description: "Moderate a comment: approve, hold, spam, or trash.",
    input: obj({ ...SITE, id: { type: "string" }, status: { type: "string", enum: ["approve", "hold", "spam", "trash"] }, ...IDEMPOTENT }, ["server_plugin_id", "id", "status", "idempotency_key"])
  }),
  def("wordpress.restore_comment", {
    domain: "comments", action: "change", risk: "low", reversible: true, isWrite: true,
    description: "Restore a trashed or spammed comment to the held state.",
    input: obj({ ...SITE, id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),
  def("wordpress.delete_comment_permanently", {
    domain: "comments", action: "remove", risk: "high", reversible: false, isWrite: true,
    description: "Permanently delete a comment. Irreversible; separate permission.",
    input: obj({ ...SITE, id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),

  // --- Navigation & design ---
  def("wordpress.list_menus", {
    domain: "navigation_design", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "List navigation menus and their locations (WordPress 5.9+).",
    input: obj({ ...SITE }, ["server_plugin_id"])
  }),
  def("wordpress.create_menu", {
    domain: "navigation_design", action: "create", risk: "medium", reversible: true, isWrite: true,
    description: "Create a navigation menu.",
    input: obj({ ...SITE, name: { type: "string", minLength: 1 }, slug: { type: ["string", "null"] }, locations: { type: "array", items: { type: "string" } }, ...IDEMPOTENT }, ["server_plugin_id", "name", "idempotency_key"])
  }),
  def("wordpress.update_menu", {
    domain: "navigation_design", action: "change", risk: "medium", reversible: true, isWrite: true,
    description: "Change a navigation menu and its assigned locations.",
    input: obj({ ...SITE, id: { type: "string" }, name: { type: ["string", "null"] }, locations: { type: "array", items: { type: "string" } }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),
  def("wordpress.delete_menu", {
    domain: "navigation_design", action: "remove", risk: "medium", reversible: false, isWrite: true,
    description: "Permanently delete a navigation menu.",
    input: obj({ ...SITE, id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),
  def("wordpress.list_menu_items", {
    domain: "navigation_design", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "List items in a navigation menu.",
    input: obj({ ...SITE, menu: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 100 } }, ["server_plugin_id", "menu"])
  }),
  def("wordpress.create_menu_item", {
    domain: "navigation_design", action: "create", risk: "medium", reversible: true, isWrite: true,
    description: "Create an item in a navigation menu.",
    input: obj({ ...SITE, menu: { type: "integer" }, title: { type: "string" }, url: { type: "string" }, status: { type: "string", default: "publish" }, parent: { type: ["integer", "null"] }, ...IDEMPOTENT }, ["server_plugin_id", "menu", "title", "url", "idempotency_key"])
  }),
  def("wordpress.update_menu_item", {
    domain: "navigation_design", action: "change", risk: "medium", reversible: true, isWrite: true,
    description: "Change a navigation menu item.",
    input: obj({ ...SITE, id: { type: "string" }, title: { type: ["string", "null"] }, url: { type: ["string", "null"] }, parent: { type: ["integer", "null"] }, menu_order: { type: ["integer", "null"] }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),
  def("wordpress.delete_menu_item", {
    domain: "navigation_design", action: "remove", risk: "medium", reversible: false, isWrite: true,
    description: "Permanently delete a navigation menu item.",
    input: obj({ ...SITE, id: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),
  def("wordpress.list_templates", {
    domain: "navigation_design", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "List block-theme templates or template parts.",
    input: obj({ ...SITE, kind: { type: "string", enum: ["templates", "template-parts"], default: "templates" } }, ["server_plugin_id"])
  }),
  def("wordpress.get_active_theme", {
    domain: "navigation_design", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "Read the active theme via REST: stylesheet, whether it is a block theme, and the user global-styles id. Replaces the SSH-only discovery path.",
    input: obj({ ...SITE }, ["server_plugin_id"])
  }),
  def("wordpress.get_theme_global_styles", {
    domain: "navigation_design", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "Read a block theme's resolved global styles by stylesheet. Works before any customization has been saved (no numeric id needed).",
    input: obj({ ...SITE, stylesheet: { type: "string", minLength: 1 } }, ["server_plugin_id", "stylesheet"])
  }),
  def("wordpress.list_theme_style_variations", {
    domain: "navigation_design", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "List a block theme's built-in style variations (theme.json alternatives) by stylesheet.",
    input: obj({ ...SITE, stylesheet: { type: "string", minLength: 1 } }, ["server_plugin_id", "stylesheet"])
  }),
  def("wordpress.get_global_styles", {
    domain: "navigation_design", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "Read a block theme's global styles (theme.json-backed values) by id.",
    input: obj({ ...SITE, id: { type: "string" } }, ["server_plugin_id", "id"])
  }),
  def("wordpress.update_global_styles", {
    domain: "navigation_design", action: "change", risk: "medium", reversible: true, isWrite: true,
    description: "Update a block theme's global styles (colors, typography, spacing).",
    input: obj({ ...SITE, id: { type: "string" }, styles: { type: "object" }, settings: { type: "object" }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),

  // --- Typed serverPlugin settings ---
  def("wordpress.get_settings", {
    domain: "site_settings", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "Read the typed, whitelisted serverPlugin settings (identity, reading, discussion, permalink, etc.).",
    input: obj({ ...SITE }, ["server_plugin_id"])
  }),
  def("wordpress.update_settings", {
    domain: "site_settings", action: "change", risk: "medium", reversible: true, isWrite: true,
    description: "Update whitelisted typed serverPlugin settings. Unknown/secret options are rejected.",
    input: obj({ ...SITE, settings: { type: "object" }, ...IDEMPOTENT }, ["server_plugin_id", "settings", "idempotency_key"])
  }),

  // --- Users & roles ---
  def("wordpress.list_users", {
    domain: "users_roles", action: "read", risk: "medium", reversible: true, isWrite: false,
    description: "List users with minimized fields (no emails unless separately permitted).",
    input: obj({ ...SITE, search: { type: ["string", "null"] }, roles: { type: ["string", "null"] }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, cursor: { type: ["string", "null"] } }, ["server_plugin_id"])
  }),
  def("wordpress.get_user", {
    domain: "users_roles", action: "read", risk: "medium", reversible: true, isWrite: false,
    description: "Read a single user's profile with minimized fields.",
    input: obj({ ...SITE, id: { type: "string" } }, ["server_plugin_id", "id"])
  }),
  def("wordpress.list_roles", {
    domain: "users_roles", action: "read", risk: "low", reversible: true, isWrite: false,
    description: "List the WordPress roles available on the serverPlugin.",
    input: obj({ ...SITE }, ["server_plugin_id"])
  }),
  def("wordpress.create_user", {
    domain: "users_roles", action: "create", risk: "high", reversible: true, isWrite: true,
    description: "Create a WordPress user. A generated password is returned once and never stored.",
    input: obj({ ...SITE, username: { type: "string", minLength: 1 }, email: { type: "string", minLength: 3 }, name: { type: ["string", "null"] }, roles: { type: "array", items: { type: "string" } }, password: { type: ["string", "null"] }, ...IDEMPOTENT }, ["server_plugin_id", "username", "email", "idempotency_key"])
  }),
  def("wordpress.update_user", {
    domain: "users_roles", action: "change", risk: "high", reversible: true, isWrite: true,
    description: "Update a user's profile fields.",
    input: obj({ ...SITE, id: { type: "string" }, email: { type: ["string", "null"] }, name: { type: ["string", "null"] }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),
  def("wordpress.assign_user_role", {
    domain: "users_roles", action: "change", risk: "high", reversible: true, isWrite: true,
    description: "Set a user's roles.",
    input: obj({ ...SITE, id: { type: "string" }, roles: { type: "array", items: { type: "string" }, minItems: 1 }, ...IDEMPOTENT }, ["server_plugin_id", "id", "roles", "idempotency_key"])
  }),
  def("wordpress.delete_user", {
    domain: "users_roles", action: "remove", risk: "critical", reversible: false, isWrite: true,
    description: "Delete a user, optionally reassigning their content. Irreversible.",
    input: obj({ ...SITE, id: { type: "string" }, reassign: { type: ["integer", "null"] }, ...IDEMPOTENT }, ["server_plugin_id", "id", "idempotency_key"])
  }),
  def("wordpress.create_application_password", {
    domain: "users_roles", action: "operate", risk: "high", reversible: true, isWrite: true,
    description: "Create a WordPress Application Password for a user. The secret is shown once and never retrievable.",
    input: obj({ ...SITE, user_id: { type: "string" }, name: { type: "string", minLength: 1 }, ...IDEMPOTENT }, ["server_plugin_id", "user_id", "name", "idempotency_key"])
  }),
  def("wordpress.revoke_application_password", {
    domain: "users_roles", action: "operate", risk: "medium", reversible: false, isWrite: true,
    description: "Revoke a WordPress Application Password by its uuid.",
    input: obj({ ...SITE, user_id: { type: "string" }, uuid: { type: "string" }, ...IDEMPOTENT }, ["server_plugin_id", "user_id", "uuid", "idempotency_key"])
  })
];
