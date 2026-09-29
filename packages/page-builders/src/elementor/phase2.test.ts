import { describe, expect, it, vi } from "vitest";
import { WordPressRestError, type WordPressRestClient, type WordPressSessionClient } from "@aibroker/wordpress-rest";
import type { PageBuilderToolCtx, SnapshotStore } from "../adapter.js";
import { elementorAdapter } from "./adapter.js";
import { hashSettings } from "./service.js";
import { applyOperations, hashTree, type ElementNode } from "./tree.js";

// AB-ELEMENTOR Phase 2: unsafe operations, page settings, templates and global widgets.

const PAGE: ElementNode[] = [{ id: "c0000001", elType: "container", settings: {}, elements: [
  { id: "164e6f4c", elType: "widget", widgetType: "heading", settings: { title: "Hello" }, elements: [] },
  { id: "9lob4l01", elType: "widget", widgetType: "global", templateID: 77, settings: [], elements: [] }
] }];
const GLOBAL_TEMPLATE: ElementNode[] = [{ id: "t0000001", elType: "widget", widgetType: "button", settings: { text: "Buy now" }, elements: [] }];
const SECTION_TEMPLATE: ElementNode[] = [{ id: "t0000002", elType: "container", settings: {}, elements: [
  { id: "t0000003", elType: "widget", widgetType: "heading", settings: { title: "From template" }, elements: [] }
] }];
const SETTINGS = { hide_title: "yes", background_color: "#fff", template: "elementor_canvas" };
const HASH = hashTree(PAGE);
const SETTINGS_HASH = hashSettings(SETTINGS);
const key = "k".repeat(16);

interface Options { ability?: boolean; session?: boolean; templatesForbidden?: boolean; sanitizeOnSave?: boolean; status?: string }

function setup(options: Options = {}) {
  const writes: Array<{ base: string; body: Record<string, unknown> }> = [];
  const sessionCalls: Array<{ action: string; data: Record<string, unknown> }> = [];
  let stored: ElementNode[] = PAGE;
  let { template: storedTemplate, ...storedMeta }: Record<string, unknown> = SETTINGS;
  const post = () => ({ id: 30847, status: options.status ?? "draft", title: { raw: "About" }, link: "https://x.test/about/", template: storedTemplate,
    meta: { _elementor_edit_mode: "builder", _elementor_data: JSON.stringify(stored), _elementor_page_settings: storedMeta } });
  const templates: Record<number, ElementNode[]> = { 77: GLOBAL_TEMPLATE, 88: SECTION_TEMPLATE };
  const rest = {
    getResource: vi.fn(async (base: string, id: string) => {
      if (base === "elementor_library") {
        if (options.templatesForbidden) throw new WordPressRestError(401, "forbidden", "rest_forbidden");
        const tree = templates[Number(id)];
        if (!tree) throw new WordPressRestError(404, "missing", "rest_post_invalid_id");
        return { id: Number(id), status: "publish", title: { raw: `Template ${id}` }, meta: { _elementor_edit_mode: "builder", _elementor_data: JSON.stringify(tree) } };
      }
      return post();
    }),
    getTypeRestBases: vi.fn(async () => ({})),
    getAbility: vi.fn(async () => options.ability === false ? null : { name: "elementor/update-page-settings" }),
    runAbility: vi.fn(async () => ({ success: true })),
    updateResource: vi.fn(async (base: string, _id: string, body: Record<string, unknown>) => {
      writes.push({ base, body });
      const meta = body.meta as Record<string, unknown>;
      if (meta._elementor_page_settings) { storedMeta = meta._elementor_page_settings as Record<string, unknown>; storedTemplate = body.template; }
      if (typeof meta._elementor_data === "string") {
        // Simulate kses stripping for an account without unfiltered_html.
        stored = options.sanitizeOnSave ? JSON.parse(meta._elementor_data.replace(/<script>[^<]*<\/script>/g, "")) : JSON.parse(meta._elementor_data);
      }
      return {};
    }),
    clearElementorCache: vi.fn(async () => undefined),
    listCollection: vi.fn(async () => {
      if (options.templatesForbidden) throw new WordPressRestError(401, "forbidden", "rest_forbidden");
      return { items: [{ id: 88, title: { raw: "Hero" }, status: "publish", modified_gmt: "2026-09-29T10:00:00", meta: { _elementor_template_type: "container" } }], next_cursor: null, total: 1 };
    })
  } as unknown as WordPressRestClient;
  const session = {
    elementorAjax: vi.fn(async (_id: number, actions: Record<string, { action: string; data: Record<string, unknown> }>) => {
      const [name, request] = Object.entries(actions)[0]!;
      sessionCalls.push(request);
      if (request.action === "get_document_config") {
        const id = Number(request.data.id);
        const elements = id === 30847 ? stored : templates[id] ?? [];
        return { [name]: { success: true, code: 200, data: { elements, version: "4.3.2", user: { locked: false },
          settings: { settings: { post_title: "About", post_status: options.status ?? "draft", ...SETTINGS, margin: { unit: "px" } } } } } };
      }
      if (request.action === "load_more_templates") {
        return { [name]: { success: true, code: 200, data: [{ template_id: 4, title: "Default Kit", type: "kit", status: "publish" },
          { template_id: 88, title: "Hero", type: "container", status: "publish" }, { template_id: 89, title: "Footer", type: "footer", status: "publish" }] } };
      }
      return { [name]: { success: true, code: 200, data: { status: "draft" } } };
    })
  } as unknown as WordPressSessionClient;
  const snapshots: SnapshotStore & { saved: Array<{ builder: string; hash: string; data: string }> } = {
    saved: [],
    async save(entry) { this.saved.push(entry); return `snap-${this.saved.length}`; },
    async list(builder) { return this.saved.filter((entry) => entry.builder === builder).map((entry, index) => ({ id: `snap-${index}`, content_hash: entry.hash, byte_size: 1, tool_name: "t", actor_user_id: null, created_at: `2026-09-29T10:0${index}:00Z` })); },
    async get(builder, _post, id) {
      const entry = this.saved.find((saved, index) => `snap-${index + 1}` === id && saved.builder === builder);
      return entry ? { id, content_hash: entry.hash, byte_size: 1, tool_name: "t", actor_user_id: null, created_at: "", data: entry.data } : null;
    }
  };
  const run = (tool: string, input: Record<string, unknown> = {}) => elementorAdapter.handlers[`wordpress.elementor_${tool}`]!({
    toolName: `wordpress.elementor_${tool}`, input: { server_plugin_id: "p", id: "30847", ...input }, rest,
    session: async () => options.session ? session : null, snapshots, pluginConfig: {},
    idempotent: (action) => action(),
    toolError: (code, status = 400, message) => Object.assign(new Error(message ?? code), { code, status })
  } as PageBuilderToolCtx) as Promise<Record<string, unknown>>;
  return { run, writes, sessionCalls, snapshots, current: () => stored };
}

