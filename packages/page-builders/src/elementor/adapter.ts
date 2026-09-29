import { WordPressRestError } from "@aibroker/wordpress-rest";
import type { PageBuilderAdapter, PageBuilderToolCtx, PageBuilderToolHandler, SnapshotRecord } from "../adapter.js";
import {
  applyOperations, assertSafeSettings, assertWithinLimits, countNodes, ElementorOperationError, findElement, hashTree, outline,
  parseElementorData, referencedTemplateIds, type ElementNode
} from "./tree.js";
import {
  detectElementor, DOCUMENT_KEYS, finalizeAbilityAvailable, hashSettings, isLive, loadDocument, loadTemplateTree, postId, saveDocument,
  TEMPLATE_TYPE, versionStatus, type DocumentChange, type DocumentView, type ElementorDocument
} from "./service.js";

const BUILDER = "elementor";
// Page settings are snapshotted separately so each can be listed and restored on its own.
const SETTINGS_BUILDER = "elementor_page_settings";
const MAX_FULL_TREE_BYTES = 1024 * 1024;
const TEMPLATE_PATTERN = /^[a-z0-9_./-]{0,200}$/i;

// Core Elementor widget types (free plugin). Inserting one of these needs no
// verification; anything else is reported as unverified unless the caller listed the
// site's registered types first.
export const CORE_WIDGET_TYPES = new Set([
  "heading", "image", "text-editor", "video", "button", "divider", "spacer", "image-box", "google_maps", "icon", "icon-box",
  "star-rating", "image-carousel", "image-gallery", "icon-list", "counter", "progress", "testimonial", "tabs", "accordion",
  "toggle", "social-icons", "alert", "audio", "shortcode", "html", "menu-anchor", "sidebar", "read-more", "rating",
  "text-path", "nested-tabs", "nested-accordion"
]);
// Registered by Elementor for control inheritance only; never placeable elements.
const INTERNAL_WIDGET_TYPES = new Set(["common", "common-base", "common-optimized", "inner-section"]);

function asError(ctx: PageBuilderToolCtx, err: unknown): unknown {
  if (err instanceof ElementorOperationError) {
    const status = ["revision_conflict", "duplicate_id", "global_widget_read_only"].includes(err.code) ? 409
      : err.code === "unsafe_content" ? 403 : err.code === "template_not_found" ? 404 : 400;
    return ctx.toolError(err.code, status, err.message);
  }
  return err;
}

function view(ctx: PageBuilderToolCtx): DocumentView {
  const value = ctx.input.view;
  if (value === undefined || value === null) return "live";
  if (value !== "live" && value !== "draft") throw ctx.toolError("validation_error", 400, 'view must be "live" or "draft"');
  return value;
}

function publishFlag(ctx: PageBuilderToolCtx): boolean {
  return typeof ctx.input.publish === "boolean" ? ctx.input.publish : ctx.pluginConfig.elementor_default_publish === true;
}

function expectedHash(ctx: PageBuilderToolCtx, field = "expected_hash"): string {
  const value = ctx.input[field];
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw ctx.toolError("validation_error", 400, `${field} must be a hash returned by elementor_get_document`);
  return value;
}

// A change to a published page without publish: true is saved as the caller's draft,
// so it must be read (and hash-checked) from the draft view.
async function loadForWrite(ctx: PageBuilderToolCtx, publish: boolean): Promise<ElementorDocument> {
  const requested = view(ctx);
  const doc = await loadDocument(ctx, requested);
  if (requested === "live" && !publish && isLive(doc.status)) {
    if (!(await ctx.session())) {
      throw ctx.toolError("publish_confirmation_required", 409,
        "This page is published, so the change would go live immediately. Pass publish: true to confirm, or connect your WordPress session in AIBroker to save a draft preview instead.");
    }
    return loadDocument(ctx, "draft");
  }
  return doc;
}

function assertVersion(ctx: PageBuilderToolCtx, doc: ElementorDocument): void {
  if (doc.session?.version && versionStatus(doc.session.version) === "unsupported") {
    throw ctx.toolError("elementor_version_unsupported", 409, `Elementor ${doc.session.version} has not been verified with AIBroker.`);
  }
}

