import { createHash } from "node:crypto";
import { WordPressRestError, type WordPressRestClient, type WordPressSessionClient } from "@aibroker/wordpress-rest";
import type { PageBuilderToolCtx } from "../adapter.js";
import { canonicalize, hashTree, parseElementorData, type ElementNode } from "./tree.js";

// Elementor transports (AB-ELEMENTOR 5.1, revised by the Step 0 spike):
//  - REST: Elementor ≥3.27 registers _elementor_data (and _elementor_page_settings) for
//    REST, so reads and writes use the existing application password. A raw meta write
//    skips Elementor's save pipeline, so caches are refreshed afterwards by the
//    elementor/update-page-settings ability (Elementor ≥4.3, WP ≥6.9) or, failing that,
//    the site-wide cache endpoint.
//  - Session: the caller's own WordPress login drives the editor's save_builder
//    action. Used for draft previews of live pages, for sites whose REST path cannot
//    refresh caches, for templates when the REST credential is not an administrator,
//    and for Elementor <3.27.

export const FINALIZE_ABILITY = "elementor/update-page-settings";
export const TEMPLATE_TYPE = "elementor_library";
const LIVE_STATUSES = new Set(["publish", "private"]);
const BLOCKED_TYPES = new Set(["attachment", "nav_menu_item", "wp_template", "wp_template_part", "wp_navigation", "wp_block", "wp_global_styles"]);
// Document-level fields Elementor keeps alongside page settings in the editor. They
// belong to the regular content tools (title, status, excerpt, ...), not to page settings.
export const DOCUMENT_KEYS = new Set(["post_title", "post_status", "post_excerpt", "menu_order", "comment_status", "post_featured_image"]);

export type DocumentView = "live" | "draft";

interface SessionDocument {
  settings: Record<string, unknown>;
  locked: unknown;
  version: string | null;
}

export interface ElementorDocument {
  postId: number;
  restBase: string;
  type: string;
  view: DocumentView;
  source: "rest" | "session";
  tree: ElementNode[];
  hash: string;
  // _elementor_page_settings plus the page template, the way Elementor presents them.
  pageSettings: Record<string, unknown>;
  settingsHash: string;
  status: string;
  title: string;
  link: string | null;
  session?: SessionDocument;
}

export interface DocumentChange {
  tree: ElementNode[];
  treeChanged: boolean;
  // Complete new page settings (not a patch) when they change.
  pageSettings?: Record<string, unknown>;
}

export interface SaveResult {
  transport: "rest" | "session";
  // "page" = the post itself (whatever its status); "draft_preview" = the caller's
  // Elementor autosave of a published page, visible only via the preview link.
  saved_as: "page" | "draft_preview";
  cache: "refreshed" | "site_cache_cleared" | "not_refreshed";
  preview_url?: string;
  warnings: string[];
}

export function isLive(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

export function postId(ctx: PageBuilderToolCtx, field = "id"): number {
  const raw = ctx.input[field];
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) throw ctx.toolError("validation_error", 400, `${field} must be a positive post id`);
  return value;
}

// Stable-key JSON so equal settings hash equally regardless of key order.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashSettings(settings: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(settings)).digest("hex");
}