describe("elementor_apply_unsafe_operations (D10)", () => {
  const html = { action: "insert", parent_id: "c0000001", element: { elType: "widget", widgetType: "html", settings: { html: "<script>track()</script>" } } };

  it("is refused by the regular tool and allowed by the unsafe one", async () => {
    await expect(setup().run("apply_operations", { expected_hash: HASH, operations: [html], idempotency_key: key })).rejects.toMatchObject({ code: "unsafe_content" });
    const result = await setup().run("apply_unsafe_operations", { expected_hash: HASH, operations: [html], idempotency_key: key });
    expect(result).toMatchObject({ transport: "rest", warnings: [] });
  });

  it("reports when WordPress sanitizes the stored markup", async () => {
    const result = await setup({ sanitizeOnSave: true }).run("apply_unsafe_operations", { expected_hash: HASH, operations: [html], idempotency_key: key });
    expect(result.warnings).toEqual([expect.stringContaining("content_sanitized")]);
  });

  it("can set page-level custom CSS alongside operations", async () => {
    const { run, writes } = setup();
    await run("apply_unsafe_operations", { expected_hash: HASH, operations: [], page_settings: { custom_css: "selector { color: red }" }, idempotency_key: key });
    expect(writes[0]!.body).toMatchObject({ template: "elementor_canvas", meta: { _elementor_page_settings: { custom_css: "selector { color: red }", hide_title: "yes" } } });
    expect((writes[0]!.body.meta as Record<string, unknown>)._elementor_data).toBeUndefined();
  });
});

