import { describe, expect, it } from "vitest";
import { validateRestAdapter } from "./rest-adapter.js";

describe("REST adapter validation", () => {
  it("rejects an unversioned namespace and empty pass-through adapter", () => {
    expect(validateRestAdapter({
      id: "commerce",
      namespace: "commerce",
      compatibility: {},
      tools: [],
      redactedInputFields: [],
      redactedOutputFields: [],
      discover: () => "unknown"
    })).toEqual(expect.arrayContaining(["namespace must be explicit and versioned", "adapter must define at least one typed tool"]));
  });
});
