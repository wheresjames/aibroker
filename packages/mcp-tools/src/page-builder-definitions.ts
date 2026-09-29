import { validateToolMetadata, type ToolAction, type ToolRisk } from "./catalog.js";
import type { ToolDefinition } from "./definitions.js";

// Page-builder tools (AB-ELEMENTOR). Handlers live in @aibroker/page-builders, keyed by
// these names. They run on the site's application-password REST credential; the
// caller's own WordPress login session is optional and only used where REST cannot do
// the job (draft previews of live pages, cache refresh on older Elementor, <3.27 sites).

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
// Results vary by transport (warnings, preview links), so outputs are open objects.
const RESULT = { type: "object", additionalProperties: true };
const SITE = { server_plugin_id: { type: "string", format: "uuid" } };
const POST = {
  id: { type: "string", pattern: "^[0-9]+$", description: "WordPress post id of the Elementor page." },
  type: { type: "string", minLength: 1, default: "page", description: "Content type: page, post, elementor_library (saved templates), or a REST-visible custom post type." }
};
const VIEW = {
  view: { type: "string", enum: ["live", "draft"], default: "live", description: "live = the saved page; draft = your Elementor autosave of a published page (needs a WordPress session)." }
};
const WRITE = {
  expected_hash: { type: "string", pattern: "^[0-9a-f]{64}$", description: "hash from elementor_get_document for the same view; the write is refused if the layout changed since." },
  publish: { type: "boolean", description: "Required to change a published page directly. Without it, changes to a published page are saved as your draft preview (needs a WordPress session)." },
  idempotency_key: { type: "string", minLength: 16 }
};

const ELEMENT = {
  type: "object",
  required: ["elType"],
  properties: {
    id: { type: "string", pattern: "^[0-9a-f]{7,8}$", description: "Optional; generated when omitted." },
    elType: { type: "string", description: "container, section, column or widget (or an atomic v4 element type)." },
    widgetType: { type: "string", description: "Required for widgets, e.g. heading, text-editor, button, image." },
    isInner: { type: "boolean" },
    settings: { type: "object" },
    elements: { type: "array", items: { type: "object" } }
  }
};

const OPERATION = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["update_settings", "insert", "remove", "move", "duplicate", "replace", "unlink_global", "insert_template"] },
    element_id: { type: "string", description: "Target element (update_settings, remove, move, duplicate, replace, unlink_global)." },
    template_id: { type: "integer", minimum: 1, description: "insert_template: saved template whose elements are copied in with fresh ids." },
    parent_id: { type: ["string", "null"], description: "Destination parent; null = top level (insert, move, duplicate, insert_template)." },
    index: { type: "integer", minimum: 0, description: "Position among the destination's children after any removal; default = end (duplicate: right after the source)." },
    settings: { type: "object", description: "update_settings: keys to merge; a null value removes the key." },
    element: ELEMENT
  }
};

const PAGE_SETTINGS_PATCH = {
  type: "object",
  description: "Page settings keys to change (e.g. hide_title, background_color, template); a null value removes the key. Post fields such as the title or status belong to the content tools."
};

function def(name: string, action: ToolAction, risk: ToolRisk, isWrite: boolean, description: string, input: Record<string, unknown>): ToolDefinition {
  const definition: ToolDefinition = {
    name, version: 1, category: isWrite ? "write" : "read", isWrite,
    inputSchema: input, outputSchema: RESULT,
    domain: "content", action, risk, reversible: true,
    executorKind: "rest", credentialKinds: ["wordpress_rest_application_password"],
    supportsDryRun: false, isLongRunning: false, description
  };
  const problems = validateToolMetadata(name, definition);
  if (problems.length) throw new Error(`Invalid page-builder tool metadata: ${problems.join("; ")}`);
  return definition;
}

