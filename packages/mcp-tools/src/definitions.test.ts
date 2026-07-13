import { describe, expect, it } from "vitest";
import { MVP_TOOL_DEFINITIONS } from "./definitions.js";

describe("MVP tool definitions", () => {
  it("registers the five MVP tools with schemas", () => {
    expect(MVP_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "wordpress.list_sites",
        "wordpress.get_site_summary",
        "wordpress.list_pages",
        "wordpress.get_page",
        "wordpress.create_draft_page",
        "wordpress.update_draft_page",
        "wordpress.publish_page",
        "wordpress.list_posts",
        "wordpress.list_plugins",
        "wordpress.run_health_check"
      ])
    );
    expect(MVP_TOOL_DEFINITIONS.every((tool) => tool.inputSchema && tool.outputSchema)).toBe(true);
  });
});
