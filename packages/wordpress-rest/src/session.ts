import { connectorFetch, validateConnectorTarget } from "@aibroker/core";
import { readCappedText, WordPressRestError } from "./client.js";

// Cookie-authenticated WordPress access for a user's own login session (AB-ELEMENTOR
// layers 1–2). The application-password REST client covers everything REST exposes;
// this client exists for the admin-ajax paths that only accept a logged-in session,
// such as Elementor's editor save. The user's password is used once, by loginWordPress,
// and is never part of the stored state.

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const AUTH_COOKIE = /^wordpress_(logged_in|sec)_|^wordpress_(?!test_cookie)[0-9a-f]+$/;

export interface StoredCookie {
  name: string;
  value: string;
  path: string;
  // Epoch seconds; null for a browser-session cookie.
  expiresAt: number | null;
  secure: boolean;
}

export interface WordPressSessionState {
  version: 1;
  baseUrl: string;
  cookies: StoredCookie[];
}

export type LoginChallengeKind = "two_factor" | "captcha" | "bot_check" | "sso" | "unknown";

export class WordPressSessionError extends Error {
  constructor(
    readonly code:
      | "wordpress_login_failed"
      | "wordpress_login_challenge"
      | "wordpress_login_url_not_found"
      | "wordpress_session_expired"
      | "wordpress_session_invalid_response"
      | "wordpress_2fa_invalid",
    readonly statusCode: number,
    message: string,
    readonly challenge?: LoginChallengeKind,
    // Present when the broker can relay a two-factor code to finish this login
    // (completeTwoFactorLogin). Contains secrets; callers must store it encrypted.
    readonly pending?: PendingTwoFactor
  ) {
    super(message);
    this.name = "WordPressSessionError";
  }
}

export interface WordPressSessionUser {
  id: number;
  name: string;
  slug: string;
  roles: string[];
  capabilities: Record<string, boolean>;
}

interface SessionOptions {
  allowPrivateTargets?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface RawResponse {
  status: number;
  url: string;
  headers: Headers;
  text: string;
}

// Minimal RFC 6265 subset: WordPress sets host-only cookies scoped by path, so a jar
// keyed by name+path with path-prefix matching and the Secure flag is sufficient.
class CookieJar {
  private cookies = new Map<string, StoredCookie>();

  constructor(initial: StoredCookie[] = []) {
    for (const cookie of initial) this.cookies.set(`${cookie.name};${cookie.path}`, cookie);
  }

