import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson, loadEncryptionKey } from "./vault.js";

describe("credential vault", () => {
  it("round trips encrypted json", () => {
    const key = loadEncryptionKey(randomBytes(32).toString("base64"));
    const encrypted = encryptJson({ username: "aibroker", password: "secret" }, key);
    expect(encrypted.ciphertext).not.toContain("secret");
    expect(decryptJson(encrypted, key)).toEqual({ username: "aibroker", password: "secret" });
  });
});
