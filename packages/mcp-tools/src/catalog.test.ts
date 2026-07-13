import { describe, expect, it } from "vitest";
import { MVP_TOOL_DEFINITIONS } from "./definitions.js";
import { validateToolMetadata } from "./catalog.js";
import { POLICY_PRESETS, presetMatchesTool } from "./presets.js";

describe("tool catalog metadata", () => {
  it("every enabled tool has complete, valid metadata", () => {
    for (const tool of MVP_TOOL_DEFINITIONS) {
      expect(validateToolMetadata(tool.name, tool)).toEqual([]);
    }
  });

  it("rejects a tool missing metadata", () => {
    expect(validateToolMetadata("x", undefined)).toContain("x: missing catalog metadata");
  });

  it("flags each invalid metadata field", () => {
    const problems = validateToolMetadata("x", {
      domain: "Not a domain" as never,
      action: "nope" as never,
      risk: "extreme" as never,
      reversible: "yes" as never,
      executorKind: "carrier.pigeon" as never,
      credentialKinds: ["totally fake" as never],
      supportsDryRun: 1 as never,
      isLongRunning: 0 as never,
      description: ""
    });
    expect(problems.length).toBeGreaterThanOrEqual(8);
  });

  it("uses only known domains and actions", () => {
    for (const tool of MVP_TOOL_DEFINITIONS) {
      expect(["read", "create", "change", "remove", "operate"]).toContain(tool.action);
    }
  });

  it("keeps is_write consistent with the action class", () => {
    for (const tool of MVP_TOOL_DEFINITIONS) {
      if (tool.isWrite) expect(["create", "change", "remove", "operate"]).toContain(tool.action);
      else expect(tool.action).toBe("read");
    }
  });
});

describe("policy presets", () => {
  it("has an Everything preset that matches every tool", () => {
    const everything = POLICY_PRESETS.find((preset) => preset.name === "Everything")!;
    for (const tool of MVP_TOOL_DEFINITIONS) {
      expect(presetMatchesTool(everything, tool)).toBe(true);
    }
  });

  it("Read only selects exactly the read tools", () => {
    const readOnly = POLICY_PRESETS.find((preset) => preset.name === "Read only")!;
    for (const tool of MVP_TOOL_DEFINITIONS) {
      expect(presetMatchesTool(readOnly, tool)).toBe(tool.action === "read");
    }
  });

  it("Content editor excludes plugins and themes", () => {
    const editor = POLICY_PRESETS.find((preset) => preset.name === "Content editor")!;
    const plugin = MVP_TOOL_DEFINITIONS.find((tool) => tool.domain === "plugins")!;
    expect(presetMatchesTool(editor, plugin)).toBe(false);
  });
});
