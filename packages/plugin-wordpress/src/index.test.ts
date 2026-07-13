import { describe, expect, it } from "vitest";
import { wordpressPlugin } from "./index.js";
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
});