function asSettings(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

export async function resolveRestBase(ctx: PageBuilderToolCtx): Promise<{ type: string; base: string }> {
  const type = typeof ctx.input.type === "string" && ctx.input.type ? ctx.input.type : "page";
  if (type === "page") return { type, base: "pages" };
  if (type === "post") return { type, base: "posts" };
  if (type === TEMPLATE_TYPE) return { type, base: TEMPLATE_TYPE };
  if (BLOCKED_TYPES.has(type)) throw ctx.toolError("type_not_allowed", 400, `Content type "${type}" cannot hold an Elementor layout`);
  const map = await ctx.rest.getTypeRestBases();
  const base = map[type]?.rest_base ?? Object.values(map).find((entry) => entry.rest_base === type)?.rest_base;
  if (!base) throw ctx.toolError("unknown_content_type", 400, `Unknown or non-REST content type "${type}"`);
  return { type, base };
}

function rendered(value: unknown): string {
  if (typeof value === "string") return value;
  const obj = value as { raw?: unknown; rendered?: unknown } | undefined;
  return typeof obj?.raw === "string" ? obj.raw : typeof obj?.rendered === "string" ? obj.rendered : "";
}

// get_document_config switches a page into builder mode as a side effect, so it may only
// be called once the page is known to be an Elementor page already.
function assertBuilt(ctx: PageBuilderToolCtx, post: Record<string, unknown>, id: number): void {
  const meta = post.meta as Record<string, unknown> | undefined;
  if (meta && "_elementor_edit_mode" in meta) {
    if (meta._elementor_edit_mode !== "builder") throw notElementor(ctx);
    return;
  }
  const content = (post.content as { rendered?: string } | undefined)?.rendered ?? "";
  if (!new RegExp(`data-elementor-id=["']?${id}["'\\s>]`).test(content)) throw notElementor(ctx);
}

function notElementor(ctx: PageBuilderToolCtx): Error {
  return ctx.toolError("not_elementor_document", 409, "This page is not built with Elementor. Edit it with the regular content tools instead.");
}

async function requireSession(ctx: PageBuilderToolCtx, code: string, message: string): Promise<WordPressSessionClient> {
  const session = await ctx.session();
  if (!session) throw ctx.toolError(code, 409, message);
  return session;
}

async function sessionDocument(ctx: PageBuilderToolCtx, session: WordPressSessionClient, id: number): Promise<{ tree: ElementNode[]; doc: SessionDocument }> {
  const responses = await session.elementorAjax(id, { doc: { action: "get_document_config", data: { id } } });
  const response = responses.doc;
  if (!response?.success) throw ctx.toolError("elementor_request_failed", 502, `Elementor could not load the document: ${String(response?.data ?? "no response").slice(0, 200)}`);
  const data = response.data as { elements?: unknown; settings?: { settings?: Record<string, unknown> }; user?: { locked?: unknown }; version?: string };
  return {
    tree: canonicalize(data.elements ?? []),
    doc: { settings: asSettings(data.settings?.settings), locked: data.user?.locked ?? false, version: data.version ?? null }
  };
}

function sessionPageSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !DOCUMENT_KEYS.has(key)));
}

export async function loadDocument(ctx: PageBuilderToolCtx, view: DocumentView): Promise<ElementorDocument> {
  const id = postId(ctx);
  const { type, base } = await resolveRestBase(ctx);
  let post: Record<string, unknown> | null = null;
  try {
    post = await ctx.rest.getResource(base, String(id), { context: "edit" });
  } catch (err) {
    // Elementor blocks REST access to saved templates for non-administrators; the
    // editor session can still read them.
    if (!(type === TEMPLATE_TYPE && err instanceof WordPressRestError && [401, 403].includes(err.statusCode))) throw err;
  }
  // Saved templates are always Elementor documents.
  if (post && type !== TEMPLATE_TYPE) assertBuilt(ctx, post, id);
  const meta = post?.meta as Record<string, unknown> | undefined;
  const restReadable = Boolean(meta && "_elementor_data" in meta);

  // The draft view is the caller's own Elementor autosave, which only the editor
  // session can read (REST autosaves carry no builder meta writes).
  if (view === "draft" || !restReadable) {
    const session = await requireSession(ctx,
      view === "draft" ? "wordpress_session_required" : post ? "elementor_rest_unavailable" : "wordpress_session_required",
      view === "draft"
        ? "Draft previews of published pages need your WordPress login session. Connect it in AIBroker under WordPress Sessions, or pass publish: true to change the live page."
        : post
          ? "This site's Elementor does not expose page layouts over REST (needs Elementor 3.27 or newer). Connect your WordPress login session in AIBroker under WordPress Sessions to edit it."
          : "Elementor only lets administrators read saved templates over REST. Connect your WordPress login session in AIBroker under WordPress Sessions, or use an administrator application password.");
    const loaded = await sessionDocument(ctx, session, id);
    const pageSettings = sessionPageSettings(loaded.doc.settings);
    return {
      postId: id, restBase: base, type, view, source: "session", tree: loaded.tree, hash: hashTree(loaded.tree),
      pageSettings, settingsHash: hashSettings(pageSettings), session: loaded.doc,
      status: String(post?.status ?? loaded.doc.settings.post_status ?? "unknown"),
      title: post ? rendered(post.title) : String(loaded.doc.settings.post_title ?? ""),
      link: typeof post?.link === "string" ? post.link : null
    };
  }
  const tree = parseElementorData(meta!._elementor_data);
  const pageSettings = asSettings(meta!._elementor_page_settings);
  if (typeof post!.template === "string" && post!.template) pageSettings.template = post!.template;
  return {
    postId: id, restBase: base, type, view, source: "rest", tree, hash: hashTree(tree),
    pageSettings, settingsHash: hashSettings(pageSettings),
    status: String(post!.status ?? "unknown"), title: rendered(post!.title), link: typeof post!.link === "string" ? post!.link : null
  };
}

