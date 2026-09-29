import { describe, expect, it, vi } from "vitest";
import { WordPressRestError, type WordPressRestClient, type WordPressSessionClient } from "@aibroker/wordpress-rest";
import type { PageBuilderToolCtx, SnapshotStore } from "../adapter.js";
import { elementorAdapter } from "./adapter.js";
import { hashTree, type ElementNode } from "./tree.js";

const TREE: ElementNode[] = [{ id: "c0000001", elType: "container", settings: {}, elements: [
  { id: "164e6f4c", elType: "widget", widgetType: "heading", settings: { title: "Accessibility Philosophy" }, elements: [] }
] }];
const HASH = hashTree(TREE);
const RENAME = [{ action: "update_settings", element_id: "164e6f4c", settings: { title: "Philosophy" } }];

interface Options {
  status?: string;
  restMeta?: boolean;
  editMode?: string;
  ability?: boolean;
  abilityLocked?: boolean;
  cacheForbidden?: boolean;
  session?: boolean;
  locked?: unknown;
  draftTree?: ElementNode[];
}

function setup(options: Options = {}) {
  const status = options.status ?? "draft";
  const calls: string[] = [];
  const written: unknown[] = [];
  const meta = options.restMeta === false ? undefined
    : { _elementor_edit_mode: options.editMode ?? "builder", _elementor_data: JSON.stringify(TREE) };
  const rest = {
    getResource: vi.fn(async () => ({ id: 30847, status, title: { raw: "About" }, link: "https://x.test/about/", ...(meta ? { meta } : {}),
      content: { rendered: '<div data-elementor-type="wp-page" data-elementor-id="30847" class="elementor">' } })),
    getTypeRestBases: vi.fn(async () => ({})),
    getAbility: vi.fn(async () => options.ability ? { name: "elementor/update-page-settings" } : null),
    runAbility: vi.fn(async () => {
      calls.push("ability");
      if (options.abilityLocked) throw new WordPressRestError(409, "unsaved", "elementor_editor_unsaved_changes");
      return { success: true };
    }),
    updateResource: vi.fn(async (_base: string, _id: string, body: Record<string, unknown>) => { calls.push("rest_write"); written.push(body); return {}; }),
    clearElementorCache: vi.fn(async () => {
      calls.push("cache_clear");
      if (options.cacheForbidden) throw new WordPressRestError(403, "forbidden", "rest_forbidden");
    })
  } as unknown as WordPressRestClient;
  const sessionSettings = { template: "elementor_canvas", hide_title: "yes", post_status: status };
  const session = {
    elementorAjax: vi.fn(async (_id: number, actions: Record<string, { action: string; data: Record<string, unknown> }>) => {
      const [key, request] = Object.entries(actions)[0]!;
      calls.push(`session:${request.action}`);
      if (request.action === "get_document_config") {
        const elements = (options.draftTree ?? TREE).map((node) => ({ ...node, htmlCache: "<div></div>" }));
        return { [key]: { success: true, code: 200, data: { elements, settings: { settings: sessionSettings }, user: { locked: options.locked ?? false }, version: "4.3.2" } } };
      }
      if (request.action === "save_builder") {
        written.push(request.data);
        return { [key]: { success: true, code: 200, data: { status, config: { document: { urls: { wp_preview: "https://x.test/?preview=true" } } } } } };
      }
      return { [key]: { success: true, code: 200, data: { heading: { controls: { title: { type: "text", label: "Title", default: "Add Your Heading Text Here" } } }, common: {} } } };
    })
  } as unknown as WordPressSessionClient;
  const snapshots: SnapshotStore & { saved: unknown[] } = {
    saved: [],
    async save(entry) { this.saved.push(entry); return "11111111-1111-1111-1111-111111111111"; },
    async list() { return []; },
    async get(_builder, _post, id) {
      return id === "snap" ? { id, content_hash: HASH, byte_size: 10, tool_name: "t", actor_user_id: null, created_at: "", data: JSON.stringify(TREE) } : null;
    }
  };
  const ctx = (tool: string, input: Record<string, unknown>): PageBuilderToolCtx => ({
    toolName: tool, input: { server_plugin_id: "p", id: "30847", ...input }, rest,
    session: async () => options.session ? session : null,
    snapshots, pluginConfig: {},
    idempotent: (action) => action(),
    toolError: (code, statusCode = 400, message) => Object.assign(new Error(message ?? code), { code, status: statusCode })
  });
  const run = (tool: string, input: Record<string, unknown> = {}) =>
    elementorAdapter.handlers[`wordpress.elementor_${tool}`]!(ctx(`wordpress.elementor_${tool}`, input)) as Promise<Record<string, unknown>>;
  return { run, calls, written, snapshots, rest };
}