function assertHash(ctx: PageBuilderToolCtx, doc: ElementorDocument, expected: string, which: "layout" | "page settings" = "layout"): void {
  const current = which === "layout" ? doc.hash : doc.settingsHash;
  if (current !== expected) {
    const field = which === "layout" ? "hash" : "settings_hash";
    throw ctx.toolError("revision_conflict", 409,
      `The ${doc.view} ${which} changed since it was read (current ${field} ${current}). Read it again with elementor_get_document (view: "${doc.view}") and retry.`);
  }
  assertVersion(ctx, doc);
}

function describe(doc: ElementorDocument) {
  return {
    id: doc.postId, type: doc.type, title: doc.title, status: doc.status, link: doc.link, view: doc.view, source: doc.source,
    ...(doc.session?.version ? { elementor_version: doc.session.version, version_status: versionStatus(doc.session.version) } : {})
  };
}

// Read back what WordPress stored. WordPress strips markup with kses for accounts
// without unfiltered_html, which would silently change raw HTML/JS/CSS writes.
async function sanitizationWarning(ctx: PageBuilderToolCtx, change: DocumentChange, savedAs: "page" | "draft_preview"): Promise<string | null> {
  try {
    const stored = await loadDocument(ctx, savedAs === "draft_preview" ? "draft" : "live");
    const layoutChanged = change.treeChanged && stored.hash !== hashTree(change.tree);
    const settingsChanged = change.pageSettings !== undefined && stored.source === "rest" && stored.settingsHash !== hashSettings(change.pageSettings);
    if (!layoutChanged && !settingsChanged) return null;
    return "content_sanitized: WordPress altered the saved content, most likely removing raw HTML/JS/CSS because the account lacks the unfiltered_html capability. Read the page again to see what was stored.";
  } catch {
    return null;
  }
}

async function commit(ctx: PageBuilderToolCtx, doc: ElementorDocument, change: DocumentChange, publish: boolean, verify = false) {
  assertWithinLimits(change.tree);
  const snapshots: string[] = [];
  if (change.treeChanged) {
    snapshots.push(await ctx.snapshots.save({ builder: BUILDER, postId: doc.postId, toolName: ctx.toolName, hash: doc.hash, data: JSON.stringify(doc.tree) }));
  }
  if (change.pageSettings) {
    snapshots.push(await ctx.snapshots.save({ builder: SETTINGS_BUILDER, postId: doc.postId, toolName: ctx.toolName, hash: doc.settingsHash, data: JSON.stringify(doc.pageSettings) }));
  }
  const saved = await saveDocument(ctx, doc, change, publish);
  const warnings = [...saved.warnings];
  if (verify) {
    const warning = await sanitizationWarning(ctx, change, saved.saved_as);
    if (warning) warnings.push(warning);
  }
  return {
    previous_hash: doc.hash, hash: hashTree(change.tree),
    ...(change.pageSettings ? { previous_settings_hash: doc.settingsHash, settings_hash: hashSettings(change.pageSettings) } : {}),
    snapshot_ids: snapshots, ...(snapshots[0] ? { snapshot_id: snapshots[0] } : {}),
    ...saved, warnings
  };
}

// Apply a settings patch (null removes a key). Document fields stay with the content
// tools; the template must be a plain template slug.
function patchPageSettings(ctx: PageBuilderToolCtx, current: Record<string, unknown>, patch: unknown, allowUnsafe: boolean): Record<string, unknown> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw ctx.toolError("validation_error", 400, "settings must be an object");
  const entries = Object.entries(patch as Record<string, unknown>);
  if (!entries.length) throw ctx.toolError("validation_error", 400, "settings must change at least one key");
  for (const [key, value] of entries) {
    if (DOCUMENT_KEYS.has(key)) {
      throw ctx.toolError("validation_error", 400, `"${key}" is a post field; change it with the regular content tools (wordpress.update_content / set_content_status)`);
    }
    if (key === "template" && value !== null && (typeof value !== "string" || !TEMPLATE_PATTERN.test(value) || value.includes(".."))) {
      throw ctx.toolError("validation_error", 400, "template must be a template slug such as elementor_canvas, elementor_header_footer or default");
    }
  }
  if (!allowUnsafe) {
    try { assertSafeSettings(patch as Record<string, unknown>, 0); } catch (err) {
      throw ctx.toolError("unsafe_content", 403, (err as Error).message.replace(/^Operation 0: /, ""));
    }
  }
  const next = { ...current };
  for (const [key, value] of entries) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

