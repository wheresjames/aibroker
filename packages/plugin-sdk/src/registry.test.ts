import { describe, expect, it, vi } from "vitest";
import { PluginRegistry, auditSafeToolResult, interpolateServerConfig, materializePluginIntent, type BrokerPlugin } from "./index.js";

const plugin = (key = "demo"): BrokerPlugin => ({
  key, name: "Demo", version: 1, description: "test", cardinality: "multi", minRoleToEnable: "team_admin",
  configSchema: {}, credentialKinds: [], domains: [],
  accessLevels: {
    none: { label: "None", description: "", riskCeiling: null, toolNames: [] },
    read: { label: "Read", description: "", riskCeiling: "medium", toolNames: [`${key}.read`] },
    contribute: { label: "Contribute", description: "", riskCeiling: "medium", toolNames: [`${key}.read`] },
    manage: { label: "Manage", description: "", riskCeiling: "high", toolNames: [`${key}.read`] },
    full: { label: "Full", description: "", riskCeiling: "critical", toolNames: [`${key}.read`] }
  },
  tools: [{ name: `${key}.read`, version: 1, category: "read", isWrite: false, inputSchema: {}, outputSchema: {}, domain: "demo", action: "read", risk: "low", reversible: true, executorKind: "demo", credentialKinds: [], supportsDryRun: false, isLongRunning: false, description: "read" }],
  probeCapabilities: vi.fn(async () => []), execute: vi.fn(async () => ({}))
});

describe("PluginRegistry", () => {
  it("resolves namespaced tools to their plugin", () => {
    const registry = new PluginRegistry().register(plugin());
    expect(registry.resolveTool("demo.read")?.plugin.key).toBe("demo");
  });
  it("rejects duplicate plugins", () => {
    const registry = new PluginRegistry().register(plugin());
    expect(() => registry.register(plugin())).toThrow(/already registered/);
  });
  it("interpolates the server address recursively", () => {
    expect(interpolateServerConfig({ url: "http://${server.address}:8080" }, { id: "1", name: "x", address: "host.test", metadata: {} }))
      .toEqual({ url: "http://host.test:8080" });
  });
  it("materializes a simple persona into concrete tool rows", () => {
    expect(materializePluginIntent(plugin(), {
      pluginKey: "demo", mode: "simple", accessLevel: "read", riskCeiling: "medium"
    }, new Set(["demo.read"]))).toEqual([
      { toolName: "demo.read", effect: "allow", constraints: {}, riskCeiling: "medium" }
    ]);
  });
  it("holds unreviewed high-risk tools out of materialized grants", () => {
    const high = plugin();
    high.tools[0] = { ...high.tools[0]!, risk: "high" };
    high.accessLevels.manage = { ...high.accessLevels.manage, toolNames: ["demo.read"], riskCeiling: "high" };
    expect(materializePluginIntent(high, {
      pluginKey: "demo", mode: "simple", accessLevel: "manage", riskCeiling: "high"
    }, new Set())).toEqual([]);
  });
  it("auto-includes matching low-risk tools without review", () => {
    expect(materializePluginIntent(plugin(), {
      pluginKey: "demo", mode: "simple", accessLevel: "read", riskCeiling: "medium"
    }, new Set()).map((row) => row.toolName)).toEqual(["demo.read"]);
  });
  it("removes binary content from the audit representation", () => {
    expect(auditSafeToolResult({ kind: "broker_tool_result", structuredContent: { ok: true },
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      artifacts: [{ id: "a", uri: "aibroker://artifacts/a", mimeType: "image/png", size: 6, sha256: "hash", expiresAt: "later" }]
    })).toEqual({ ok: true, artifacts: [{ id: "a", uri: "aibroker://artifacts/a", mime_type: "image/png", size: 6, sha256: "hash", expires_at: "later", redaction_status: "not_applicable" }] });
  });
});
