import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.js";
import { generateApiToken, verifyApiToken } from "./tokens.js";

describe("auth primitives", () => {
  it("hashes and verifies passwords", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("generates hashed api tokens", () => {
    const generated = generateApiToken();
    expect(generated.token).toMatch(/^wpb_/);
    expect(generated.hash).not.toContain(generated.token);
    expect(verifyApiToken(generated.token, generated.hash)).toBe(true);
  });
});