async function loadTemplates(ctx: PageBuilderToolCtx, tree: ElementNode[], operations: unknown): Promise<Map<number, ElementNode[]>> {
  const templates = new Map<number, ElementNode[]>();
  for (const id of referencedTemplateIds(tree, operations)) {
    const loaded = await loadTemplateTree(ctx, id);
    if (loaded) templates.set(id, loaded);
  }
  return templates;
}

const getDocument: PageBuilderToolHandler = async (ctx) => {
  try {
    const doc = await loadDocument(ctx, view(ctx));
    const base = {
      document: describe(doc), hash: doc.hash, settings_hash: doc.settingsHash, element_count: countNodes(doc.tree),
      write_paths: { finalize_ability: await finalizeAbilityAvailable(ctx.rest), session_connected: (await ctx.session()) !== null },
      ...(ctx.input.include_page_settings === true ? { page_settings: doc.pageSettings } : {})
    };
    const elementId = typeof ctx.input.element_id === "string" && ctx.input.element_id ? ctx.input.element_id : null;
    if (elementId) {
      const element = findElement(doc.tree, elementId);
      if (!element) throw ctx.toolError("element_not_found", 404, `Element "${elementId}" does not exist on this page`);
      return { ...base, element };
    }
    if (ctx.input.include_settings === true) {
      if (Buffer.byteLength(JSON.stringify(doc.tree)) > MAX_FULL_TREE_BYTES) {
        throw ctx.toolError("document_too_large", 413, "The full layout is too large to return at once; request individual elements with element_id.");
      }
      return { ...base, elements: doc.tree };
    }
    return { ...base, outline: outline(doc.tree) };
  } catch (err) { throw asError(ctx, err); }
};

// Shared by the medium-risk tool and the separately granted high-risk variant (D10).
function applyHandler(allowUnsafe: boolean): PageBuilderToolHandler {
  return (ctx) => ctx.idempotent(async () => {
    try {
      const publish = publishFlag(ctx);
      const expected = expectedHash(ctx);
      const doc = await loadForWrite(ctx, publish);
      assertHash(ctx, doc, expected);
      const operations = ctx.input.operations;
      const settingsPatch = allowUnsafe ? ctx.input.page_settings : undefined;
      const pageSettings = settingsPatch !== undefined ? patchPageSettings(ctx, doc.pageSettings, settingsPatch, true) : undefined;
      const noOperations = Array.isArray(operations) && operations.length === 0;
      // Publishing an existing draft preview as-is (or only changing page settings)
      // needs no operations.
      if (noOperations && (pageSettings || (doc.view === "draft" && publish))) {
        const change: DocumentChange = { tree: doc.tree, treeChanged: doc.view === "draft" && publish, ...(pageSettings ? { pageSettings } : {}) };
        return { ...(await commit(ctx, doc, change, publish, allowUnsafe)), created_ids: [] };
      }
      const templates = await loadTemplates(ctx, doc.tree, operations);
      const result = applyOperations(doc.tree, operations, { allowUnsafe, templates });
      const warnings = result.warnings.filter((warning) => !CORE_WIDGET_TYPES.has(warning.replace(/^widget_type_unverified:/, "")));
      const committed = await commit(ctx, doc, { tree: result.tree, treeChanged: true, ...(pageSettings ? { pageSettings } : {}) }, publish, allowUnsafe);
      return { ...committed, created_ids: result.createdIds, warnings: [...warnings, ...committed.warnings] };
    } catch (err) { throw asError(ctx, err); }
  });
}

