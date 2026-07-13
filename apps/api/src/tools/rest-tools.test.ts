import { describe, expect, it } from "vitest";
import { REST_TOOL_DEFINITIONS } from "@aibroker/mcp-tools";
import { REST_TOOL_HANDLERS } from "./rest-tools.js";

describe("typed REST tool registry", () => {
  it("has an execution handler for every REST tool definition", () => {
    expect(Object.keys(REST_TOOL_HANDLERS).sort()).toEqual(REST_TOOL_DEFINITIONS.map((tool) => tool.name).sort());
  });

  it("requires idempotency keys for every mutation", () => {
    for (const tool of REST_TOOL_DEFINITIONS.filter((candidate) => candidate.isWrite)) {
      expect(tool.inputSchema.required, tool.name).toContain("idempotency_key");
    }
  });
});
