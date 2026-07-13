import { describe, expect, it } from "vitest";
import { redactObject } from "./redact.js";

describe("redactObject", () => {
  it("redacts nested secret-like keys", () => {
    expect(
      redactObject({
        email: "admin@example.com",
        token: "abc",
        nested: { password: "secret" }
      })
    ).toEqual({
      email: "admin@example.com",
      token: "[REDACTED]",
      nested: { password: "[REDACTED]" }
    });
  });
});