const setPageSettings: PageBuilderToolHandler = (ctx) => ctx.idempotent(async () => {
  try {
    const publish = publishFlag(ctx);
    const expected = expectedHash(ctx, "expected_settings_hash");
    const doc = await loadForWrite(ctx, publish);
    assertHash(ctx, doc, expected, "page settings");
    const pageSettings = patchPageSettings(ctx, doc.pageSettings, ctx.input.settings, false);
    return commit(ctx, doc, { tree: doc.tree, treeChanged: false, pageSettings }, publish);
  } catch (err) { throw asError(ctx, err); }
});

const listSnapshots: PageBuilderToolHandler = async (ctx) => {
  const id = postId(ctx);
  const [layouts, settings] = await Promise.all([ctx.snapshots.list(BUILDER, id, 25), ctx.snapshots.list(SETTINGS_BUILDER, id, 25)]);
  const tag = (kind: string) => (record: SnapshotRecord) => ({ ...record, kind });
  return {
    snapshots: [...layouts.map(tag("layout")), ...settings.map(tag("page_settings"))]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  };
};

const restoreSnapshot: PageBuilderToolHandler = (ctx) => ctx.idempotent(async () => {
  try {
    const publish = publishFlag(ctx);
    const expected = expectedHash(ctx);
    const id = postId(ctx);
    const snapshotId = typeof ctx.input.snapshot_id === "string" ? ctx.input.snapshot_id : "";
    const layout = snapshotId ? await ctx.snapshots.get(BUILDER, id, snapshotId) : null;
    const settings = !layout && snapshotId ? await ctx.snapshots.get(SETTINGS_BUILDER, id, snapshotId) : null;
    const snapshot = layout ?? settings;
    if (!snapshot) throw ctx.toolError("snapshot_not_found", 404, "No such snapshot for this page");
    const doc = await loadForWrite(ctx, publish);
    if (layout) {
      assertHash(ctx, doc, expected);
      return { ...(await commit(ctx, doc, { tree: parseElementorData(layout.data), treeChanged: true }, publish)), restored_snapshot_id: snapshot.id, kind: "layout" };
    }
    assertHash(ctx, doc, expected, "page settings");
    const pageSettings = JSON.parse(settings!.data) as Record<string, unknown>;
    return { ...(await commit(ctx, doc, { tree: doc.tree, treeChanged: false, pageSettings }, publish)), restored_snapshot_id: snapshot.id, kind: "page_settings" };
  } catch (err) { throw asError(ctx, err); }
});

// Registered widget types come from the editor's widget config, which only a session
// can read; without one the core list is returned and marked as such.
const listWidgetTypes: PageBuilderToolHandler = async (ctx) => {
  const session = await ctx.session();
  if (!session) return { source: "core_list", widget_types: [...CORE_WIDGET_TYPES].sort(), note: "Connect a WordPress session to list every widget registered on this site (including Pro and third-party widgets)." };
  const id = postId(ctx);
  const responses = await session.elementorAjax(id, { widgets: { action: "get_widgets_config", data: { exclude: {} } } });
  const response = responses.widgets;
  if (!response?.success || !response.data || typeof response.data !== "object") {
    throw ctx.toolError("elementor_request_failed", 502, "Elementor did not return its widget configuration");
  }
  const config = response.data as Record<string, { controls?: Record<string, { type?: string; label?: string; default?: unknown; options?: unknown }> }>;
  const types = Object.keys(config).filter((type) => !INTERNAL_WIDGET_TYPES.has(type)).sort();
  const detail = typeof ctx.input.widget_type === "string" ? ctx.input.widget_type : null;
  if (detail) {
    const controls = config[detail]?.controls;
    if (!controls) throw ctx.toolError("unknown_widget_type", 404, `Widget type "${detail}" is not registered on this site`);
    // Content/style controls only: section/tab markers carry no stored setting.
    const settings = Object.entries(controls)
      .filter(([, control]) => control.type && !["section", "tab", "tabs", "heading", "divider", "raw_html", "deprecated_notice", "alert", "notice"].includes(control.type))
      .map(([name, control]) => ({ name, type: control.type, ...(control.label ? { label: control.label } : {}), ...(control.default !== undefined && control.default !== "" ? { default: control.default } : {}) }));
    return { source: "site", widget_type: detail, settings };
  }
  return { source: "site", widget_types: types };
};