describe("elementor_get_document", () => {
  it("reads over REST and returns an outline with the hash", async () => {
    const { run } = setup({ ability: true });
    const result = await run("get_document");
    expect(result).toMatchObject({ hash: HASH, element_count: 2, document: { id: 30847, source: "rest", view: "live" },
      outline: [{ id: "c0000001", children: [{ id: "164e6f4c", label: "Accessibility Philosophy" }] }],
      write_paths: { finalize_ability: true, session_connected: false } });
  });

  it("refuses pages that are not built with Elementor", async () => {
    await expect(setup({ editMode: "" }).run("get_document")).rejects.toMatchObject({ code: "not_elementor_document" });
  });

  it("falls back to the session on Elementor < 3.27 and says how to fix it without one", async () => {
    await expect(setup({ restMeta: false }).run("get_document")).rejects.toMatchObject({ code: "elementor_rest_unavailable" });
    const result = await setup({ restMeta: false, session: true }).run("get_document");
    expect(result).toMatchObject({ hash: HASH, document: { source: "session", elementor_version: "4.3.2", version_status: "tested" } });
  });

  it("returns one element in full", async () => {
    const result = await setup().run("get_document", { element_id: "164e6f4c" });
    expect(result.element).toMatchObject({ id: "164e6f4c", settings: { title: "Accessibility Philosophy" } });
  });
});

