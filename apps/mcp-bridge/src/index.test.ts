import { describe, expect, it } from "vitest";

describe("mcp bridge placeholder", () => {
  it("keeps the package in the workspace test suite", () => {
    expect("stdio bridge").toContain("bridge");
  });
});
