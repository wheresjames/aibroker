import { describe, expect, it, vi } from "vitest";
import { pluginConformanceProblems } from "@aibroker/plugin-sdk";
import { normalizePlaywrightConfig, playwrightPlugin, PLAYWRIGHT_TOOL_DEFINITIONS } from "./index.js";

const server = { id: "1", name: "Site", address: "example.com", metadata: {} };
describe("playwright plugin", () => {
  it("conforms to the plugin contract", () => expect(pluginConformanceProblems(playwrightPlugin)).toEqual([]));
  it("normalizes exact origins and typed limits", () => expect(normalizePlaywrightConfig({ allowed_origins: "https://example.com" }, server)).toMatchObject({
    base_url: "https://example.com/", allowed_origins: ["https://example.com"], viewport_width: 1440
  }));
  it("rejects wildcard/path origins", () => expect(() => normalizePlaywrightConfig({ allowed_origins: "https://example.com/path" }, server)).toThrow(/exact/));
  it("dispatches through the browser executor", async () => {
    const execute = vi.fn(async () => ({ kind: "broker_tool_result" as const, structuredContent: {} }));
    await playwrightPlugin.execute(playwrightPlugin.tools[0]!, { server_plugin_id: "x" }, {
      id: "x", instanceName: "Browser", config: {}, server,
      actorUserId: "u", actorTokenId: "t", services: { executors: { playwright: execute } }
    });
    expect(execute).toHaveBeenCalled();
  });
  it("defines leased sessions and only treats click as a browser write", () => {
    const byName = new Map(PLAYWRIGHT_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    expect(byName.get("playwright.open_session")?.risk).toBe("medium");
    expect(byName.get("playwright.fill")?.isWrite).toBe(false);
    expect(byName.get("playwright.click")?.isWrite).toBe(true);
    expect(byName.get("playwright.click")?.inputSchema).toMatchObject({ required: expect.arrayContaining(["session_id", "idempotency_key"]) });
  });
  it("keeps form-changing interactions out of the read persona", () => {
    expect(playwrightPlugin.accessLevels.read.toolNames).not.toContain("playwright.fill");
    expect(playwrightPlugin.accessLevels.contribute.toolNames).toContain("playwright.click");
  });
});
