import { describe, expect, it } from "vitest";
import { tristate, bulkApply, diffPermissions, domainsWithTools, cellTools, type PermState } from "./helpers.js";
import type { ToolDefinition } from "./types.js";

function tool(name: string, domain: string, action: ToolDefinition["action"], risk: ToolDefinition["risk"] = "low"): ToolDefinition {
  return { name, domain, action, risk, category: action === "read" ? "read" : "write", is_write: action !== "read" };
}

const tools: ToolDefinition[] = [
  tool("wordpress.list_pages", "content", "read"),
  tool("wordpress.create_draft_page", "content", "create"),
  tool("wordpress.update_draft_page", "content", "change"),
  tool("wordpress.list_media", "media", "read")
];

describe("permission matrix state", () => {
  it("computes tristate over a set of tools", () => {
    const content = cellTools(tools, "content", "read");
    expect(tristate(content, {}, "allow")).toBe("unchecked");
    expect(tristate(content, { "wordpress.list_pages": { allow: true, deny: false } }, "allow")).toBe("checked");
    const two = tools.filter((t) => t.domain === "content");
    expect(tristate(two, { "wordpress.list_pages": { allow: true, deny: false } }, "allow")).toBe("indeterminate");
  });

  it("lists only domains that have tools, in canonical order", () => {
    expect(domainsWithTools(tools)).toEqual(["content", "media"]);
  });

  it("bulk allow does not touch existing denies", () => {
    const before: PermState = { "wordpress.list_pages": { allow: false, deny: true } };
    const after = bulkApply(before, tools, "allow");
    expect(after["wordpress.list_pages"]).toEqual({ allow: true, deny: true });
  });

  it("bulk clear removes allows but preserves denies", () => {
    const before: PermState = { "wordpress.list_pages": { allow: true, deny: true } };
    const after = bulkApply(before, [tools[0]!], "clear");
    expect(after["wordpress.list_pages"]).toEqual({ allow: false, deny: true });
  });

  it("bulk deny and undeny do not touch allows", () => {
    const withAllow: PermState = { "wordpress.list_media": { allow: true, deny: false } };
    const denied = bulkApply(withAllow, [tools[3]!], "deny");
    expect(denied["wordpress.list_media"]).toEqual({ allow: true, deny: true });
    const undenied = bulkApply(denied, [tools[3]!], "undeny");
    expect(undenied["wordpress.list_media"]).toEqual({ allow: true, deny: false });
  });

  it("diffs permission states into explicit tool lists", () => {
    const before: PermState = { a: { allow: true, deny: false }, b: { allow: false, deny: true } };
    const after: PermState = { a: { allow: false, deny: false }, c: { allow: true, deny: false }, b: { allow: false, deny: false } };
    const diff = diffPermissions(before, after);
    expect(diff.allowAdded).toEqual(["c"]);
    expect(diff.allowRemoved).toEqual(["a"]);
    expect(diff.denyRemoved).toEqual(["b"]);
    expect(diff.denyAdded).toEqual([]);
  });
});