describe("elementor_set_page_settings", () => {
  it("merges the patch over REST, removes null keys, and snapshots the old settings", async () => {
    const { run, writes, snapshots } = setup();
    const document = await run("get_document", { include_page_settings: true });
    expect(document).toMatchObject({ settings_hash: SETTINGS_HASH, page_settings: SETTINGS });
    const result = await run("set_page_settings", { expected_settings_hash: SETTINGS_HASH, settings: { hide_title: null, template: "elementor_header_footer" }, idempotency_key: key });
    expect(writes[0]!.body).toEqual({ template: "elementor_header_footer", meta: { _elementor_page_settings: { background_color: "#fff" } } });
    expect(result).toMatchObject({ previous_settings_hash: SETTINGS_HASH, transport: "rest", snapshot_ids: ["snap-1"] });
    expect(snapshots.saved[0]).toMatchObject({ builder: "elementor_page_settings", hash: SETTINGS_HASH });
  });

  it("refuses post fields, bad templates, custom CSS and stale hashes", async () => {
    const { run, writes } = setup();
    const call = (settings: Record<string, unknown>, hash = SETTINGS_HASH) => run("set_page_settings", { expected_settings_hash: hash, settings, idempotency_key: key });
    await expect(call({ post_title: "x" })).rejects.toMatchObject({ code: "validation_error" });
    await expect(call({ template: "../../evil" })).rejects.toMatchObject({ code: "validation_error" });
    await expect(call({ custom_css: "body{}" })).rejects.toMatchObject({ code: "unsafe_content" });
    await expect(call({ hide_title: "no" }, "0".repeat(64))).rejects.toMatchObject({ code: "revision_conflict" });
    expect(writes).toEqual([]);
  });

  it("sends document fields plus the complete new settings through the session", async () => {
    const { run, sessionCalls } = setup({ ability: false, session: true });
    const document = await run("get_document", {});
    await run("set_page_settings", { expected_settings_hash: document.settings_hash, settings: { hide_title: null }, idempotency_key: key });
    const save = sessionCalls.find((call) => call.action === "save_builder")!;
    expect(save.data.settings).toMatchObject({ post_title: "About", post_status: "draft", template: "elementor_canvas", background_color: "#fff" });
    expect(save.data.settings).not.toHaveProperty("hide_title");
  });

  it("restores a page-settings snapshot", async () => {
    const { run, writes } = setup();
    await run("set_page_settings", { expected_settings_hash: SETTINGS_HASH, settings: { hide_title: "no" }, idempotency_key: key });
    const changed = hashSettings({ ...SETTINGS, hide_title: "no" });
    const result = await run("restore_snapshot", { snapshot_id: "snap-1", expected_hash: changed, idempotency_key: key });
    expect(result).toMatchObject({ kind: "page_settings", restored_snapshot_id: "snap-1" });
    expect(writes.at(-1)!.body).toMatchObject({ meta: { _elementor_page_settings: { hide_title: "yes" } } });
  });
});

describe("templates and global widgets (D11)", () => {
  it("marks global widgets read-only in the outline and refuses edits", async () => {
    const { run } = setup();
    const document = await run("get_document");
    expect(JSON.stringify(document.outline)).toContain("global widget (template 77, read-only)");
    await expect(run("apply_operations", { expected_hash: HASH, operations: [{ action: "update_settings", element_id: "9lob4l01", settings: { text: "x" } }], idempotency_key: key }))
      .rejects.toMatchObject({ code: "global_widget_read_only", status: 409 });
  });

  it("unlinks a global widget into an editable local copy", async () => {
    const { run, current } = setup();
    const result = await run("apply_operations", { expected_hash: HASH, operations: [{ action: "unlink_global", element_id: "9lob4l01" }], idempotency_key: key });
    const replaced = current()[0]!.elements[1]!;
    expect(replaced).toMatchObject({ elType: "widget", widgetType: "button", settings: { text: "Buy now" } });
    expect(replaced.id).not.toBe("t0000001");
    expect(result.created_ids).toEqual([replaced.id]);
  });

  it("inserts a saved template with fresh ids, falling back to the session when REST refuses", async () => {
    const operations = [{ action: "insert_template", template_id: 88, parent_id: null, index: 0 }];
    await expect(setup({ templatesForbidden: true }).run("apply_operations", { expected_hash: HASH, operations, idempotency_key: key }))
      .rejects.toMatchObject({ code: "wordpress_session_required" });
    const { run, current } = setup({ templatesForbidden: true, session: true });
    await run("apply_operations", { expected_hash: HASH, operations, idempotency_key: key });
    expect(current()[0]).toMatchObject({ elType: "container", elements: [{ widgetType: "heading", settings: { title: "From template" } }] });
    expect(current()[0]!.id).not.toBe("t0000002");
  });

  it("lists templates over REST, or through the session for non-administrators", async () => {
    expect(await setup().run("list_templates", {})).toMatchObject({ source: "rest", templates: [{ id: 88, title: "Hero", template_type: "container" }] });
    const viaSession = await setup({ templatesForbidden: true, session: true }).run("list_templates", { search: "her" });
    expect(viaSession).toEqual({ source: "session", templates: [expect.objectContaining({ id: 88, template_type: "container" })] });
    await expect(setup({ templatesForbidden: true }).run("list_templates", {})).rejects.toMatchObject({ code: "wordpress_session_required" });
  });

  it("opens saved templates as documents through the session when REST refuses", async () => {
    const result = await setup({ templatesForbidden: true, session: true }).run("get_document", { id: "88", type: "elementor_library" });
    expect(result).toMatchObject({ document: { source: "session", title: "About" }, hash: hashTree(SECTION_TEMPLATE) });
  });
});

describe("tree operations for templates", () => {
  it("rejects placing template elements where they don't fit", () => {
    const templates = new Map([[88, SECTION_TEMPLATE]]);
    expect(() => applyOperations(PAGE, [{ action: "insert_template", template_id: 88, parent_id: "164e6f4c" }], { templates })).toThrow(/cannot contain/);
    expect(() => applyOperations(PAGE, [{ action: "insert_template", template_id: 99, parent_id: null }], { templates })).toThrow(/could not be loaded/);
  });
});
