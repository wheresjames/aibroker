import { afterEach, describe, expect, it, vi } from "vitest";
import { completeTwoFactorLogin, loginWordPress, sessionFromBrowserState, WordPressSessionClient, WordPressSessionError, type PendingTwoFactor, type WordPressSessionState } from "./session.js";

const BASE = "http://localhost";
const LOGIN_FORM = '<form name="loginform"><input name="log"><input name="pwd"></form>';
const future = () => new Date(Date.now() + 14 * 86400_000).toUTCString();

type Handler = (url: URL, init: RequestInit) => Response;
function stub(handler: Handler) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    return handler(url, init);
  }));
  return calls;
}
function html(body: string, status = 200, headers: Array<[string, string]> = []) {
  return new Response(body, { status, headers: [["content-type", "text/html"], ...headers] });
}
function cookieHeader(init: RequestInit): string {
  return String((init.headers as Record<string, string> | undefined)?.cookie ?? "");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("loginWordPress", () => {
  const login = (extra: Partial<Parameters<typeof loginWordPress>[0]> = {}) =>
    loginWordPress({ baseUrl: BASE, username: "editor", password: "pw", allowPrivateTargets: true, ...extra });

  it("returns auth cookies without the password and sends the test cookie", async () => {
    const calls = stub((url, init) => init.method === "POST"
      ? html("", 302, [["location", `${BASE}/wp-admin/`],
        ["set-cookie", `wordpress_logged_in_abc=user%7C1; expires=${future()}; path=/; httponly`],
        ["set-cookie", `wordpress_abc=user%7C2; expires=${future()}; path=/wp-admin; httponly`]])
      : url.pathname === "/wp-admin/admin-ajax.php" ? html("abc123") : url.pathname === "/wp-admin/" ? html("dashboard") : html(LOGIN_FORM));
    const { state, expiresAt } = await login();
    expect(state.cookies.map((cookie) => cookie.name).sort()).toEqual(["wordpress_abc", "wordpress_logged_in_abc"]);
    expect(JSON.stringify(state)).not.toContain("pw");
    expect(expiresAt!.getTime()).toBeGreaterThan(Date.now() + 13 * 86400_000);
    const post = calls.find((call) => call.init.method === "POST")!;
    expect(cookieHeader(post.init)).toContain("wordpress_test_cookie=");
    expect(String(post.init.body)).toContain("rememberme=forever");
  });

  it("does not trust auth cookies WordPress has already invalidated", async () => {
    stub((url, init) => init.method === "POST"
      ? html("<p>welcome</p>", 200, [["set-cookie", `wordpress_logged_in_abc=x; expires=${future()}; path=/`]])
      : url.pathname === "/wp-admin/admin-ajax.php" ? new Response("0", { status: 400 }) : html(LOGIN_FORM));
    await expect(login()).rejects.toMatchObject({ code: "wordpress_login_failed" });
  });

  it("reports rejected credentials", async () => {
    stub((_url, init) => html(init.method === "POST" ? `<div id="login_error">Incorrect</div>${LOGIN_FORM}` : LOGIN_FORM));
    await expect(login()).rejects.toMatchObject({ code: "wordpress_login_failed" });
  });

  it("detects a two-factor step only after the password is accepted", async () => {
    stub((_url, init) => html(init.method === "POST" ? '<form><input name="authcode"></form>' : `${LOGIN_FORM}<script src="wfls-login.js"></script>`));
    await expect(login()).rejects.toMatchObject({ code: "wordpress_login_challenge", challenge: "two_factor" });
  });

  it("detects a CAPTCHA before posting the password", async () => {
    const calls = stub(() => html(`${LOGIN_FORM}<div class="g-recaptcha"></div>`));
    await expect(login()).rejects.toMatchObject({ code: "wordpress_login_challenge", challenge: "captcha" });
    expect(calls.some((call) => call.init.method === "POST")).toBe(false);
  });

  it("reports a renamed login page and honours a custom login path", async () => {
    stub((url) => url.pathname === "/secret-login" ? html(LOGIN_FORM) : html("not found", 404));
    await expect(login()).rejects.toMatchObject({ code: "wordpress_login_url_not_found" });
    await expect(login({ loginPath: "/secret-login" })).rejects.toMatchObject({ code: "wordpress_login_failed" });
  });

  it("treats a redirect to another host as single sign-on", async () => {
    stub(() => html("", 302, [["location", "https://sso.example.com/authorize"]]));
    await expect(login()).rejects.toMatchObject({ code: "wordpress_login_challenge", challenge: "sso" });
  });
});

describe("WordPressSessionClient", () => {
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  const state = (overrides: Partial<WordPressSessionState> = {}): WordPressSessionState => ({
    version: 1, baseUrl: BASE, cookies: [
      { name: "wordpress_logged_in_abc", value: "L", path: "/", expiresAt: expiry, secure: false },
      { name: "wordpress_abc", value: "A", path: "/wp-admin", expiresAt: expiry, secure: false },
      { name: "wordpress_sec_abc", value: "S", path: "/wp-admin", expiresAt: expiry, secure: true }
    ], ...overrides
  });
  const client = (s = state()) => new WordPressSessionClient({ state: s, allowPrivateTargets: true });
  const dashboard = '<script>var elementorCommonConfig = {"ajax":{"url":"x","nonce":"abc123"}};</script><a href="wp-login.php?action=logout&amp;_wpnonce=9f9f">Log out</a>';

  it("scopes cookies by path and never sends Secure cookies over http", async () => {
    const calls = stub((url) => url.pathname === "/wp-admin/" ? html(dashboard) : html("ok"));
    await client().adminPage("/wp-admin/");
    const header = cookieHeader(calls[0]!.init);
    expect(header).toContain("wordpress_logged_in_abc=L");
    expect(header).toContain("wordpress_abc=A");
    expect(header).not.toContain("wordpress_sec_abc");
  });

  it("treats a bounce to wp-login.php as an expired session", async () => {
    stub((url) => url.pathname === "/wp-login.php" ? html(LOGIN_FORM) : html("", 302, [["location", `${BASE}/wp-login.php?redirect_to=x`]]));
    await expect(client().adminPage()).rejects.toMatchObject({ code: "wordpress_session_expired" });
  });

  it("refuses to send cookies that have already expired", async () => {
    const calls = stub(() => html("ok"));
    const past = state({ cookies: state().cookies.map((cookie) => ({ ...cookie, expiresAt: 1 })) });
    await expect(client(past).adminPage()).rejects.toBeInstanceOf(WordPressSessionError);
    expect(calls).toHaveLength(0);
  });

  it("calls elementor_ajax with the dashboard nonce and retries once on a stale token", async () => {
    let posts = 0;
    const calls = stub((url, init) => {
      if (url.pathname === "/wp-admin/") return html(dashboard);
      posts++;
      if (posts === 1) return new Response(JSON.stringify({ success: false, data: { responses: { "": { success: false, data: "Token Expired." } } } }), { status: 401 });
      return new Response(JSON.stringify({ success: true, data: { responses: { r: { success: true, code: 200, data: { ok: 1 } } } } }), { status: 200 });
    });
    const responses = await client().elementorAjax(5, { r: { action: "get_document_config", data: { id: 5 } } });
    expect(responses.r).toMatchObject({ success: true, data: { ok: 1 } });
    const body = new URLSearchParams(String(calls.at(-1)!.init.body));
    expect(body.get("action")).toBe("elementor_ajax");
    expect(body.get("_nonce")).toBe("abc123");
    expect(body.get("editor_post_id")).toBe("5");
    expect(JSON.parse(body.get("actions")!)).toEqual({ r: { action: "get_document_config", data: { id: 5 } } });
  });

  it("maps admin-ajax's bare 0 to an expired session", async () => {
    stub((url) => url.pathname === "/wp-admin/" ? html(dashboard) : new Response("0", { status: 400 }));
    await expect(client().elementorAjax(5, { r: { action: "save_builder", data: {} } })).rejects.toMatchObject({ code: "wordpress_session_expired" });
  });

  it("logs out with the nonce from the dashboard link", async () => {
    const calls = stub((url) => url.pathname === "/wp-admin/" ? html(dashboard) : html("bye"));
    await client().logout();
    expect(calls.some((call) => call.url.pathname === "/wp-login.php" && call.url.searchParams.get("_wpnonce") === "9f9f")).toBe(true);
  });
});

describe("two-factor relay", () => {
  const TWO_FACTOR_FORM = `<form name="validate_2fa_form" action="${BASE}/wp-login.php?action=validate_2fa" method="post">
    <input type="hidden" name="provider" value="Two_Factor_Totp" /><input type="hidden" name="wp-auth-id" value="3" />
    <input type="hidden" name="wp-auth-nonce" value="n1" /><input type="hidden" name="redirect_to" value="${BASE}/wp-admin/" />
    <input type="text" autocomplete="one-time-code" name="authcode" value="" /><input type="submit" name="submit" value="Verify" /></form>`;
  const login = () => loginWordPress({ baseUrl: BASE, username: "editor", password: "pw", allowPrivateTargets: true });
  const failure = async (promise: Promise<unknown>) => {
    try { await promise; } catch (err) { return err as WordPressSessionError; }
    throw new Error("expected a challenge");
  };
  const lastPost = (calls: Array<{ url: URL; init: RequestInit }>) =>
    new URLSearchParams(String(calls.filter((call) => call.init.method === "POST").at(-1)!.init.body));

  it("relays a Two Factor / WP 2FA form and rotates the nonce after a wrong code", async () => {
    let attempt = 0;
    const calls = stub((url, init) => {
      if (url.pathname === "/wp-admin/admin-ajax.php") return html("abc123");
      if (init.method !== "POST") return html(LOGIN_FORM);
      if (!url.search.includes("validate_2fa")) return html(TWO_FACTOR_FORM);
      attempt++;
      if (attempt === 1) return html(`<div id="login_error">Invalid verification code.</div>${TWO_FACTOR_FORM.replace("n1", "n2")}`);
      return html("", 302, [["location", `${BASE}/wp-admin/`], ["set-cookie", `wordpress_logged_in_abc=ok; expires=${future()}; path=/`]]);
    });
    const challenge = await failure(login());
    expect(challenge).toMatchObject({ code: "wordpress_login_challenge", challenge: "two_factor" });
    const pending = challenge.pending as Extract<PendingTwoFactor, { strategy: "form" }>;
    expect(pending).toMatchObject({ strategy: "form", codeField: "authcode", fields: { "wp-auth-id": "3", "wp-auth-nonce": "n1", provider: "Two_Factor_Totp" } });
    expect(JSON.stringify(pending)).not.toContain('"pw"');

    const wrong = await failure(completeTwoFactorLogin(pending, "000000", { allowPrivateTargets: true }));
    expect(wrong).toMatchObject({ code: "wordpress_2fa_invalid", message: "Invalid verification code." });
    expect((wrong.pending as typeof pending).fields["wp-auth-nonce"]).toBe("n2");

    const done = await completeTwoFactorLogin(wrong.pending!, "123 456", { allowPrivateTargets: true });
    expect(done.state.cookies.map((cookie) => cookie.name)).toContain("wordpress_logged_in_abc");
    const body = lastPost(calls);
    expect(Object.fromEntries(body)).toMatchObject({ authcode: "123456", "wp-auth-nonce": "n2", "wp-auth-id": "3" });
    expect(body.has("submit")).toBe(false);
  });

  it("relays Wordfence by resending the credentials with wfls-token", async () => {
    const calls = stub((url, init) => {
      if (url.pathname === "/wp-admin/admin-ajax.php") return html("abc123");
      if (init.method !== "POST") return html(LOGIN_FORM);
      if (!new URLSearchParams(String(init.body)).has("wfls-token")) {
        return html(`<div id="login_error"><strong>CODE REQUIRED</strong>: Please provide your 2FA code when prompted.</div>${LOGIN_FORM}<script src="wfls.js"></script>`);
      }
      return html("", 302, [["location", `${BASE}/wp-admin/`], ["set-cookie", `wordpress_logged_in_abc=ok; expires=${future()}; path=/`]]);
    });
    const challenge = await failure(login());
    expect(challenge.pending).toMatchObject({ strategy: "wordfence", username: "editor", password: "pw" });
    await completeTwoFactorLogin(challenge.pending!, "654321", { allowPrivateTargets: true });
    expect(Object.fromEntries(lastPost(calls))).toMatchObject({ log: "editor", pwd: "pw", "wfls-token": "654321" });
  });

  it("refuses a verification form that posts to another site", async () => {
    const pending: PendingTwoFactor = { version: 1, strategy: "form", baseUrl: BASE, loginUrl: `${BASE}/wp-login.php`, cookies: [],
      action: "https://evil.example/collect", fields: {}, codeField: "authcode" };
    await expect(completeTwoFactorLogin(pending, "123456", { allowPrivateTargets: true })).rejects.toMatchObject({ code: "wordpress_login_challenge" });
  });
});

describe("sessionFromBrowserState", () => {
  it("keeps this site's cookies and verifies them", async () => {
    stub((url) => url.pathname === "/wp-admin/admin-ajax.php" ? html("abc123") : html("ok"));
    const expires = Math.floor(Date.now() / 1000) + 86400;
    const { state } = await sessionFromBrowserState(BASE, { cookies: [
      { name: "wordpress_logged_in_abc", value: "L", domain: "localhost", path: "/", expires, secure: false },
      { name: "_ga", value: "x", domain: ".google.com", path: "/", expires }
    ] }, { allowPrivateTargets: true });
    expect(state.cookies.map((cookie) => cookie.name)).toEqual(["wordpress_logged_in_abc"]);
  });

  it("rejects a browser state that is not logged in", async () => {
    stub(() => new Response("0", { status: 400 }));
    await expect(sessionFromBrowserState(BASE, { cookies: [] }, { allowPrivateTargets: true })).rejects.toMatchObject({ code: "wordpress_login_failed" });
  });
});