interface TemplateSummary { id: number; title: string; template_type: string | null; status: string; modified: string | null }

// Saved templates: REST when the credential is an administrator (Elementor blocks the
// template REST route for everyone else), otherwise the caller's editor session.
const listTemplates: PageBuilderToolHandler = async (ctx) => {
  const search = typeof ctx.input.search === "string" ? ctx.input.search.slice(0, 200) : "";
  const wanted = typeof ctx.input.template_type === "string" ? ctx.input.template_type : null;
  const keep = (template: TemplateSummary) => !wanted || template.template_type === wanted;
  try {
    const result = await ctx.rest.listCollection(TEMPLATE_TYPE, { context: "edit", per_page: 100, ...(search ? { search } : {}) },
      ["id", "title", "status", "modified_gmt", "meta"]);
    const templates = result.items.map((item): TemplateSummary => ({
      id: Number(item.id),
      title: typeof item.title === "object" && item.title ? String((item.title as { raw?: string; rendered?: string }).raw ?? (item.title as { rendered?: string }).rendered ?? "") : String(item.title ?? ""),
      template_type: typeof (item.meta as Record<string, unknown> | undefined)?._elementor_template_type === "string" ? String((item.meta as Record<string, unknown>)._elementor_template_type) || null : null,
      status: String(item.status ?? ""), modified: typeof item.modified_gmt === "string" ? `${item.modified_gmt}Z` : null
    }));
    return { source: "rest", templates: templates.filter(keep) };
  } catch (err) {
    if (!(err instanceof WordPressRestError && [401, 403].includes(err.statusCode))) throw err;
  }
  const session = await ctx.session();
  if (!session) {
    throw ctx.toolError("wordpress_session_required", 409,
      "Elementor only lists saved templates to administrators over REST. Connect your WordPress session under WordPress Sessions, or use an administrator application password.");
  }
  // load_more_templates returns every local template (search_templates does not search the
  // local source), so filtering happens here.
  const responses = await session.elementorAjax(0, { templates: { action: "load_more_templates", data: { source: "local", offset: 0 } } });
  const response = responses.templates;
  if (!response?.success) throw ctx.toolError("elementor_request_failed", 502, `Elementor could not list templates: ${String(response?.data ?? "no response").slice(0, 200)}`);
  const raw = Array.isArray(response.data) ? response.data : Array.isArray((response.data as { templates?: unknown })?.templates) ? (response.data as { templates: unknown[] }).templates : [];
  const needle = search.toLowerCase();
  const templates = (raw as Array<Record<string, unknown>>)
    // The site's global kit is stored as a template but isn't one users insert.
    .filter((item) => item.template_id !== undefined && item.type !== "kit" && (!needle || String(item.title ?? "").toLowerCase().includes(needle)))
    .map((item): TemplateSummary => ({
    id: Number(item.template_id), title: String(item.title ?? ""), template_type: typeof item.type === "string" ? item.type : null,
    status: String(item.status ?? ""), modified: typeof item.human_modified_date === "string" ? item.human_modified_date : null
  }));
  return { source: "session", templates: templates.filter(keep) };
};

export const elementorAdapter: PageBuilderAdapter = {
  key: BUILDER,
  label: "Elementor",
  async detect(rest) {
    const detected = await detectElementor(rest);
    return { builder: BUILDER, ...detected };
  },
  handlers: {
    "wordpress.elementor_get_document": getDocument,
    "wordpress.elementor_apply_operations": applyHandler(false),
    "wordpress.elementor_apply_unsafe_operations": applyHandler(true),
    "wordpress.elementor_set_page_settings": setPageSettings,
    "wordpress.elementor_list_widget_types": listWidgetTypes,
    "wordpress.elementor_list_templates": listTemplates,
    "wordpress.elementor_list_snapshots": listSnapshots,
    "wordpress.elementor_restore_snapshot": restoreSnapshot
  }
};

export { TEMPLATE_TYPE };
