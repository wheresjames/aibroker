import { afterEach, describe, expect, it, vi } from "vitest";
import { WordPressRestClient } from "./client.js";

const opts = {
  baseUrl: "http://localhost/",
  credentials: { username: "aibroker", applicationPassword: "secret" },
  allowPrivateTargets: true
};

afterEach(() => {
  vi.restoreAllMocks();
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
