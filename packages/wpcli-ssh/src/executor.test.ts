import { describe, expect, it } from "vitest";
import { posixQuote } from "./executor.js";

describe("remote argument quoting", () => {
  it("quotes shell metacharacters as one inert argument", () => {
    expect(posixQuote("x; touch /tmp/pwned")).toBe("'x; touch /tmp/pwned'");
    expect(posixQuote("it's")).toBe("'it'\"'\"'s'");
  });
});
