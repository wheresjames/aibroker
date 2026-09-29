import { afterEach, describe, expect, it, vi } from "vitest";
import { WordPressRestClient } from "./client.js";

const opts = {
  baseUrl: "http://localhost/",
  credentials: { username: "aibroker", applicationPassword: "secret" },
  allowPrivateTargets: true
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WordPressRestClient", () => {
  it("constructs with credentials", () => {
    expect(new WordPressRestClient(opts)).toBeInstanceOf(WordPressRestClient);
  });

  it("discovers capabilities from the REST root", async () => {
    const responses: Record<string, unknown> = {
      "/wp-json": { name: "Example", namespaces: ["wp/v2", "oembed/1.0"] },
      "/wp-json/wp/v2/types": { post: {}, page: {}, attachment: {} },
      "/wp-json/wp/v2/taxonomies": { category: {}, post_tag: {} }
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      return new Response(JSON.stringify(responses[path] ?? {}), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const discovery = await new WordPressRestClient(opts).discoverCapabilities();
    expect(discovery.reachable).toBe(true);
    expect(discovery.authenticated).toBe(true);
    expect(discovery.namespaces).toContain("wp/v2");
    expect(discovery.mediaSupported).toBe(true);
    expect(discovery.taxonomies).toContain("category");
  });

  it("reports auth failure without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } })));
    const discovery = await new WordPressRestClient(opts).discoverCapabilities();
    expect(discovery.reachable).toBe(true);
    expect(discovery.authenticated).toBe(false);
    expect(discovery.errorCode).toBe("auth_failed");
  });

  it("does not treat the public REST index as proof of authentication", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      return new Response("{}", { status: path === "/wp-json" ? 200 : 401, headers: { "content-type": "application/json" } });
    }));
    const discovery = await new WordPressRestClient(opts).discoverCapabilities();
    expect(discovery.reachable).toBe(true);
    expect(discovery.authenticated).toBe(false);
    expect(discovery.errorCode).toBe("auth_failed");
  });

  it("reports unreachable when the fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const discovery = await new WordPressRestClient(opts).discoverCapabilities();
    expect(discovery.reachable).toBe(false);
    expect(discovery.errorCode).toBe("connector_unavailable");
  });

  it.each([
    ["/wp-json", 401],
    ["/wp-json", 403],
    ["/wp-json/wp/v2/users/me?context=edit", 401],
    ["/wp-json/wp/v2/users/me?context=edit", 403]
  ] as const)("preserves authentication details for %s returning %s", async (endpoint, status) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const parsed = new URL(url);
      return parsed.pathname + parsed.search === endpoint
        ? new Response(JSON.stringify({ code: "application_passwords_disabled", message: "Application passwords are disabled for this user." }), { status })
        : new Response("{}", { status: 200 });
    }));
    const discovery = await new WordPressRestClient(opts).discoverCapabilities();
    expect(discovery.errorCode).toBe("auth_failed");
    expect(discovery.errorMessage).toContain(`GET ${endpoint} failed: HTTP ${status}`);
    expect(discovery.errorMessage).toContain("[application_passwords_disabled]");
    expect(discovery.errorMessage).toContain("Application passwords are disabled for this user.");
  });

  it.each(["", "{}", "<html>Private hosting login</html>"])("explains auth errors without WordPress details: %s", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 401 })));
    const discovery = await new WordPressRestClient(opts).discoverCapabilities();
    expect(discovery.errorMessage).toContain("GET /wp-json failed: HTTP 401");
    expect(discovery.errorMessage).toContain("hosting login, proxy, or security plugin");
    expect(discovery.errorMessage).not.toContain("<html>");
  });

  it("redacts credentials echoed in authentication errors", async () => {
    const password = "abcd efgh ijkl mnop";
    const encoded = Buffer.from(`aibroker:${password}`).toString("base64");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "rejected", message: `${password} ${password.replaceAll(" ", "")} Basic ${encoded}`
    }), { status: 401 })));
    const discovery = await new WordPressRestClient({ ...opts, credentials: { username: "aibroker", applicationPassword: password } }).discoverCapabilities();
    expect(discovery.errorMessage).not.toContain(password);
    expect(discovery.errorMessage).not.toContain(password.replaceAll(" ", ""));
    expect(discovery.errorMessage).not.toContain(encoded);
    expect(discovery.errorMessage).toContain("[redacted]");
  });

  it("reports an invalid REST response instead of exposing a JSON parser error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>WordPress site</html>", { status: 200, headers: { "content-type": "text/html" } })));
    const discovery = await new WordPressRestClient(opts).discoverCapabilities();
    expect(discovery.reachable).toBe(false);
    expect(discovery.errorCode).toBe("invalid_response");
    expect(discovery.errorMessage).toContain("permalink");
  });

  it("does not forward credentials across redirect hosts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/wp-json" } })));
    await expect(new WordPressRestClient(opts).testConnection()).rejects.toMatchObject({ wpCode: "unsafe_redirect" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});


describe("response body timeouts", () => {
  it.each(["rest", "media"])("aborts stalled %s bodies after headers arrive", async (kind) => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          init.signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
        }
      });
      return new Response(body, { headers: { "content-type": "image/png" } });
    }));
    const client = new WordPressRestClient({ ...opts, timeoutMs: 20 });
    const request = kind === "rest" ? client.testConnection() : client.ingestMediaFromUrl({
      url: "http://localhost/image.png", allowedMimeTypes: ["image/png"], maxBytes: 1024
    });
    await expect(request).rejects.toMatchObject({ wpCode: "timeout", statusCode: 504 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
