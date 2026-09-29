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
  it("registers page-builder tools with medium-risk writes on the REST credential", () => {
    const byName = new Map(MVP_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    const apply = byName.get("wordpress.elementor_apply_operations");
    expect(apply).toMatchObject({ isWrite: true, risk: "medium", action: "change", domain: "content", executorKind: "rest",
      credentialKinds: ["wordpress_rest_application_password"] });
    expect(apply?.inputSchema).toMatchObject({ required: expect.arrayContaining(["expected_hash", "idempotency_key", "operations"]) });
    expect(byName.get("wordpress.elementor_get_document")).toMatchObject({ isWrite: false, risk: "low" });
  });
});