export const PAGE_BUILDER_TOOL_DEFINITIONS: ToolDefinition[] = [
  def("wordpress.elementor_get_document", "read", "low", false,
    "Read an Elementor page's layout: an outline of its elements (ids, types, text labels) plus the hash needed for writes. Pass element_id for one element's full settings, or include_settings for the whole tree.",
    obj({ ...SITE, ...POST, ...VIEW, element_id: { type: "string" }, include_settings: { type: "boolean", default: false },
      include_page_settings: { type: "boolean", default: false } }, ["server_plugin_id", "id"])),
  def("wordpress.elementor_apply_operations", "change", "medium", true,
    "Edit an Elementor page with up to 50 operations applied all-or-nothing in one save: update_settings, insert, remove, move, duplicate, replace, unlink_global (turn a Pro global widget into a local copy), insert_template (copy a saved template in). Global widgets are read-only. Raw HTML/JS/CSS widgets and settings are refused. Returns the new hash and a snapshot id for rollback.",
    obj({ ...SITE, ...POST, ...VIEW, operations: { type: "array", minItems: 0, maxItems: 50, items: OPERATION }, ...WRITE },
      ["server_plugin_id", "id", "operations", "expected_hash", "idempotency_key"])),
  def("wordpress.elementor_apply_unsafe_operations", "change", "high", true,
    "Like elementor_apply_operations, but also allows raw HTML/JS/CSS: the html and shortcode widgets, custom_css, custom attributes, script markup, and page-level custom CSS through page_settings. Grant separately; content can run in visitors' browsers. WordPress may still strip markup for accounts without unfiltered_html, which is reported as a content_sanitized warning.",
    obj({ ...SITE, ...POST, ...VIEW, operations: { type: "array", minItems: 0, maxItems: 50, items: OPERATION }, page_settings: PAGE_SETTINGS_PATCH, ...WRITE },
      ["server_plugin_id", "id", "operations", "expected_hash", "idempotency_key"])),
  def("wordpress.elementor_set_page_settings", "change", "medium", true,
    "Change an Elementor page's page-level settings (layout, background, hide title, page template, spacing). Custom CSS and raw markup are refused. Requires settings_hash from elementor_get_document.",
    obj({ ...SITE, ...POST, ...VIEW, settings: PAGE_SETTINGS_PATCH,
      expected_settings_hash: { type: "string", pattern: "^[0-9a-f]{64}$", description: "settings_hash from elementor_get_document for the same view." },
      publish: WRITE.publish, idempotency_key: WRITE.idempotency_key },
      ["server_plugin_id", "id", "settings", "expected_settings_hash", "idempotency_key"])),
  def("wordpress.elementor_list_templates", "read", "low", false,
    "List saved Elementor templates (id, title, template type). Use their ids with insert_template, or edit one with type: elementor_library. Needs an administrator application password or your WordPress session.",
    obj({ ...SITE, search: { type: "string", maxLength: 200 }, template_type: { type: "string", description: "Filter, e.g. page, section, container, widget, header, footer." } }, ["server_plugin_id"])),
  def("wordpress.elementor_list_widget_types", "read", "low", false,
    "List the Elementor widget types registered on the site (needs a WordPress session; otherwise the core list), or the settings one widget type accepts.",
    obj({ ...SITE, id: POST.id, widget_type: { type: "string" } }, ["server_plugin_id", "id"])),
  def("wordpress.elementor_list_snapshots", "read", "low", false,
    "List the layout and page-settings snapshots AIBroker saved before each Elementor change to a page (newest first, with kind).",
    obj({ ...SITE, ...POST }, ["server_plugin_id", "id"])),
  def("wordpress.elementor_restore_snapshot", "change", "medium", true,
    "Restore an Elementor page's layout or page settings from an AIBroker snapshot. expected_hash is the current hash (layout snapshots) or settings_hash (page-settings snapshots). The current state is snapshotted first, so a restore can itself be undone.",
    obj({ ...SITE, ...POST, ...VIEW, snapshot_id: { type: "string", format: "uuid" }, ...WRITE },
      ["server_plugin_id", "id", "snapshot_id", "expected_hash", "idempotency_key"]))
];