  absorb(headers: Headers, requestUrl: URL): void {
    const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const cookie: StoredCookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), path: "/", expiresAt: null, secure: false };
      let maxAge: number | null = null;
      for (const attribute of attributes) {
        const [rawKey = "", ...rest] = attribute.split("=");
        const key = rawKey.toLowerCase(), value = rest.join("=");
        if (key === "path" && value.startsWith("/")) cookie.path = value;
        else if (key === "expires") { const at = Date.parse(value); if (Number.isFinite(at)) cookie.expiresAt = Math.floor(at / 1000); }
        else if (key === "max-age") maxAge = Number.parseInt(value, 10);
        else if (key === "secure") cookie.secure = true;
      }
      if (maxAge !== null && Number.isFinite(maxAge)) cookie.expiresAt = Math.floor(Date.now() / 1000) + maxAge;
      if (!cookie.path.startsWith("/")) cookie.path = requestUrl.pathname.replace(/\/[^/]*$/, "") || "/";
      const key = `${cookie.name};${cookie.path}`;
      // WordPress clears cookies by re-sending them with a past expiry.
      if (cookie.expiresAt !== null && cookie.expiresAt * 1000 <= Date.now()) this.cookies.delete(key);
      else this.cookies.set(key, cookie);
    }
  }

  header(url: URL): string | undefined {
    const now = Date.now() / 1000;
    const matching = [...this.cookies.values()].filter((cookie) =>
      (cookie.expiresAt === null || cookie.expiresAt > now) &&
      (!cookie.secure || url.protocol === "https:") &&
      (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`)));
    return matching.length ? matching.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") : undefined;
  }

  list(): StoredCookie[] {
    return [...this.cookies.values()];
  }

  hasAuth(): boolean {
    return this.list().some((cookie) => cookie.name.startsWith("wordpress_logged_in_"));
  }

  // Earliest expiry across the auth cookies; the session is unusable once any lapses.
  authExpiresAt(): Date | null {
    const expiries = this.list().filter((cookie) => AUTH_COOKIE.test(cookie.name) && cookie.expiresAt !== null).map((cookie) => cookie.expiresAt!);
    return expiries.length ? new Date(Math.min(...expiries) * 1000) : null;
  }
}

// Shared hardened request core, mirroring WordPressRestClient.requestWithHeaders: the
// target is SSRF-revalidated on every hop, redirects are followed manually and may not
// leave the host or downgrade from https, and bodies are time- and size-capped.
async function sessionRequest(jar: CookieJar, rawUrl: string, init: RequestInit, options: SessionOptions): Promise<RawResponse> {
  let target = rawUrl;
  let method = init.method ?? "GET";
  let body = init.body;
  const allowPrivateTargets = options.allowPrivateTargets ?? false;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await validateConnectorTarget(target, { allowPrivateTargets });
    const url = new URL(target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const cookie = jar.header(url);
      const { body: _initialBody, ...rest } = init;
      const response = await connectorFetch(target, {
        ...rest, method, ...(body != null ? { body } : {}), redirect: "manual", signal: controller.signal,
        headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) }
      }, { allowPrivateTargets });
      jar.absorb(response.headers, url);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new WordPressRestError(502, "Redirect without a location", "bad_redirect");
        if (hop === MAX_REDIRECTS) throw new WordPressRestError(502, "Too many redirects", "too_many_redirects");
        const next = new URL(location, target);
        if (next.hostname !== url.hostname || (url.protocol === "https:" && next.protocol !== "https:")) {
          return { status: response.status, url: next.toString(), headers: response.headers, text: "" };
        }
        target = next.toString();
        if (response.status !== 307 && response.status !== 308) { method = "GET"; body = undefined; }
        continue;
      }
      const text = await readCappedText(response, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
      return { status: response.status, url: target, headers: response.headers, text };
    } catch (err) {
      if (controller.signal.aborted) throw new WordPressRestError(504, "WordPress request timed out", "timeout");
      if (err instanceof WordPressRestError || err instanceof WordPressSessionError) throw err;
      throw new WordPressRestError(502, "WordPress connector request failed", "connector_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
  throw new WordPressRestError(502, "Request did not complete", "connector_unavailable");
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

// Two-factor markers are only meaningful after the password was accepted: plugins such
// as Wordfence load their 2FA scripts on every login page, 2FA-enrolled user or not.
function detectChallenge(response: RawResponse, afterPassword: boolean): LoginChallengeKind | null {
  const html = response.text;
  if (/g-recaptcha|h-captcha|cf-turnstile|grecaptcha|hcaptcha/i.test(html)) return "captcha";
  if ([403, 429, 503].includes(response.status) && /cf-chl|challenge-platform|cf-browser-verification|captcha/i.test(html)) return "bot_check";
  if (afterPassword && !/id=["']?login_error/.test(html) &&
      /name=["']?authcode|two-factor|two_factor|wfls-|wp-2fa|wp2fa|name=["']?provider["']?|backup_code/i.test(html)) return "two_factor";
  return null;
}

// ---- two-factor relay (AB-ELEMENTOR D6) -------------------------------------------------

// A login paused at its second factor. "form": Two Factor / WP 2FA render a plain form
// (hidden wp-auth-id/nonce + a code field) that is re-posted with the code. "wordfence":
// Wordfence Login Security expects the username and password again with the code in
// wfls-token, so the password must be held (encrypted, briefly) until the code arrives.
export type PendingTwoFactor =
  | { version: 1; strategy: "form"; baseUrl: string; loginUrl: string; cookies: StoredCookie[]; action: string; fields: Record<string, string>; codeField: string }
  | { version: 1; strategy: "wordfence"; baseUrl: string; loginUrl: string; cookies: StoredCookie[]; username: string; password: string };

const CODE_FIELD = /^(authcode|two-factor-totp-authcode|wp-2fa-totp-authcode|code|otp|totp)$/i;

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

// Find a second-factor form: one with a one-time-code input. Hidden and text fields are
// carried over as-is; submit buttons are not.
function parseCodeForm(html: string, pageUrl: string): { action: string; fields: Record<string, string>; codeField: string } | null {
  for (const form of html.match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) ?? []) {
    const open = /<form\b[^>]*>/i.exec(form)![0];
    if ((attribute(open, "method") ?? "get").toLowerCase() !== "post") continue;
    const fields: Record<string, string> = {};
    let codeField: string | null = null;
    for (const input of form.match(/<input\b[^>]*>/gi) ?? []) {
      const name = attribute(input, "name");
      if (!name) continue;
      const type = (attribute(input, "type") ?? "text").toLowerCase();
      if (["submit", "button", "image", "reset", "file"].includes(type)) continue;
      if ((type === "checkbox" || type === "radio") && !/\schecked\b/i.test(input)) continue;
      if (!codeField && (CODE_FIELD.test(name) || /one-time-code/i.test(attribute(input, "autocomplete") ?? ""))) { codeField = name; continue; }
      fields[name] = attribute(input, "value") ?? "";
    }
    if (codeField) return { action: new URL(attribute(open, "action") || pageUrl, pageUrl).toString(), fields, codeField };
  }
  return null;
}

function loginError(html: string): string | null {
  const match = /id=["']?login_error["']?[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  return match ? decodeEntities(match[1]!.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 300) : null;
}

function isWordfenceCodeRequired(html: string): boolean {
  return /CODE REQUIRED/i.test(loginError(html) ?? "") && /wfls|wordfence/i.test(html);
}

// Cookies alone prove nothing: 2FA plugins issue auth cookies and then destroy the
// session server-side. Only an authenticated admin-ajax answer counts as logged in.
async function verifyLoggedIn(jar: CookieJar, baseUrl: string, options: SessionOptions): Promise<boolean> {
  if (!jar.hasAuth()) return false;
  const response = await sessionRequest(jar, joinUrl(baseUrl, "/wp-admin/admin-ajax.php?action=rest-nonce"), {}, options);
  return response.status === 200 && /^[0-9a-f]{6,}$/i.test(response.text.trim());
}

function sessionResult(jar: CookieJar, baseUrl: string): { state: WordPressSessionState; expiresAt: Date | null } {
  return { state: { version: 1, baseUrl, cookies: jar.list().filter((cookie) => cookie.name !== "wordpress_test_cookie") }, expiresAt: jar.authExpiresAt() };
}

const TWO_FACTOR_PROMPT = "This account uses two-factor authentication. Enter the current code from your authenticator app to finish connecting.";

// Inspect the response to a password (or code) submission: logged in, paused at a
// second factor we can relay, or failed.
async function settleLogin(
  jar: CookieJar, result: RawResponse, context: { baseUrl: string; loginUrl: string; username: string; password: string },
  options: SessionOptions, afterCode: boolean
): Promise<{ state: WordPressSessionState; expiresAt: Date | null }> {
  const cookies = () => jar.list().filter((cookie) => !AUTH_COOKIE.test(cookie.name));
  const form = parseCodeForm(result.text, result.url);
  if (form) {
    const pending: PendingTwoFactor = { version: 1, strategy: "form", baseUrl: context.baseUrl, loginUrl: context.loginUrl, cookies: cookies(), ...form };
    const error = loginError(result.text);
    if (afterCode) throw new WordPressSessionError("wordpress_2fa_invalid", 401, error ?? "WordPress rejected the verification code.", "two_factor", pending);
    throw new WordPressSessionError("wordpress_login_challenge", 409, TWO_FACTOR_PROMPT, "two_factor", pending);
  }
  if (isWordfenceCodeRequired(result.text) || (afterCode && /CODE INVALID/i.test(loginError(result.text) ?? ""))) {
    const pending: PendingTwoFactor = { version: 1, strategy: "wordfence", baseUrl: context.baseUrl, loginUrl: context.loginUrl, cookies: cookies(), username: context.username, password: context.password };
    if (afterCode) throw new WordPressSessionError("wordpress_2fa_invalid", 401, loginError(result.text) ?? "WordPress rejected the verification code.", "two_factor", pending);
    throw new WordPressSessionError("wordpress_login_challenge", 409, TWO_FACTOR_PROMPT, "two_factor", pending);
  }
  if (await verifyLoggedIn(jar, context.baseUrl, options)) return sessionResult(jar, context.baseUrl);
  const challenge = detectChallenge(result, true);
  if (challenge) throw new WordPressSessionError("wordpress_login_challenge", 409, challengeMessage(challenge), challenge);
  if (afterCode) throw new WordPressSessionError("wordpress_2fa_invalid", 401, loginError(result.text) ?? "WordPress did not accept the verification code.");
  throw new WordPressSessionError("wordpress_login_failed", 401, "WordPress rejected the username or password.");
}

export interface LoginOptions extends SessionOptions {
  baseUrl: string;
  loginPath?: string;
  username: string;
  password: string;
}

// Background login (capture flow A). Returns the cookie state; the password is not
// retained. A relayable second factor surfaces as wordpress_login_challenge with
// `pending` set; other challenges (CAPTCHA, bot checks, SSO, unknown 2FA) have no
// `pending` and need the live browser.
export async function loginWordPress(options: LoginOptions): Promise<{ state: WordPressSessionState; expiresAt: Date | null }> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const loginUrl = joinUrl(baseUrl, options.loginPath?.trim() || "/wp-login.php");
  const jar = new CookieJar();
  const page = await sessionRequest(jar, loginUrl, {}, options);
  if (new URL(page.url).hostname !== new URL(loginUrl).hostname) {
    throw new WordPressSessionError("wordpress_login_challenge", 409, "The login page redirects to another site (single sign-on).", "sso");
  }
  if (page.status === 404) {
    throw new WordPressSessionError("wordpress_login_url_not_found", 404, "No WordPress login page at this URL. Set the login path on the WordPress plugin if the site renamed it.");
  }
  const pageChallenge = detectChallenge(page, false);
  if (pageChallenge) throw new WordPressSessionError("wordpress_login_challenge", 409, challengeMessage(pageChallenge), pageChallenge);
  if (!/name=["']?log["']?/.test(page.text)) {
    throw new WordPressSessionError("wordpress_login_challenge", 409, "The login page is not a standard WordPress login form.", "unknown");
  }

  // Core refuses logins without its test cookie ("cookies are blocked").
  jar.absorb(new Headers([["set-cookie", "wordpress_test_cookie=WP%20Cookie%20check; path=/"]]), new URL(loginUrl));
  const result = await sessionRequest(jar, loginUrl, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: loginForm(baseUrl, options.username, options.password).toString()
  }, options);
  return settleLogin(jar, result, { baseUrl, loginUrl, username: options.username, password: options.password }, options, false);
}

function loginForm(baseUrl: string, username: string, password: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({ log: username, pwd: password, rememberme: "forever", "wp-submit": "Log In", redirect_to: `${baseUrl}/wp-admin/`, testcookie: "1", ...extra });
}

// Finish a login paused at its second factor. A wrong code throws wordpress_2fa_invalid
// carrying a refreshed `pending` (plugins rotate their nonces on every attempt).
export async function completeTwoFactorLogin(pending: PendingTwoFactor, code: string, options: SessionOptions = {}): Promise<{ state: WordPressSessionState; expiresAt: Date | null }> {
  const cleaned = code.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9-]{4,64}$/.test(cleaned)) throw new WordPressSessionError("wordpress_2fa_invalid", 400, "Enter the code exactly as your authenticator app shows it.", "two_factor", pending);
  const jar = new CookieJar(pending.cookies);
  jar.absorb(new Headers([["set-cookie", "wordpress_test_cookie=WP%20Cookie%20check; path=/"]]), new URL(pending.loginUrl));
  const target = pending.strategy === "form" ? pending.action : pending.loginUrl;
  // The form's action must stay on the site that issued it.
  if (new URL(target).origin !== new URL(pending.baseUrl).origin) throw new WordPressSessionError("wordpress_login_challenge", 409, "The verification form points to another site.", "unknown");
  const body = pending.strategy === "form"
    ? new URLSearchParams({ ...pending.fields, [pending.codeField]: cleaned })
    : loginForm(pending.baseUrl, pending.username, pending.password, { "wfls-token": cleaned });
  const result = await sessionRequest(jar, target, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }, options);
  const username = pending.strategy === "wordfence" ? pending.username : "";
  const password = pending.strategy === "wordfence" ? pending.password : "";
  return settleLogin(jar, result, { baseUrl: pending.baseUrl, loginUrl: pending.loginUrl, username, password }, options, true);
}

function challengeMessage(kind: LoginChallengeKind): string {
  switch (kind) {
    case "two_factor": return "This account uses a two-factor method AIBroker cannot relay. Use \"Log in with browser\" instead.";
    case "captcha": return "The login page requires a CAPTCHA. Use \"Log in with browser\" to complete it yourself.";
    case "bot_check": return "The site's bot protection blocked the background login. Use \"Log in with browser\" instead.";
    case "sso": return "The site uses single sign-on. Use \"Log in with browser\" to sign in through it.";
    default: return "The site requires an extra login step. Use \"Log in with browser\" to complete it yourself.";
  }
}

// Turn a browser storage state captured by the live remote browser (capture flow B)
// into session state for this site, and confirm WordPress accepts it.
export async function sessionFromBrowserState(
  baseUrl: string,
  storageState: { cookies?: Array<{ name?: unknown; value?: unknown; domain?: unknown; path?: unknown; expires?: unknown; secure?: unknown }> },
  options: SessionOptions = {}
): Promise<{ state: WordPressSessionState; expiresAt: Date | null }> {
  const base = baseUrl.replace(/\/$/, "");
  const host = new URL(base).hostname;
  const cookies: StoredCookie[] = (storageState.cookies ?? [])
    .filter((cookie) => typeof cookie.name === "string" && typeof cookie.value === "string" && typeof cookie.domain === "string" &&
      (cookie.domain.replace(/^\./, "") === host || host.endsWith(`.${cookie.domain.replace(/^\./, "")}`)))
    .map((cookie) => ({
      name: String(cookie.name), value: String(cookie.value), path: typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/",
      expiresAt: typeof cookie.expires === "number" && cookie.expires > 0 ? Math.floor(cookie.expires) : null, secure: cookie.secure === true
    }));
  const jar = new CookieJar(cookies);
  if (!(await verifyLoggedIn(jar, base, options))) {
    throw new WordPressSessionError("wordpress_login_failed", 401, "The browser session is not logged in to WordPress yet.");
  }
  return sessionResult(jar, base);
}

export interface WordPressSessionClientOptions extends SessionOptions {
  state: WordPressSessionState;
}

export interface ElementorAjaxResponse {
  success: boolean;
  code: number;
  data: unknown;
}

export class WordPressSessionClient {
  private readonly jar: CookieJar;
  private readonly baseUrl: string;
  private readonly options: SessionOptions;
  private restNonceValue?: string;
  private elementorNonceValue?: string;

  constructor(options: WordPressSessionClientOptions) {
    this.baseUrl = options.state.baseUrl.replace(/\/$/, "");
    this.jar = new CookieJar(options.state.cookies);
    this.options = options;
  }

  state(): WordPressSessionState {
    return { version: 1, baseUrl: this.baseUrl, cookies: this.jar.list() };
  }

  expiresAt(): Date | null {
    return this.jar.authExpiresAt();
  }

  private async raw(path: string, init: RequestInit = {}): Promise<RawResponse> {
    if (!this.jar.hasAuth() || (this.expiresAt()?.getTime() ?? Infinity) <= Date.now()) throw expired();
    const response = await sessionRequest(this.jar, joinUrl(this.baseUrl, path), init, this.options);
    // Any bounce to the login page means WordPress no longer accepts the cookies.
    if (/\/wp-login\.php/.test(new URL(response.url).pathname) && !path.includes("wp-login.php")) throw expired();
    return response;
  }

  async adminPage(path = "/wp-admin/"): Promise<string> {
    const response = await this.raw(path);
    if (response.status !== 200) throw new WordPressSessionError("wordpress_session_invalid_response", 502, `WordPress admin returned ${response.status}.`);
    return response.text;
  }

  async restNonce(): Promise<string> {
    if (this.restNonceValue) return this.restNonceValue;
    const response = await this.raw("/wp-admin/admin-ajax.php?action=rest-nonce");
    const nonce = response.text.trim();
    if (response.status !== 200 || !/^[0-9a-f]{6,}$/i.test(nonce)) throw expired();
    this.restNonceValue = nonce;
    return nonce;
  }

  async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const nonce = await this.restNonce();
    const response = await this.raw(path, { ...init, headers: { ...(init.headers ?? {}), "x-wp-nonce": nonce } });
    let body: unknown;
    try { body = response.text ? JSON.parse(response.text) : {}; } catch {
      throw new WordPressSessionError("wordpress_session_invalid_response", 502, "WordPress REST returned invalid JSON.");
    }
    if (response.status === 401 || response.status === 403) {
      const code = (body as { code?: string }).code;
      if (code === "rest_not_logged_in" || code === "rest_cookie_invalid_nonce") throw expired();
    }
    if (response.status < 200 || response.status >= 300) {
      const parsed = body as { code?: string; message?: string };
      throw new WordPressRestError(response.status, String(parsed.message ?? `WordPress REST error ${response.status}`).slice(0, 500), parsed.code);
    }
    return body as T;
  }

  async whoAmI(): Promise<WordPressSessionUser> {
    const me = await this.rest<{ id: number; name?: string; slug?: string; roles?: string[]; capabilities?: Record<string, boolean> }>(
      "/wp-json/wp/v2/users/me?context=edit");
    return { id: me.id, name: me.name ?? "", slug: me.slug ?? "", roles: me.roles ?? [], capabilities: me.capabilities ?? {} };
  }

  // Elementor prints its common config (including the elementor_ajax nonce) on ordinary
  // admin screens, so the nonce is read from the dashboard rather than the editor, which
  // would take the post's edit lock.
  async elementorNonce(refresh = false): Promise<string> {
    if (this.elementorNonceValue && !refresh) return this.elementorNonceValue;
    const html = await this.adminPage("/wp-admin/");
    const match = /"ajax":\{"url":"[^"]*","nonce":"([0-9a-f]+)"/.exec(html);
    if (!match?.[1]) throw new WordPressSessionError("wordpress_session_invalid_response", 502, "Elementor's editor token was not found in wp-admin. Is Elementor active?");
    this.elementorNonceValue = match[1];
    return match[1];
  }

  async elementorAjax(postId: number, actions: Record<string, { action: string; data: Record<string, unknown> }>): Promise<Record<string, ElementorAjaxResponse>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const form = new URLSearchParams({
        action: "elementor_ajax", _nonce: await this.elementorNonce(attempt > 0),
        editor_post_id: String(postId), actions: JSON.stringify(actions)
      });
      const response = await this.raw("/wp-admin/admin-ajax.php", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString()
      });
      // admin-ajax answers "0"/"-1" when the request is not logged in at all.
      if (/^-?[01]$/.test(response.text.trim())) throw expired();
      let parsed: { success?: boolean; data?: { responses?: Record<string, ElementorAjaxResponse> } };
      try { parsed = JSON.parse(response.text); } catch {
        throw new WordPressSessionError("wordpress_session_invalid_response", 502, "Elementor returned an invalid response.");
      }
      // A stale nonce ("Token Expired.") is retried once with a fresh one.
      if (response.status === 401 && attempt === 0) continue;
      if (response.status === 401) throw expired();
      if (!parsed.data?.responses) throw new WordPressSessionError("wordpress_session_invalid_response", 502, "Elementor returned no action responses.");
      return parsed.data.responses;
    }
    throw expired();
  }

  // Best-effort server-side logout so a disconnected session cannot be replayed.
  async logout(): Promise<void> {
    try {
      const html = await this.adminPage("/wp-admin/");
      const match = /wp-login\.php\?action=logout(?:&amp;|&)_wpnonce=([0-9a-f]+)/.exec(html);
      if (match?.[1]) await sessionRequest(this.jar, joinUrl(this.baseUrl, `/wp-login.php?action=logout&_wpnonce=${match[1]}`), {}, this.options);
    } catch {
      // Already expired or unreachable: nothing left to revoke.
    }
  }
}

function expired(): WordPressSessionError {
  return new WordPressSessionError("wordpress_session_expired", 401, "The WordPress login session has expired. Reconnect it in AIBroker under WordPress Sessions.");
}
