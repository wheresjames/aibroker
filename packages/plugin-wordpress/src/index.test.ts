import { describe, expect, it } from "vitest";
import { normalizeWordPressConfig, wordpressPlugin } from "./index.js";
import { pluginConformanceProblems, probeConformanceProblems } from "@aibroker/plugin-sdk";

describe("wordpressPlugin", () => {
  it("declares a multi-instance, namespaced catalog", () => {
    expect(wordpressPlugin.cardinality).toBe("multi");
    expect(wordpressPlugin.minRoleToEnable).toBe("team_admin");
    expect(wordpressPlugin.tools.length).toBeGreaterThan(10);
    expect(wordpressPlugin.tools.every((tool) => tool.name.startsWith("wordpress."))).toBe(true);
  });
  it("passes the plugin conformance kit", () => expect(pluginConformanceProblems(wordpressPlugin)).toEqual([]));
  it("round-trips probed capabilities", async () => expect(await probeConformanceProblems(wordpressPlugin, {
    id: "plugin", instanceName: "WordPress", config: {}, server: { id: "server", name: "test", address: "wordpress", metadata: {} },
    services: { probes: { wordpress: async () => [{ capability: "wordpress_rest", status: "available" as const }] } }
  })).toEqual([]));
  it("includes the Elementor tools and the per-user session credential", () => {
    const names = wordpressPlugin.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["wordpress.elementor_get_document", "wordpress.elementor_apply_operations", "wordpress.elementor_restore_snapshot"]));
    expect(wordpressPlugin.credentialKinds).toContain("wordpress_session");
  });
  it("normalizes form-submitted config", () => {
    expect(normalizeWordPressConfig({ base_url: "https://x.test", elementor_default_publish: "true", block_privileged_sessions: "false", login_path: " /secret-login " }))
      .toEqual({ base_url: "https://x.test", elementor_default_publish: true, block_privileged_sessions: false, login_path: "/secret-login" });
    expect(normalizeWordPressConfig({ login_path: "" })).toEqual({});
    for (const bad of ["https://evil.test/login", "//evil.test", "/../wp-login.php", "wp-login.php"]) {
      expect(() => normalizeWordPressConfig({ login_path: bad }), bad).toThrow(/login_path/);
    }
  });
});
