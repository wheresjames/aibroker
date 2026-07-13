import { randomBytes } from "node:crypto";
import type { WordPressRestClient } from "@aibroker/wordpress-rest";

// Typed WordPress REST tool handlers. server.ts resolves the server, checks policy,
// fetches the REST credential, and builds the context; each handler here is a thin, typed
// mapping onto the hardened REST client. Mutations run through ctx.idempotent so retries
// with the same idempotency key are safe; MIME/size/whitelist checks are typed-tool
// validation, never hidden permission gates.

export interface RestToolCtx {
  input: Record<string, unknown>;
  client: WordPressRestClient;
  // Wrap a mutation so it is idempotent on input.idempotency_key. Read tools skip it.
  idempotent<T>(action: () => Promise<T>): Promise<T>;
  toolError(code: string, status?: number, message?: string): Error & { code: string; status: number };
}

export type RestToolHandler = (ctx: RestToolCtx) => Promise<unknown>;

// ---- helpers -----------------------------------------------------------------------

function str(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) throw fieldError(name);
  return value;
}
function optStr(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function fieldError(name: string): Error & { code: string; status: number } {
  const err = new Error(`Missing or invalid field: ${name}`) as Error & { code: string; status: number };
  err.code = "validation_error";
  err.status = 400;
  return err;
}

// Content types that are registered with show_in_rest but are NOT ordinary editable
// collections — templates, global styles, nav/menu internals, reusable blocks, fonts, and
// media (which has its own dedicated tools). The generalized content engine must refuse them.
const BLOCKED_CONTENT_TYPES = new Set([
  "attachment", "wordpress.global_styles", "wordpress.template", "wordpress.template_part", "wordpress.navigation",
  "nav_menu", "nav_menu_item", "wordpress.block", "wordpress.font_family", "wordpress.font_face"
]);

// Resolve the content `type` param to a WordPress REST base. `post`/`page` are fixed
// aliases; anything else is resolved against /wp/v2/types (slug → rest_base), accepting
// either a type slug or an already-resolved rest_base. Types that are not REST-visible or
// are not ordinary content collections are rejected rather than guessed at.
async function resolveBase(ctx: RestToolCtx): Promise<string> {
  const type = typeof ctx.input.type === "string" && ctx.input.type ? ctx.input.type : "post";
  if (type === "post") return "posts";
  if (type === "page") return "pages";
  const map = await ctx.client.getTypeRestBases();
  const base = map[type]?.rest_base ?? (Object.values(map).find((entry) => entry.rest_base === type)?.rest_base ?? null);
  if (!base) throw ctx.toolError("unknown_content_type", 400, `Unknown or non-REST content type "${type}"`);
  if (BLOCKED_CONTENT_TYPES.has(type) || BLOCKED_CONTENT_TYPES.has(base)) {
    throw ctx.toolError("type_not_allowed", 400, `Content type "${type}" is not a public content collection`);
  }
  return base;
}

function paginationPage(cursor: unknown): number {
  return typeof cursor === "string" && cursor ? Math.max(1, Number.parseInt(cursor, 10) || 1) : 1;
}

function only<T extends Record<string, unknown>>(source: Record<string, unknown>, keys: string[]): T {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  return out as T;
}

// Registered, non-secret settings surfaced by wp_get_settings / wp_update_settings. WP's
// /wp/v2/settings only exposes registered options, but we additionally whitelist so a
// plugin that registers a sensitive option cannot leak through the general settings tool.
const SETTINGS_WHITELIST = [
  "title", "description", "url", "email", "timezone", "date_format", "time_format",
  "start_of_week", "language", "use_smilies", "default_category", "default_post_format",
  "posts_per_page", "show_on_front", "page_on_front", "page_for_posts",
  "default_ping_status", "default_comment_status"
];

const MEDIA_MIME_ALLOWLIST = [
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/svg+xml",
  "application/pdf", "audio/mpeg", "video/mp4"
];
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

const COMMENT_STATUS_MAP: Record<string, string> = { approve: "approved", hold: "hold", spam: "spam", trash: "trash" };

// Reject a stale write by comparing the caller's revision id with the latest revision.
async function assertRevision(ctx: RestToolCtx, base: string, id: string, expected: string): Promise<void> {
  const revisions = await ctx.client.listRevisions(base, id);
  const token = revisions[0]?.id == null ? null : String(revisions[0].id);
  if (token !== expected) throw ctx.toolError("revision_conflict", 409, "Content changed since it was read");
}

// ---- handlers ----------------------------------------------------------------------

export const REST_TOOL_HANDLERS: Record<string, RestToolHandler> = {
  // --- Content ---
  "wordpress.list_content": async (ctx) => {
    const result = await ctx.client.listCollection(await resolveBase(ctx), {
      page: paginationPage(ctx.input.cursor),
      per_page: Number(ctx.input.limit ?? 50),
      ...(optStr(ctx.input, "status") ? { status: optStr(ctx.input, "status") } : {}),
      ...(optStr(ctx.input, "search") ? { search: optStr(ctx.input, "search") } : {})
    }, ["id", "date_gmt", "modified_gmt", "slug", "status", "link", "title", "excerpt", "author", "parent", "featured_media"]);
    return { content: result.items, next_cursor: result.next_cursor, total: result.total };
  },
  "wordpress.get_content": async (ctx) => ({ content: await ctx.client.getResource(await resolveBase(ctx), str(ctx.input, "id"), { context: "edit" }) }),
  "wordpress.create_content": (ctx) =>
    ctx.idempotent(async () => {
      const base = await resolveBase(ctx);
      const body = only(ctx.input, ["title", "content", "excerpt", "slug", "status", "author", "parent", "template", "sticky", "featured_media"]);
      if (body.status === undefined) body.status = "draft";
      return { content: await ctx.client.createResource(base, body) };
    }),
  "wordpress.update_content": (ctx) =>
    ctx.idempotent(async () => {
      const base = await resolveBase(ctx);
      const id = str(ctx.input, "id");
      await assertRevision(ctx, base, id, str(ctx.input, "expected_revision_id"));
      const body = only(ctx.input, ["title", "content", "excerpt", "slug"]);
      return { content: await ctx.client.updateResource(base, id, body) };
    }),
  "wordpress.set_content_status": (ctx) =>
    ctx.idempotent(async () => {
      const base = await resolveBase(ctx);
      await assertRevision(ctx, base, str(ctx.input, "id"), str(ctx.input, "expected_revision_id"));
      return { content: await ctx.client.updateResource(base, str(ctx.input, "id"), { status: str(ctx.input, "status") }) };
    }),
  "wordpress.set_featured_media": (ctx) =>
    ctx.idempotent(async () => {
      const base = await resolveBase(ctx);
      await assertRevision(ctx, base, str(ctx.input, "id"), str(ctx.input, "expected_revision_id"));
      const mediaId = ctx.input.media_id == null ? 0 : Number(ctx.input.media_id);
      return { content: await ctx.client.updateResource(base, str(ctx.input, "id"), { featured_media: mediaId }) };
    }),
  "wordpress.trash_content": (ctx) =>
    ctx.idempotent(async () => {
      const base = await resolveBase(ctx);
      return { content: await ctx.client.deleteResource(base, str(ctx.input, "id"), { force: false }) };
    }),
  "wordpress.restore_trashed_content": (ctx) =>
    ctx.idempotent(async () => {
      const base = await resolveBase(ctx);
      return { content: await ctx.client.updateResource(base, str(ctx.input, "id"), { status: "draft" }) };
    }),
  "wordpress.delete_content_permanently": (ctx) =>
    ctx.idempotent(async () => {
      const base = await resolveBase(ctx);
      return { deleted: await ctx.client.deleteResource(base, str(ctx.input, "id"), { force: true }) };
    }),
  "wordpress.batch_create_content": (ctx) =>
    ctx.idempotent(async () => {
      const base = await resolveBase(ctx);
      const items = Array.isArray(ctx.input.items) ? ctx.input.items : [];
      if (items.length > 25) throw ctx.toolError("validation_error", 400, "Batch is limited to 25 items");
      const created: Record<string, unknown>[] = [];
      for (const item of items) {
        const body = only(item as Record<string, unknown>, ["title", "content", "excerpt", "slug", "status"]);
        if (body.status === undefined) body.status = "draft";
        created.push(await ctx.client.createResource(base, body));
      }
      return { created, count: created.length };
    }),
  "wordpress.list_revisions": async (ctx) => ({ revisions: await ctx.client.listRevisions(await resolveBase(ctx), str(ctx.input, "id")) }),
  "wordpress.get_revision": async (ctx) => ({ revision: await ctx.client.getRevision(await resolveBase(ctx), str(ctx.input, "id"), str(ctx.input, "revision_id")) }),
  "wordpress.restore_revision": (ctx) =>
    ctx.idempotent(async () => ({ content: await ctx.client.restoreRevision(await resolveBase(ctx), str(ctx.input, "id"), str(ctx.input, "revision_id")) })),

  // --- Media ---
  "wordpress.get_media": async (ctx) => ({ media: await ctx.client.getResource("media", str(ctx.input, "id")) }),
  "wordpress.search_media": async (ctx) => {
    const page = paginationPage(ctx.input.cursor);
    const result = await ctx.client.listCollection("media", {
      page,
      per_page: Number(ctx.input.limit ?? 50),
      ...(optStr(ctx.input, "search") ? { search: optStr(ctx.input, "search") } : {}),
      ...(optStr(ctx.input, "media_type") ? { media_type: optStr(ctx.input, "media_type") } : {}),
      ...(optStr(ctx.input, "mime_type") ? { mime_type: optStr(ctx.input, "mime_type") } : {})
    }, ["id", "date_gmt", "slug", "status", "title", "media_type", "mime_type", "source_url", "alt_text"]);
    return { media: result.items, next_cursor: result.next_cursor };
  },
  "wordpress.update_media": (ctx) =>
    ctx.idempotent(async () => ({ media: await ctx.client.updateResource("media", str(ctx.input, "id"), only(ctx.input, ["title", "caption", "alt_text", "description"])) })),
  "wordpress.upload_media": (ctx) =>
    ctx.idempotent(async () => {
      const mime = str(ctx.input, "mime_type");
      if (!MEDIA_MIME_ALLOWLIST.includes(mime)) throw ctx.toolError("media_type_not_allowed", 415, `MIME type ${mime} is not allowed`);
      const encoded = str(ctx.input, "data_base64");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw ctx.toolError("validation_error", 400, "data_base64 is not valid base64");
      }
      let bytes: Buffer;
      try { bytes = Buffer.from(encoded, "base64"); } catch { throw ctx.toolError("validation_error", 400, "data_base64 is not valid base64"); }
      if (bytes.byteLength === 0) throw ctx.toolError("validation_error", 400, "Uploaded media is empty");
      if (bytes.byteLength > MEDIA_MAX_BYTES) throw ctx.toolError("media_too_large", 413, "Uploaded media exceeds the size limit");
      return { media: await ctx.client.uploadMedia({ filename: str(ctx.input, "filename"), contentType: mime, bytes, ...(optStr(ctx.input, "title") ? { title: optStr(ctx.input, "title")! } : {}), ...(optStr(ctx.input, "alt_text") ? { altText: optStr(ctx.input, "alt_text")! } : {}) }) };
    }),
  "wordpress.ingest_media_from_url": (ctx) =>
    ctx.idempotent(async () => ({
      media: await ctx.client.ingestMediaFromUrl({
        url: str(ctx.input, "url"),
        allowedMimeTypes: MEDIA_MIME_ALLOWLIST,
        maxBytes: MEDIA_MAX_BYTES,
        ...(optStr(ctx.input, "filename") ? { filename: optStr(ctx.input, "filename")! } : {}),
        ...(optStr(ctx.input, "title") ? { title: optStr(ctx.input, "title")! } : {})
      })
    })),
  "wordpress.trash_media": (ctx) => ctx.idempotent(async () => ({ media: await ctx.client.deleteResource("media", str(ctx.input, "id"), { force: false }) })),
  "wordpress.delete_media_permanently": (ctx) => ctx.idempotent(async () => ({ deleted: await ctx.client.deleteResource("media", str(ctx.input, "id"), { force: true }) })),

  // --- Taxonomy ---
  "wordpress.get_term": async (ctx) => ({ term: await ctx.client.getResource(str(ctx.input, "taxonomy"), str(ctx.input, "id")) }),
  "wordpress.create_term": (ctx) =>
    ctx.idempotent(async () => ({ term: await ctx.client.createResource(str(ctx.input, "taxonomy"), only(ctx.input, ["name", "slug", "description", "parent"])) })),
  "wordpress.update_term": (ctx) =>
    ctx.idempotent(async () => ({ term: await ctx.client.updateResource(str(ctx.input, "taxonomy"), str(ctx.input, "id"), only(ctx.input, ["name", "slug", "description"])) })),
  "wordpress.delete_term": (ctx) =>
    ctx.idempotent(async () => ({ deleted: await ctx.client.deleteResource(str(ctx.input, "taxonomy"), str(ctx.input, "id"), { force: true }) })),
  "wordpress.assign_terms": (ctx) =>
    ctx.idempotent(async () => {
      const base = await resolveBase(ctx);
      const taxBase = str(ctx.input, "taxonomy_rest_base");
      const termIds = Array.isArray(ctx.input.term_ids) ? ctx.input.term_ids.map(Number) : [];
      return { content: await ctx.client.updateResource(base, str(ctx.input, "id"), { [taxBase]: termIds }) };
    }),

  // --- Comments ---
  "wordpress.list_comments": async (ctx) => {
    const page = paginationPage(ctx.input.cursor);
    const result = await ctx.client.listCollection("comments", {
      page,
      per_page: Number(ctx.input.limit ?? 50),
      ...(optStr(ctx.input, "post") ? { post: optStr(ctx.input, "post") } : {}),
      ...(optStr(ctx.input, "status") ? { status: optStr(ctx.input, "status") } : {})
    }, ["id", "post", "parent", "status", "date_gmt", "author_name", "content", "link"]);
    return { comments: result.items, next_cursor: result.next_cursor };
  },
  "wordpress.get_comment": async (ctx) => ({ comment: await ctx.client.getResource("comments", str(ctx.input, "id"), { fields: ["id", "post", "parent", "status", "date_gmt", "author_name", "content", "link"] }) }),
  "wordpress.create_comment": (ctx) =>
    ctx.idempotent(async () => ({ comment: await ctx.client.createResource("comments", { post: Number(str(ctx.input, "post")), content: str(ctx.input, "content"), ...(ctx.input.parent != null ? { parent: Number(ctx.input.parent) } : {}) }) })),
  "wordpress.update_comment": (ctx) =>
    ctx.idempotent(async () => ({ comment: await ctx.client.updateResource("comments", str(ctx.input, "id"), { content: str(ctx.input, "content") }) })),
  "wordpress.set_comment_status": (ctx) =>
    ctx.idempotent(async () => {
      const status = COMMENT_STATUS_MAP[str(ctx.input, "status")];
      if (!status) throw ctx.toolError("validation_error", 400, "Unknown comment status");
      return { comment: await ctx.client.updateResource("comments", str(ctx.input, "id"), { status }) };
    }),
  "wordpress.restore_comment": (ctx) =>
    ctx.idempotent(async () => ({ comment: await ctx.client.updateResource("comments", str(ctx.input, "id"), { status: "hold" }) })),
  "wordpress.delete_comment_permanently": (ctx) =>
    ctx.idempotent(async () => ({ deleted: await ctx.client.deleteResource("comments", str(ctx.input, "id"), { force: true }) })),

  // --- Navigation & design ---
  "wordpress.list_menus": async (ctx) => ({ menus: await ctx.client.listMenus() }),
  "wordpress.create_menu": (ctx) => ctx.idempotent(async () => ({ menu: await ctx.client.createResource("menus", only(ctx.input, ["name", "slug", "locations"])) })),
  "wordpress.update_menu": (ctx) => ctx.idempotent(async () => ({ menu: await ctx.client.updateResource("menus", str(ctx.input, "id"), only(ctx.input, ["name", "locations"])) })),
  "wordpress.delete_menu": (ctx) => ctx.idempotent(async () => ({ deleted: await ctx.client.deleteResource("menus", str(ctx.input, "id"), { force: true }) })),
  "wordpress.list_menu_items": async (ctx) => {
    const result = await ctx.client.listCollection("menu-items", { menus: str(ctx.input, "menu"), per_page: Number(ctx.input.limit ?? 100) });
    return { items: result.items };
  },
  "wordpress.create_menu_item": (ctx) => ctx.idempotent(async () => ({ item: await ctx.client.createResource("menu-items", { ...only(ctx.input, ["title", "url", "status", "parent"]), menus: Number(ctx.input.menu) }) })),
  "wordpress.update_menu_item": (ctx) => ctx.idempotent(async () => ({ item: await ctx.client.updateResource("menu-items", str(ctx.input, "id"), only(ctx.input, ["title", "url", "parent", "menu_order"])) })),
  "wordpress.delete_menu_item": (ctx) => ctx.idempotent(async () => ({ deleted: await ctx.client.deleteResource("menu-items", str(ctx.input, "id"), { force: true }) })),
  "wordpress.list_templates": async (ctx) => {
    const kind = ctx.input.kind === "template-parts" ? "template-parts" : "templates";
    return { templates: await ctx.client.listTemplates(kind) };
  },
  "wordpress.get_active_theme": async (ctx) => ({ theme: await ctx.client.getActiveTheme() }),
  "wordpress.get_theme_global_styles": async (ctx) => ({ global_styles: await ctx.client.getThemeGlobalStyles(str(ctx.input, "stylesheet")) }),
  "wordpress.list_theme_style_variations": async (ctx) => ({ variations: await ctx.client.listThemeStyleVariations(str(ctx.input, "stylesheet")) }),
  "wordpress.get_global_styles": async (ctx) => ({ global_styles: await ctx.client.getGlobalStyles(str(ctx.input, "id")) }),
  "wordpress.update_global_styles": (ctx) =>
    ctx.idempotent(async () => ({ global_styles: await ctx.client.updateGlobalStyles(str(ctx.input, "id"), only(ctx.input, ["styles", "settings"])) })),

  // --- Typed server settings ---
  "wordpress.get_settings": async (ctx) => {
    const all = await ctx.client.getSettings();
    // Return only whitelisted, non-secret keys.
    const settings: Record<string, unknown> = {};
    for (const key of SETTINGS_WHITELIST) if (key in all) settings[key] = all[key];
    return { settings };
  },
  "wordpress.update_settings": (ctx) =>
    ctx.idempotent(async () => {
      const requested = (ctx.input.settings ?? {}) as Record<string, unknown>;
      const rejected = Object.keys(requested).filter((key) => !SETTINGS_WHITELIST.includes(key));
      if (rejected.length) throw ctx.toolError("setting_not_allowed", 400, `Settings not permitted: ${rejected.join(", ")}`);
      const applied = only(requested, SETTINGS_WHITELIST);
      const all = await ctx.client.updateSettings(applied);
      const settings: Record<string, unknown> = {};
      for (const key of SETTINGS_WHITELIST) if (key in all) settings[key] = all[key];
      return { settings };
    }),

  // --- Users & roles ---
  "wordpress.list_users": async (ctx) => {
    const page = paginationPage(ctx.input.cursor);
    // Field minimization: no email in the list view.
    const result = await ctx.client.listCollection("users", {
      page,
      per_page: Number(ctx.input.limit ?? 50),
      ...(optStr(ctx.input, "search") ? { search: optStr(ctx.input, "search") } : {}),
      ...(optStr(ctx.input, "roles") ? { roles: optStr(ctx.input, "roles") } : {})
    }, ["id", "name", "slug", "roles"]);
    return { users: result.items, next_cursor: result.next_cursor };
  },
  "wordpress.get_user": async (ctx) => ({ user: await ctx.client.getResource("users", str(ctx.input, "id"), { context: "edit", fields: ["id", "name", "slug", "email", "roles", "registered_date"] }) }),
  "wordpress.list_roles": async (ctx) => {
    // WordPress has no core roles collection; derive the role set from users.
    const result = await ctx.client.listCollection("users", { per_page: 100, context: "edit" }, ["roles"]);
    const roles = new Set<string>();
    for (const user of result.items) for (const role of (Array.isArray(user.roles) ? user.roles : [])) roles.add(String(role));
    return { roles: [...roles].sort() };
  },
  "wordpress.create_user": (ctx) =>
    ctx.idempotent(async () => {
      // Password: generated here if not supplied. Returned once, never stored.
      const password = optStr(ctx.input, "password") ?? generatePassword();
      const created = await ctx.client.createResource("users", {
        username: str(ctx.input, "username"),
        email: str(ctx.input, "email"),
        password,
        ...(optStr(ctx.input, "name") ? { name: optStr(ctx.input, "name") } : {}),
        ...(Array.isArray(ctx.input.roles) && ctx.input.roles.length ? { roles: ctx.input.roles } : {})
      });
      // One-time secret: surfaced in the result but redacted from audit summaries and
      // captured bodies by the audit layer's secret-key redaction (field name "password").
      return { user: only(created, ["id", "username", "email", "name", "roles"]), password };
    }),
  "wordpress.update_user": (ctx) =>
    ctx.idempotent(async () => ({ user: only(await ctx.client.updateResource("users", str(ctx.input, "id"), only(ctx.input, ["email", "name"])), ["id", "name", "email", "roles"]) })),
  "wordpress.assign_user_role": (ctx) =>
    ctx.idempotent(async () => {
      const roles = Array.isArray(ctx.input.roles) ? ctx.input.roles.map(String) : [];
      if (roles.length === 0) throw ctx.toolError("validation_error", 400, "At least one role is required");
      return { user: only(await ctx.client.updateResource("users", str(ctx.input, "id"), { roles }), ["id", "roles"]) };
    }),
  "wordpress.delete_user": (ctx) =>
    ctx.idempotent(async () => {
      const query: Record<string, string | number> = {};
      if (ctx.input.reassign != null) query.reassign = Number(ctx.input.reassign);
      return { deleted: await ctx.client.deleteResource("users", str(ctx.input, "id"), { force: true, query }) };
    }),
  "wordpress.create_application_password": (ctx) =>
    ctx.idempotent(async () => {
      const created = await ctx.client.createApplicationPassword(str(ctx.input, "user_id"), str(ctx.input, "name"));
      // Secret shown once; redacted from logs, audited by uuid only.
      return { uuid: created.uuid, password: created.password };
    }),
  "wordpress.revoke_application_password": (ctx) =>
    ctx.idempotent(async () => {
      await ctx.client.revokeApplicationPassword(str(ctx.input, "user_id"), str(ctx.input, "uuid"));
      return { revoked: true, uuid: ctx.input.uuid };
    })
};

function generatePassword(): string {
  // 24 random bytes → URL-safe string. Only ever returned once to the caller.
  return randomBytes(24).toString("base64url");
}
