import { connectorFetch, validateConnectorTarget } from "@aibroker/core";

export interface WordPressRestCredentials {
  username: string;
  applicationPassword: string;
}

export interface WordPressRestClientOptions {
  baseUrl: string;
  credentials: WordPressRestCredentials;
  allowPrivateTargets?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class WordPressRestClient {
  private readonly baseUrl: string;
  private readonly credentials: WordPressRestCredentials;
  private readonly allowPrivateTargets: boolean;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  // Per-instance cache of the /wp/v2/types slug → rest_base map. A client is short-lived
  // (one per tool call / discovery run), so this just avoids re-fetching within that call.
  private typeMap?: Record<string, { rest_base: string | null; name: string | null }>;

  constructor(options: WordPressRestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.credentials = options.credentials;
    this.allowPrivateTargets = options.allowPrivateTargets ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async testConnection(): Promise<{ status: "ok"; name?: string; url?: string }> {
    const body = await this.request<{ name?: string; url?: string }>("/wp-json");
    return {
      status: "ok",
      ...(body.name ? { name: body.name } : {}),
      ...(body.url ? { url: body.url } : {})
    };
  }

  async getServerSummary(): Promise<WordPressSiteSummary> {
    const root = await this.request<WordPressRoot>("/wp-json");
    return {
      name: root.name ?? "WordPress Server",
      url: root.url ?? this.baseUrl,
      description: root.description ?? null,
      capabilities: ["rest_pages", "create_draft_page"]
    };
  }

  async listPages(input: ListPagesInput): Promise<PaginatedPages> {
    const result = await this.listContent("/wp-json/wp/v2/pages", input);
    return { pages: result.items, next_cursor: result.next_cursor };
  }

  async getPage(pageId: string, includeContent = true): Promise<BrokerPage> {
    const fields = includeContent
      ? "id,date_gmt,modified_gmt,slug,status,link,title,content"
      : "id,date_gmt,modified_gmt,slug,status,link,title";
    const page = await this.request<WordPressPage>(`/wp-json/wp/v2/pages/${encodeURIComponent(pageId)}?_fields=${fields}`);
    return {
      ...normalizePageSummary(page),
      revision_id: page.modified_gmt ?? null,
      content_format: "wordpress_block_html",
      ...(includeContent ? { content: rendered(page.content) } : {})
    };
  }

  async createDraftPage(input: CreateDraftPageInput): Promise<BrokerDraftPage> {
    const page = await this.request<WordPressPage>("/wp-json/wp/v2/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        slug: input.slug || undefined,
        content: input.content,
        status: "draft"
      })
    });
    return {
      id: String(page.id),
      title: rendered(page.title) || input.title,
      slug: page.slug ?? input.slug ?? "",
      status: "draft",
      edit_link: `${this.baseUrl}/wp-admin/post.php?post=${page.id}&action=edit`,
      created_at: page.date_gmt ? `${page.date_gmt}Z` : new Date().toISOString()
    };
  }

  async updateDraftPage(input: UpdateDraftPageInput): Promise<BrokerPage> {
    const current = await this.getPage(input.pageId, true);
    if (current.status !== "draft") {
      throw new WordPressRestError(409, "Only draft pages can be updated");
    }
    if (current.revision_id !== input.expectedRevisionId) {
      throw new WordPressRestError(409, "Draft changed since it was read");
    }
    const body: Record<string, unknown> = { status: "draft" };
    if (input.title != null) body.title = input.title;
    if (input.content != null) body.content = input.content;
    const page = await this.request<WordPressPage>(`/wp-json/wp/v2/pages/${encodeURIComponent(input.pageId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return {
      ...normalizePageSummary(page),
      revision_id: page.modified_gmt ?? null,
      content_format: "wordpress_block_html",
      content: rendered(page.content)
    };
  }

  async publishDraftPage(pageId: string): Promise<BrokerPage> {
    const current = await this.getPage(pageId, true);
    if (current.status !== "draft") {
      throw new WordPressRestError(409, "Only draft pages can be published through AIBroker");
    }
    const page = await this.request<WordPressPage>(`/wp-json/wp/v2/pages/${encodeURIComponent(pageId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "publish" })
    });
    return {
      ...normalizePageSummary(page),
      revision_id: page.modified_gmt ?? null,
      content_format: "wordpress_block_html",
      content: rendered(page.content)
    };
  }

  async listPosts(input: ListPagesInput): Promise<{ posts: BrokerPageSummary[]; next_cursor: string | null }> {
    const result = await this.listContent("/wp-json/wp/v2/posts", input);
    return { posts: result.items, next_cursor: result.next_cursor };
  }

  async getPost(postId: string, includeContent = true): Promise<BrokerPage> {
    const fields = includeContent
      ? "id,date_gmt,modified_gmt,slug,status,link,title,content"
      : "id,date_gmt,modified_gmt,slug,status,link,title";
    const post = await this.request<WordPressPage>(`/wp-json/wp/v2/posts/${encodeURIComponent(postId)}?_fields=${fields}`);
    return {
      ...normalizePageSummary(post),
      revision_id: post.modified_gmt ?? null,
      content_format: "wordpress_block_html",
      ...(includeContent ? { content: rendered(post.content) } : {})
    };
  }

  async listMedia(input: ListPagesInput): Promise<{ media: Record<string, unknown>[]; next_cursor: string | null }> {
    const page = input.cursor ? Number.parseInt(input.cursor, 10) : 1;
    const perPage = clamp(input.limit ?? 50, 1, 100);
    const response = await this.requestWithHeaders<Record<string, unknown>[]>(
      `/wp-json/wp/v2/media?page=${page}&per_page=${perPage}&_fields=id,date_gmt,modified_gmt,slug,status,link,title,media_type,mime_type,source_url`
    );
    const totalPages = Number.parseInt(response.headers.get("x-wp-totalpages") ?? "1", 10);
    return { media: response.body, next_cursor: page < totalPages ? String(page + 1) : null };
  }

  async getMedia(mediaId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/wp-json/wp/v2/media/${encodeURIComponent(mediaId)}`);
  }

  async listTaxonomies(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/wp-json/wp/v2/taxonomies");
  }

  async listTerms(taxonomy: string, input: ListPagesInput): Promise<{ terms: Record<string, unknown>[]; next_cursor: string | null }> {
    const page = input.cursor ? Number.parseInt(input.cursor, 10) : 1;
    const perPage = clamp(input.limit ?? 50, 1, 100);
    const response = await this.requestWithHeaders<Record<string, unknown>[]>(
      `/wp-json/wp/v2/${encodeURIComponent(taxonomy)}?page=${page}&per_page=${perPage}`
    );
    const totalPages = Number.parseInt(response.headers.get("x-wp-totalpages") ?? "1", 10);
    return { terms: response.body, next_cursor: page < totalPages ? String(page + 1) : null };
  }

  async listCustomPostTypes(): Promise<Record<string, unknown>> {
    const types = await this.request<Record<string, { slug?: string; rest_base?: string; name?: string }>>("/wp-json/wp/v2/types");
    return Object.fromEntries(
      Object.entries(types).filter(([slug]) => !["post", "page", "attachment", "nav_menu_item", "wordpress.block"].includes(slug))
    );
  }

  // Truthful capability discovery (Phase 1.6). Probes what the REST connector can actually
  // do for this server: reachability, authentication, namespaces, content types, taxonomies,
  // and media support. Reports availability only — it never implies authorization.
  async discoverCapabilities(): Promise<RestDiscovery> {
    let root: WordPressRestRoot;
    try {
      root = await this.request<WordPressRestRoot>("/wp-json");
    } catch (err) {
      if (err instanceof WordPressRestError && (err.statusCode === 401 || err.statusCode === 403)) {
        return { reachable: true, authenticated: false, wordpressVersion: null, isMultisite: null, namespaces: [], contentTypes: [], taxonomies: [], mediaSupported: false, design: null, errorCode: "auth_failed", errorMessage: this.authenticationErrorDetail("/wp-json", err) };
      }
      if (err instanceof WordPressRestError && !["connector_unavailable", "timeout", "invalid_response"].includes(err.wpCode ?? "")) {
        return { reachable: true, authenticated: false, wordpressVersion: null, isMultisite: null, namespaces: [], contentTypes: [], taxonomies: [], mediaSupported: false, design: null, errorCode: "rest_error", errorMessage: err.message };
      }
      return { reachable: false, authenticated: false, wordpressVersion: null, isMultisite: null, namespaces: [], contentTypes: [], taxonomies: [], mediaSupported: false, design: null,
        errorCode: err instanceof WordPressRestError ? err.wpCode ?? "unreachable" : "unreachable",
        errorMessage: err instanceof Error ? err.message : "connection failed" };
    }

    const namespaces = Array.isArray(root.namespaces) ? root.namespaces : [];
    // The REST index is public on a normal WordPress installation, so a 200 response from
    // /wp-json does not prove that the supplied application password is valid. Verify the
    // credential against the authenticated current-user endpoint before reporting success.
    try {
      await this.request<Record<string, unknown>>("/wp-json/wp/v2/users/me?context=edit");
    } catch (err) {
      if (err instanceof WordPressRestError && (err.statusCode === 401 || err.statusCode === 403)) {
        return { reachable: true, authenticated: false, wordpressVersion: null, isMultisite: null, namespaces,
          contentTypes: [], taxonomies: [], mediaSupported: false, design: null, errorCode: "auth_failed",
          errorMessage: this.authenticationErrorDetail("/wp-json/wp/v2/users/me?context=edit", err) };
      }
      return { reachable: true, authenticated: false, wordpressVersion: null, isMultisite: null, namespaces,
        contentTypes: [], taxonomies: [], mediaSupported: false, design: null, errorCode: "auth_probe_failed",
        errorMessage: err instanceof Error ? err.message : "WordPress credential verification failed." };
    }
    // Best-effort secondary probes; a server may restrict these without being unreachable.
    const contentTypes = await this.safeKeys("/wp-json/wp/v2/types");
    const taxonomies = await this.safeKeys("/wp-json/wp/v2/taxonomies");
    const design = await this.probeDesign();
    return {
      reachable: true,
      authenticated: true,
      wordpressVersion: null,
      // The REST root doesn't reliably expose multisite status without a plugin; report
      // unknown rather than guessing (Phase 4 introduces the real multisite model).
      isMultisite: null,
      namespaces,
      contentTypes,
      taxonomies,
      mediaSupported: contentTypes.includes("attachment") || namespaces.includes("wp/v2"),
      design
    };
  }

  private async safeKeys(path: string): Promise<string[]> {
    try {
      const body = await this.request<Record<string, unknown>>(path);
      return body && typeof body === "object" ? Object.keys(body) : [];
    } catch {
      return [];
    }
  }

  private async listContent(path: string, input: ListPagesInput): Promise<{ items: BrokerPageSummary[]; next_cursor: string | null }> {
    const page = input.cursor ? Number.parseInt(input.cursor, 10) : 1;
    const perPage = clamp(input.limit ?? 50, 1, 100);
    const status = input.status?.length ? input.status.join(",") : "publish,draft";
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
      status,
      _fields: "id,date_gmt,modified_gmt,slug,status,link,title"
    });
    if (input.search) params.set("search", input.search);
    const response = await this.requestWithHeaders<WordPressPage[]>(`${path}?${params.toString()}`);
    const totalPages = Number.parseInt(response.headers.get("x-wp-totalpages") ?? "1", 10);
    return { items: response.body.map(normalizePageSummary), next_cursor: page < totalPages ? String(page + 1) : null };
  }

  private authenticationErrorDetail(path: string, err: WordPressRestError): string {
    const code = err.wpCode ? ` [${err.wpCode.slice(0, 100)}]` : "";
    const detail = err.message === `WordPress REST error ${err.statusCode}`
      ? "The server returned no WordPress error details; a hosting login, proxy, or security plugin may be blocking the REST API."
      : err.message;
    let message = `WordPress GET ${path} failed: HTTP ${err.statusCode}${code}. ${detail} Check the WordPress username and application password, account permissions, and whether the host allows authenticated REST requests.`;
    // A remote JSON error can echo credentials. Never include known secrets in
    // the diagnostic saved to capabilities/audit or returned to the UI.
    for (const secret of [
      basicAuth(this.credentials.username, this.credentials.applicationPassword).slice(6),
      this.credentials.applicationPassword,
      this.credentials.applicationPassword.replace(/\s/g, "")
    ]) {
      if (secret) message = message.split(secret).join("[redacted]");
    }
    return message;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.requestWithHeaders<T>(path, init);
    return response.body;
  }

  // Shared, hardened request core. Every request:
  //  - re-validates the connector target (DNS-rebinding / private-target policy) on the
  //    initial URL and on every redirect hop;
  //  - follows redirects manually (max 5) so each hop is re-validated;
  //  - enforces a wall-clock timeout via AbortController;
  //  - caps the response body size;
  //  - normalizes WordPress error codes without ever echoing the Authorization header.
  private async requestWithHeaders<T>(path: string, init: RequestInit = {}, asText = false): Promise<{ body: T; headers: Headers }> {
    let target = `${this.baseUrl}${path}`;
    const timeoutMs = this.timeoutMs;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await validateConnectorTarget(target, { allowPrivateTargets: this.allowPrivateTargets });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await connectorFetch(target, {
          ...init,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            authorization: basicAuth(this.credentials.username, this.credentials.applicationPassword),
            ...(init.headers ?? {})
          }
        }, { allowPrivateTargets: this.allowPrivateTargets });

        // Manual redirect handling so each hop is SSRF-revalidated.
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new WordPressRestError(502, "Redirect without a location", "bad_redirect");
          if (hop === MAX_REDIRECTS) throw new WordPressRestError(502, "Too many redirects", "too_many_redirects");
          const redirected = new URL(location, target);
          const previous = new URL(target);
          if (redirected.hostname !== previous.hostname || (previous.protocol === "https:" && redirected.protocol !== "https:")) {
            throw new WordPressRestError(502, "Authenticated redirect changed to an unsafe target", "unsafe_redirect");
          }
          target = redirected.toString();
          continue;
        }

        const bodyText = await readCappedText(response, this.maxResponseBytes);
        if (!response.ok) throw normalizeWpError(response.status, bodyText);
        if (asText) return { body: bodyText as T, headers: response.headers };
        let body: T;
        try {
          body = (bodyText ? JSON.parse(bodyText) : {}) as T;
        } catch {
          throw new WordPressRestError(502, "WordPress REST endpoint returned invalid JSON. Check its permalink and REST API configuration.", "invalid_response");
        }
        return { body, headers: response.headers };
      } catch (err) {
        if (controller.signal.aborted) throw new WordPressRestError(504, "WordPress request timed out", "timeout");
        if (err instanceof WordPressRestError) throw err;
        throw new WordPressRestError(502, "WordPress connector request failed", "connector_unavailable");
      } finally {
        clearTimeout(timer);
      }
    }
    // Unreachable: the loop either returns or throws.
    throw new WordPressRestError(502, "Request did not complete", "connector_unavailable");
  }

  // Generic typed helpers over a WordPress REST collection (rest_base), shared by the
  // content/taxonomy/comment/user tools so pagination, _fields, and error mapping live in
  // exactly one place.
  async listCollection(
    restBase: string,
    query: Record<string, string | number | undefined>,
    fields?: string[]
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null; total: number | null }> {
    const page = query.page ? Number(query.page) : 1;
    const params = buildQuery({ per_page: clamp(Number(query.per_page ?? 50), 1, 100), ...query, page, ...(fields ? { _fields: fields.join(",") } : {}) });
    const response = await this.requestWithHeaders<Record<string, unknown>[]>(`/wp-json/wp/v2/${restBase}?${params}`);
    const totalPages = Number.parseInt(response.headers.get("x-wp-totalpages") ?? "1", 10);
    const total = response.headers.has("x-wp-total") ? Number.parseInt(response.headers.get("x-wp-total") ?? "0", 10) : null;
    return { items: Array.isArray(response.body) ? response.body : [], next_cursor: page < totalPages ? String(page + 1) : null, total };
  }

  async getResource(restBase: string, id: string, opts: { fields?: string[]; context?: "view" | "edit" } = {}): Promise<Record<string, unknown>> {
    const params = buildQuery({ ...(opts.context ? { context: opts.context } : {}), ...(opts.fields ? { _fields: opts.fields.join(",") } : {}) });
    const suffix = params ? `?${params}` : "";
    return this.request<Record<string, unknown>>(`/wp-json/wp/v2/${restBase}/${encodeURIComponent(id)}${suffix}`);
  }

  async createResource(restBase: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/wp-json/wp/v2/${restBase}`, jsonBody("POST", body));
  }

  async updateResource(restBase: string, id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/wp-json/wp/v2/${restBase}/${encodeURIComponent(id)}`, jsonBody("POST", body));
  }

  async deleteResource(restBase: string, id: string, opts: { force?: boolean; query?: Record<string, string | number | undefined> } = {}): Promise<Record<string, unknown>> {
    const params = buildQuery({ ...(opts.force ? { force: "true" } : {}), ...(opts.query ?? {}) });
    const suffix = params ? `?${params}` : "";
    return this.request<Record<string, unknown>>(`/wp-json/wp/v2/${restBase}/${encodeURIComponent(id)}${suffix}`, { method: "DELETE" });
  }

  // --- Revisions (nested collection) ---
  async listRevisions(restBase: string, parentId: string): Promise<Record<string, unknown>[]> {
    const body = await this.request<Record<string, unknown>[]>(
      `/wp-json/wp/v2/${restBase}/${encodeURIComponent(parentId)}/revisions?_fields=id,date_gmt,modified_gmt,author,title`
    );
    return Array.isArray(body) ? body : [];
  }

  async getRevision(restBase: string, parentId: string, revisionId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      `/wp-json/wp/v2/${restBase}/${encodeURIComponent(parentId)}/revisions/${encodeURIComponent(revisionId)}`
    );
  }

  // WordPress has no REST "restore revision" endpoint; restoring means writing the
  // revision's title/content/excerpt back onto the parent post.
  async restoreRevision(restBase: string, parentId: string, revisionId: string): Promise<Record<string, unknown>> {
    const revision = await this.getRevision(restBase, parentId, revisionId);
    const body: Record<string, unknown> = {};
    for (const field of ["title", "content", "excerpt"] as const) {
      const value = revision[field] as { raw?: string; rendered?: string } | undefined;
      if (value && (value.raw ?? value.rendered) != null) body[field] = value.raw ?? value.rendered;
    }
    return this.updateResource(restBase, parentId, body);
  }

  // --- Typed settings (core /wp/v2/settings; WordPress returns only registered keys) ---
  async getSettings(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/wp-json/wp/v2/settings");
  }

  async updateSettings(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/wp-json/wp/v2/settings", jsonBody("POST", body));
  }

  // --- Application passwords (secret returned once by WordPress) ---
  async createApplicationPassword(userId: string, name: string): Promise<{ uuid: string; password: string }> {
    const body = await this.request<{ uuid: string; password: string }>(
      `/wp-json/wp/v2/users/${encodeURIComponent(userId)}/application-passwords`,
      jsonBody("POST", { name })
    );
    return { uuid: body.uuid, password: body.password };
  }

  async revokeApplicationPassword(userId: string, uuid: string): Promise<void> {
    await this.request(`/wp-json/wp/v2/users/${encodeURIComponent(userId)}/application-passwords/${encodeURIComponent(uuid)}`, { method: "DELETE" });
  }

  // --- Media upload / ingest ---
  async uploadMedia(input: { filename: string; contentType: string; bytes: Buffer; title?: string; altText?: string }): Promise<Record<string, unknown>> {
    const created = await this.request<Record<string, unknown>>("/wp-json/wp/v2/media", {
      method: "POST",
      headers: {
        "content-type": input.contentType,
        "content-disposition": `attachment; filename="${input.filename.replace(/["\r\n]/g, "")}"`
      },
      body: new Uint8Array(input.bytes)
    });
    // The binary upload cannot carry title/alt; apply them in a follow-up if requested.
    if ((input.title || input.altText) && created.id != null) {
      return this.updateResource("media", String(created.id), {
        ...(input.title ? { title: input.title } : {}),
        ...(input.altText ? { alt_text: input.altText } : {})
      });
    }
    return created;
  }

  // Fetch bytes from an allowed URL (SSRF-validated per hop) and upload them. Enforces the
  // MIME allowlist and size limit at the connector layer as typed-tool validation.
  async ingestMediaFromUrl(input: { url: string; allowedMimeTypes: string[]; maxBytes: number; filename?: string; title?: string }): Promise<Record<string, unknown>> {
    let target = input.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await validateConnectorTarget(target, { allowPrivateTargets: this.allowPrivateTargets });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await connectorFetch(target, { redirect: "manual", signal: controller.signal }, { allowPrivateTargets: this.allowPrivateTargets });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || hop === MAX_REDIRECTS) throw new WordPressRestError(502, "Too many redirects fetching media", "too_many_redirects");
          target = new URL(location, target).toString();
          continue;
        }
        if (!response.ok) throw new WordPressRestError(response.status, "Media source returned an error", "media_source_error");
        const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
        if (!input.allowedMimeTypes.includes(contentType)) {
          throw new WordPressRestError(415, `Media type ${contentType} is not allowed`, "media_type_not_allowed");
        }
        const text = await readCappedBytes(response, input.maxBytes);
        const filename = input.filename ?? new URL(target).pathname.split("/").pop() ?? "upload.bin";
        return this.uploadMedia({ filename, contentType, bytes: text, ...(input.title ? { title: input.title } : {}) });
      } catch (err) {
        if (controller.signal.aborted) throw new WordPressRestError(504, "Media fetch timed out", "timeout");
        if (err instanceof WordPressRestError) throw err;
        throw new WordPressRestError(502, "Media source fetch failed", "connector_unavailable");
      } finally {
        clearTimeout(timer);
      }
    }
    throw new WordPressRestError(502, "Media fetch did not complete", "connector_unavailable");
  }

  // --- Navigation & design (version/theme sensitive; callers gate on capability) ---
  async listMenus(): Promise<Record<string, unknown>[]> {
    const body = await this.request<Record<string, unknown>[]>("/wp-json/wp/v2/menus?_fields=id,name,slug,locations");
    return Array.isArray(body) ? body : [];
  }

  async listTemplates(restBase: "templates" | "template-parts"): Promise<Record<string, unknown>[]> {
    const body = await this.request<Record<string, unknown>[]>(`/wp-json/wp/v2/${restBase}?_fields=id,slug,title,type,theme,source`);
    return Array.isArray(body) ? body : [];
  }

  async getGlobalStyles(id: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/wp-json/wp/v2/global-styles/${encodeURIComponent(id)}`);
  }

  async updateGlobalStyles(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/wp-json/wp/v2/global-styles/${encodeURIComponent(id)}`, jsonBody("POST", body));
  }

  // Active theme over core REST (replaces the SSH-only discovery path). The active-theme
  // resource carries a `wp:user-global-styles` link whose numeric id WordPress lazily
  // provisions for a block theme, so callers can read/update global styles without SSH.
  async getActiveTheme(): Promise<ActiveTheme> {
    const body = await this.request<Record<string, unknown>[]>("/wp-json/wp/v2/themes?status=active");
    const theme = Array.isArray(body) ? body[0] : undefined;
    if (!theme) throw new WordPressRestError(404, "No active theme reported", "no_active_theme");
    const links = (theme._links ?? {}) as Record<string, { href?: string }[]>;
    const gsHref = links["wp:user-global-styles"]?.[0]?.href;
    return {
      stylesheet: typeof theme.stylesheet === "string" ? theme.stylesheet : null,
      template: typeof theme.template === "string" ? theme.template : null,
      name: renderedField(theme.name),
      is_block_theme: theme.is_block_theme === true,
      user_global_styles_id: gsHref ? extractGlobalStylesId(gsHref) : null
    };
  }

  // Resolved global styles for a theme by stylesheet. Unlike getGlobalStyles(id), this needs
  // no numeric customization id and works before any customization has been saved.
  async getThemeGlobalStyles(stylesheet: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/wp-json/wp/v2/global-styles/themes/${encodeStylesheet(stylesheet)}`);
  }

  // Built-in style variations (theme.json alternatives) a block theme ships.
  async listThemeStyleVariations(stylesheet: string): Promise<Record<string, unknown>[]> {
    const body = await this.request<Record<string, unknown>[]>(`/wp-json/wp/v2/global-styles/themes/${encodeStylesheet(stylesheet)}/variations`);
    return Array.isArray(body) ? body : [];
  }

  // --- Page-builder support (AB-ELEMENTOR) -----------------------------------------

  // Meta keys a collection exposes over REST, read from its OPTIONS schema. Detects
  // builder data registered for REST (e.g. Elementor ≥3.27's _elementor_data) without
  // needing a post id.
  async getRegisteredMetaKeys(restBase: string): Promise<string[]> {
    const schema = await this.request<{ schema?: { properties?: { meta?: { properties?: Record<string, unknown> } } } }>(
      `/wp-json/wp/v2/${encodeURIComponent(restBase)}`, { method: "OPTIONS" });
    return Object.keys(schema.schema?.properties?.meta?.properties ?? {});
  }

  // WordPress Abilities API (core since 6.9). null when the ability is not registered.
  async getAbility(name: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.request<Record<string, unknown>>(`/wp-json/wp-abilities/v1/abilities/${abilityPath(name)}`);
    } catch (err) {
      if (err instanceof WordPressRestError && err.statusCode === 404) return null;
      throw err;
    }
  }

  async runAbility<T = Record<string, unknown>>(name: string, input: Record<string, unknown>): Promise<T> {
    return this.request<T>(`/wp-json/wp-abilities/v1/abilities/${abilityPath(name)}/run`, jsonBody("POST", { input }));
  }

  // Site-wide Elementor CSS + element-cache flush; WordPress allows it only for
  // manage_options, so callers treat a 403 as "not available to this credential".
  async clearElementorCache(): Promise<void> {
    await this.request("/wp-json/elementor/v1/cache", { method: "DELETE" });
  }

  // Public HTML of a front-end path (bounded), e.g. to read <meta name="generator">.
  async getPublicHtml(path = "/"): Promise<string> {
    return (await this.requestWithHeaders<string>(path, {}, true)).body;
  }

  // Slug → { rest_base } map from /wp/v2/types. Only REST-visible (show_in_rest) types are
  // listed by WordPress, so presence here means the type is REST-addressable.
  async getTypeRestBases(): Promise<Record<string, { rest_base: string | null; name: string | null }>> {
    if (this.typeMap) return this.typeMap;
    const types = await this.request<Record<string, { rest_base?: string; name?: string }>>("/wp-json/wp/v2/types");
    const map: Record<string, { rest_base: string | null; name: string | null }> = {};
    for (const [slug, def] of Object.entries(types ?? {})) {
      map[slug] = { rest_base: typeof def.rest_base === "string" ? def.rest_base : null, name: typeof def.name === "string" ? def.name : null };
    }
    this.typeMap = map;
    return map;
  }

  // Best-effort design capability probe (availability only, never authorization). Reads the
  // active theme, then the resolved-styles / variations / templates routes.
  private async probeDesign(): Promise<DesignDiscovery> {
    let theme: ActiveTheme | null = null;
    try { theme = await this.getActiveTheme(); } catch { theme = null; }
    if (!theme || !theme.stylesheet) {
      return { activeThemeRead: theme != null, isBlockTheme: theme?.is_block_theme ?? false, stylesheet: theme?.stylesheet ?? null, themeGlobalStylesRead: false, styleVariationsRead: false, globalStylesCustomizationExists: false, globalStylesChange: false, templateChange: false };
    }
    const ss = encodeStylesheet(theme.stylesheet);
    const [gsRead, varRead, templatesRead] = await Promise.all([
      this.safeOk(`/wp-json/wp/v2/global-styles/themes/${ss}`),
      this.safeOk(`/wp-json/wp/v2/global-styles/themes/${ss}/variations`),
      this.safeOk("/wp-json/wp/v2/templates")
    ]);
    const hasCustomization = theme.user_global_styles_id != null;
    return {
      activeThemeRead: true,
      isBlockTheme: theme.is_block_theme,
      stylesheet: theme.stylesheet,
      themeGlobalStylesRead: gsRead,
      styleVariationsRead: varRead,
      globalStylesCustomizationExists: hasCustomization,
      globalStylesChange: theme.is_block_theme && hasCustomization,
      templateChange: templatesRead && theme.is_block_theme
    };
  }

  private async safeOk(path: string): Promise<boolean> {
    try { await this.request(path); return true; } catch { return false; }
  }
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export class WordPressRestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    // The WordPress `code` (e.g. rest_post_invalid_id) or a broker connector code
    // (timeout / response_too_large / too_many_redirects). Never contains credentials.
    readonly wpCode?: string
  ) {
    super(message);
    this.name = "WordPressRestError";
  }
}

export interface WordPressSiteSummary {
  name: string;
  url: string;
  description: string | null;
  capabilities: string[];
}

export interface ListPagesInput {
  status?: string[];
  search?: string | null;
  limit?: number;
  cursor?: string | null;
}

export interface PaginatedPages {
  pages: BrokerPageSummary[];
  next_cursor: string | null;
}

export interface BrokerPageSummary {
  id: string;
  title: string;
  slug: string;
  status: string;
  modified_at: string | null;
  link: string | null;
}

export interface BrokerPage extends BrokerPageSummary {
  revision_id: string | null;
  content_format: "wordpress_block_html";
  content?: string;
}

export interface CreateDraftPageInput {
  title: string;
  slug?: string | null;
  content: string;
}

export interface UpdateDraftPageInput {
  pageId: string;
  title?: string | null;
  content?: string | null;
  expectedRevisionId: string;
}

export interface BrokerDraftPage {
  id: string;
  title: string;
  slug: string;
  status: "draft";
  edit_link: string;
  created_at: string;
}

interface WordPressRoot {
  name?: string;
  url?: string;
  description?: string;
}

interface WordPressRestRoot {
  name?: string;
  url?: string;
  description?: string;
  namespaces?: string[];
}

export interface ActiveTheme {
  stylesheet: string | null;
  template: string | null;
  name: string | null;
  is_block_theme: boolean;
  user_global_styles_id: string | null;
}

// Design (block-theme) capability probe. Availability only — never implies authorization.
export interface DesignDiscovery {
  activeThemeRead: boolean;
  isBlockTheme: boolean;
  stylesheet: string | null;
  themeGlobalStylesRead: boolean;
  styleVariationsRead: boolean;
  globalStylesCustomizationExists: boolean;
  globalStylesChange: boolean;
  templateChange: boolean;
}

export interface RestDiscovery {
  reachable: boolean;
  authenticated: boolean;
  wordpressVersion: string | null;
  isMultisite: boolean | null;
  namespaces: string[];
  contentTypes: string[];
  taxonomies: string[];
  mediaSupported: boolean;
  // Present only on the authenticated path; null when discovery short-circuited.
  design: DesignDiscovery | null;
  errorCode?: string;
  errorMessage?: string;
}

interface RenderedValue {
  rendered?: string;
}

interface WordPressPage {
  id: number;
  date_gmt?: string;
  modified_gmt?: string;
  slug?: string;
  status?: string;
  link?: string;
  title?: RenderedValue;
  content?: RenderedValue;
}

function normalizePageSummary(page: WordPressPage): BrokerPageSummary {
  return {
    id: String(page.id),
    title: rendered(page.title) || "(untitled)",
    slug: page.slug ?? "",
    status: page.status ?? "unknown",
    modified_at: page.modified_gmt ? `${page.modified_gmt}Z` : null,
    link: page.link ?? null
  };
}

function rendered(value: RenderedValue | undefined): string {
  return value?.rendered ?? "";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function jsonBody(method: string, body: Record<string, unknown>): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Ability names are namespaced ("elementor/update-page-settings"); keep the "/" and
// encode each segment.
function abilityPath(name: string): string {
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(name)) throw new WordPressRestError(400, "Invalid ability name", "invalid_ability");
  return name.split("/").map(encodeURIComponent).join("/");
}

// Encode a stylesheet for a REST path, preserving the single "/" a child theme may use
// (encodeURIComponent would turn it into %2F and break core's route matching).
function encodeStylesheet(stylesheet: string): string {
  return stylesheet.split("/").map(encodeURIComponent).join("/");
}

// Pull the numeric wp_global_styles id out of a user-global-styles link href, which may be
// pretty (.../global-styles/4) or plain-permalink (index.php?rest_route=/wp/v2/global-styles/4).
function extractGlobalStylesId(href: string): string | null {
  const match = /global-styles\/(\d+)/.exec(href);
  return match?.[1] ?? null;
}

// Themes REST fields like `name` are { raw, rendered } objects; content tools elsewhere use
// a plain string. Accept either.
function renderedField(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as RenderedValue).rendered === "string") return (value as RenderedValue).rendered!;
  return null;
}

// Build a URLSearchParams string, skipping undefined values.
function buildQuery(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

// Read a response body as text with a hard byte cap. Rejects an oversized Content-Length
// up front, and also guards against a lying/absent header by capping the streamed read.
// Shared with the session client (session.ts).
export async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WordPressRestError(502, "WordPress response exceeded the size limit", "response_too_large");
  }
  if (!response.body) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WordPressRestError(502, "WordPress response exceeded the size limit", "response_too_large");
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

// Same size-capped streaming read, returning raw bytes (used for media ingest).
async function readCappedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WordPressRestError(413, "Media source exceeded the size limit", "media_too_large");
  }
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new WordPressRestError(413, "Media source exceeded the size limit", "media_too_large");
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WordPressRestError(413, "Media source exceeded the size limit", "media_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

// Turn a non-2xx WordPress REST response into a WordPressRestError carrying the WordPress
// error code (e.g. rest_post_invalid_id) without ever surfacing request credentials. The
// caller decides how to classify auth-rejection vs a missing endpoint/capability.
function normalizeWpError(status: number, bodyText: string): WordPressRestError {
  let wpCode: string | undefined;
  let message = `WordPress REST error ${status}`;
  try {
    const parsed = JSON.parse(bodyText) as { code?: string; message?: string };
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.code === "string") wpCode = parsed.code;
      if (typeof parsed.message === "string") message = parsed.message.slice(0, 500);
    }
  } catch {
    // Non-JSON error body — keep the generic message, never echo raw HTML back.
  }
  return new WordPressRestError(status, message, wpCode);
}