// Layout of a saved template (for insert_template / unlink_global). REST when the
// credential may read templates, otherwise the caller's session.
export async function loadTemplateTree(ctx: PageBuilderToolCtx, templateId: number): Promise<ElementNode[] | null> {
  try {
    const post = await ctx.rest.getResource(TEMPLATE_TYPE, String(templateId), { context: "edit" });
    const meta = post.meta as Record<string, unknown> | undefined;
    if (meta && "_elementor_data" in meta) return parseElementorData(meta._elementor_data);
  } catch (err) {
    if (err instanceof WordPressRestError && err.statusCode === 404) return null;
    if (!(err instanceof WordPressRestError && [401, 403].includes(err.statusCode))) throw err;
  }
  const session = await ctx.session();
  if (!session) {
    throw ctx.toolError("wordpress_session_required", 409,
      "Reading saved templates needs an administrator application password or your WordPress login session (connect it under WordPress Sessions).");
  }
  return (await sessionDocument(ctx, session, templateId)).tree;
}

const abilityCache = new WeakMap<WordPressRestClient, Promise<boolean>>();
export function finalizeAbilityAvailable(rest: WordPressRestClient): Promise<boolean> {
  let cached = abilityCache.get(rest);
  if (!cached) {
    cached = rest.getAbility(FINALIZE_ABILITY).then((ability) => ability !== null).catch(() => false);
    abilityCache.set(rest, cached);
  }
  return cached;
}

function lockedBy(locked: unknown): string | null {
  if (!locked) return null;
  if (typeof locked === "string") return locked;
  const user = locked as { display_name?: string; name?: string };
  return user.display_name ?? user.name ?? "another user";
}

async function saveViaSession(ctx: PageBuilderToolCtx, session: WordPressSessionClient, doc: ElementorDocument, change: DocumentChange, asDraft: boolean): Promise<SaveResult> {
  const config = doc.session ?? (await sessionDocument(ctx, session, doc.postId)).doc;
  const holder = lockedBy(config.locked);
  if (holder) throw ctx.toolError("post_locked", 409, `${holder} has this page open in the Elementor editor. Ask them to save and close it, then retry.`);
  // save_builder replaces page settings and resets the template unless the full current
  // settings are sent back, exactly as the editor does. A settings change replaces the
  // page-settings part while keeping the document fields.
  const current = asDraft ? config.settings : { ...config.settings, post_status: doc.status };
  const settings = change.pageSettings
    ? { ...Object.fromEntries(Object.entries(current).filter(([key]) => DOCUMENT_KEYS.has(key))), ...change.pageSettings }
    : current;
  const responses = await session.elementorAjax(doc.postId, {
    save: { action: "save_builder", data: { status: asDraft ? "autosave" : doc.status, elements: change.tree, settings } }
  });
  const response = responses.save;
  if (!response?.success) throw ctx.toolError("elementor_save_failed", 502, `Elementor rejected the save: ${String(response?.data ?? "no response").slice(0, 200)}`);
  const data = response.data as { config?: { document?: { urls?: { wp_preview?: string } } } };
  const preview = data.config?.document?.urls?.wp_preview;
  return { transport: "session", saved_as: asDraft ? "draft_preview" : "page", cache: "refreshed", ...(preview ? { preview_url: preview } : {}), warnings: [] };
}

async function runFinalize(ctx: PageBuilderToolCtx, id: number): Promise<void> {
  try {
    await ctx.rest.runAbility(FINALIZE_ABILITY, { post_id: id, settings: {} });
  } catch (err) {
    if (err instanceof WordPressRestError && err.statusCode === 409) {
      throw ctx.toolError("post_locked", 409, "Someone has unsaved changes to this page in the Elementor editor. Ask them to save or discard, then retry.");
    }
    throw err;
  }
}