describe("elementor_apply_operations transports", () => {
  it("REST + ability: checks the lock, writes meta, then refreshes caches", async () => {
    const { run, calls, written, snapshots } = setup({ ability: true });
    const result = await run("apply_operations", { expected_hash: HASH, operations: RENAME, idempotency_key: "k".repeat(16) });
    expect(calls).toEqual(["ability", "rest_write", "ability"]);
    expect(JSON.parse((written[0] as { meta: { _elementor_data: string } }).meta._elementor_data)[0].elements[0].settings.title).toBe("Philosophy");
    expect(result).toMatchObject({ transport: "rest", saved_as: "page", cache: "refreshed", previous_hash: HASH, snapshot_id: expect.any(String) });
    expect(snapshots.saved).toHaveLength(1);
  });

  it("stops before writing when the editor has unsaved changes", async () => {
    const { run, calls } = setup({ ability: true, abilityLocked: true });
    await expect(run("apply_operations", { expected_hash: HASH, operations: RENAME })).rejects.toMatchObject({ code: "post_locked" });
    expect(calls).not.toContain("rest_write");
  });

  it("rejects a stale hash without writing", async () => {
    const { run, calls } = setup({ ability: true });
    await expect(run("apply_operations", { expected_hash: "0".repeat(64), operations: RENAME })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(calls).toEqual([]);
  });

  it("requires publish: true for a live page when no session can hold a draft", async () => {
    const { run, calls } = setup({ status: "publish", ability: true });
    await expect(run("apply_operations", { expected_hash: HASH, operations: RENAME })).rejects.toMatchObject({ code: "publish_confirmation_required" });
    const confirmed = await run("apply_operations", { expected_hash: HASH, operations: RENAME, publish: true });
    expect(confirmed).toMatchObject({ transport: "rest", saved_as: "page" });
    expect(calls).toContain("rest_write");
  });

  it("saves a draft preview of a live page through the session, sending full settings", async () => {
    const { run, written, calls } = setup({ status: "publish", session: true });
    const result = await run("apply_operations", { expected_hash: HASH, operations: RENAME });
    expect(calls).not.toContain("rest_write");
    const save = written[0] as { status: string; settings: Record<string, unknown>; elements: ElementNode[] };
    expect(save.status).toBe("autosave");
    expect(save.settings).toMatchObject({ template: "elementor_canvas", hide_title: "yes" });
    expect(save.elements[0]!.elements[0]!.settings).toEqual({ title: "Philosophy" });
    expect(JSON.stringify(save.elements)).not.toContain("htmlCache");
    expect(result).toMatchObject({ transport: "session", saved_as: "draft_preview", preview_url: "https://x.test/?preview=true" });
  });

  it("hash-checks drafts against the caller's autosave, not the live layout", async () => {
    const draftTree: ElementNode[] = [{ ...TREE[0]!, elements: [{ ...TREE[0]!.elements[0]!, settings: { title: "Draft title" } }] }];
    const { run } = setup({ status: "publish", session: true, draftTree });
    await expect(run("apply_operations", { expected_hash: HASH, operations: RENAME })).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(run("apply_operations", { expected_hash: hashTree(draftTree), operations: RENAME })).resolves.toMatchObject({ saved_as: "draft_preview" });
  });

  it("publishes an existing draft as-is with no operations", async () => {
    const { run, written } = setup({ status: "publish", session: true });
    const result = await run("apply_operations", { expected_hash: HASH, operations: [], publish: true, view: "draft" });
    expect((written[0] as { status: string; settings: Record<string, unknown> })).toMatchObject({ status: "publish", settings: { post_status: "publish" } });
    expect(result).toMatchObject({ saved_as: "page", created_ids: [] });
  });

  it("without the ability prefers the session's full editor save", async () => {
    const { run, calls, written } = setup({ session: true });
    const result = await run("apply_operations", { expected_hash: HASH, operations: RENAME });
    expect(calls).toEqual(["session:get_document_config", "session:save_builder"]);
    expect((written[0] as { status: string }).status).toBe("draft");
    expect(result).toMatchObject({ transport: "session", cache: "refreshed" });
  });

  it("refuses a session save while someone holds the edit lock", async () => {
    const { run } = setup({ session: true, locked: { display_name: "Pat" } });
    await expect(run("apply_operations", { expected_hash: HASH, operations: RENAME })).rejects.toMatchObject({ code: "post_locked", message: expect.stringContaining("Pat") });
  });

  it("without ability or session writes over REST and clears the site cache when allowed", async () => {
    const cleared = await setup().run("apply_operations", { expected_hash: HASH, operations: RENAME });
    expect(cleared).toMatchObject({ transport: "rest", cache: "site_cache_cleared", warnings: [] });
    const stale = await setup({ cacheForbidden: true }).run("apply_operations", { expected_hash: HASH, operations: RENAME });
    expect(stale).toMatchObject({ cache: "not_refreshed", warnings: [expect.stringContaining("cache_not_refreshed")] });
  });

  it("surfaces validation errors as tool errors with no write", async () => {
    const { run, calls } = setup({ ability: true });
    await expect(run("apply_operations", { expected_hash: HASH, operations: [{ action: "insert", parent_id: "c0000001", element: { elType: "widget", widgetType: "html" } }] }))
      .rejects.toMatchObject({ code: "unsafe_content", status: 403 });
    expect(calls).toEqual([]);
  });
});

describe("snapshots and widget types", () => {
  it("restores a snapshot through the same save path", async () => {
    const { run, calls } = setup({ ability: true });
    const result = await run("restore_snapshot", { expected_hash: HASH, snapshot_id: "snap" });
    expect(result).toMatchObject({ restored_snapshot_id: "snap", transport: "rest" });
    expect(calls).toContain("rest_write");
    await expect(run("restore_snapshot", { expected_hash: HASH, snapshot_id: "nope" })).rejects.toMatchObject({ code: "snapshot_not_found" });
  });

  it("lists registered widgets through a session and core widgets without one", async () => {
    expect(await setup().run("list_widget_types")).toMatchObject({ source: "core_list", widget_types: expect.arrayContaining(["heading", "button"]) });
    const site = await setup({ session: true }).run("list_widget_types");
    expect(site).toEqual({ source: "site", widget_types: ["heading"] });
    const detail = await setup({ session: true }).run("list_widget_types", { widget_type: "heading" });
    expect(detail).toMatchObject({ settings: [{ name: "title", type: "text", default: "Add Your Heading Text Here" }] });
  });
});