function restBody(change: DocumentChange): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (change.treeChanged) meta._elementor_data = JSON.stringify(change.tree);
  const body: Record<string, unknown> = {};
  if (change.pageSettings) {
    const { template, ...settings } = change.pageSettings;
    meta._elementor_page_settings = settings;
    // An empty template means "default" to WordPress.
    body.template = typeof template === "string" ? template : "";
  }
  return { ...body, meta };
}

const CACHE_STALE_WARNING = "cache_not_refreshed: visitors may see the previous version until Elementor's cache expires or the page is saved in the editor. Connecting your WordPress session, or using an administrator application password, lets AIBroker refresh it.";

// Save a change. Transport order follows the decisions in AB-ELEMENTOR: drafts of live
// pages need the session; otherwise REST + ability, then session, then REST + site cache.
export async function saveDocument(ctx: PageBuilderToolCtx, doc: ElementorDocument, change: DocumentChange, publish: boolean): Promise<SaveResult> {
  const live = isLive(doc.status);
  if (live && !publish) {
    const session = await requireSession(ctx, "publish_confirmation_required",
      "This page is published, so the change would go live immediately. Pass publish: true to confirm, or connect your WordPress session in AIBroker to save a draft preview instead.");
    return saveViaSession(ctx, session, doc, change, true);
  }
  if (doc.source === "session") return saveViaSession(ctx, (await ctx.session())!, doc, change, false);

  if (await finalizeAbilityAvailable(ctx.rest)) {
    // The ability refuses (409) while an editor tab holds unsaved changes, so running
    // it first doubles as the edit-lock check before anything is written.
    await runFinalize(ctx, doc.postId);
    await ctx.rest.updateResource(doc.restBase, String(doc.postId), restBody(change));
    try {
      await runFinalize(ctx, doc.postId);
      return { transport: "rest", saved_as: "page", cache: "refreshed", warnings: [] };
    } catch {
      return { transport: "rest", saved_as: "page", cache: "not_refreshed", warnings: [CACHE_STALE_WARNING] };
    }
  }
  const session = await ctx.session();
  if (session) return saveViaSession(ctx, session, doc, change, false);
  await ctx.rest.updateResource(doc.restBase, String(doc.postId), restBody(change));
  try {
    await ctx.rest.clearElementorCache();
    return { transport: "rest", saved_as: "page", cache: "site_cache_cleared", warnings: [] };
  } catch {
    return { transport: "rest", saved_as: "page", cache: "not_refreshed", warnings: [CACHE_STALE_WARNING] };
  }
}

// Detection for probes: REST meta registration, abilities, and the version advertised
// in the front-end generator tag (sites may strip it; version is then null).
export async function detectElementor(rest: WordPressRestClient): Promise<{ active: boolean; version: string | null; details: Record<string, unknown> }> {
  const [metaKeys, ability, html] = await Promise.all([
    rest.getRegisteredMetaKeys("pages").catch(() => [] as string[]),
    finalizeAbilityAvailable(rest),
    rest.getPublicHtml("/").catch(() => "")
  ]);
  const version = /<meta name="generator" content="Elementor ([0-9][0-9.]*)/.exec(html)?.[1] ?? null;
  const restMeta = metaKeys.includes("_elementor_data");
  return {
    active: restMeta || version !== null || ability,
    version,
    details: {
      rest_meta: restMeta,
      finalize_ability: ability,
      cache_refresh: ability ? "ability" : "session_or_admin_credential",
      version_status: versionStatus(version)
    }
  };
}

// D3 version gate: contract-tested on 4.3; 3.x/4.x share the stored format.
export const TESTED_ELEMENTOR = "4.3";
export function versionStatus(version: string | null): "tested" | "untested" | "unsupported" | "unknown" {
  if (!version) return "unknown";
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major !== 3 && major !== 4) return "unsupported";
  const [testedMajor, testedMinor] = TESTED_ELEMENTOR.split(".").map(Number);
  return major === testedMajor && minor === testedMinor ? "tested" : "untested";
}
