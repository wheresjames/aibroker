import { afterEach, describe, expect, it } from "vitest";
import { readSession, renderCell, SESSION_KEY } from "./helpers.js";

const originalLocalStorage = globalThis.localStorage;

function installStorage(value: string | null) {
  const values = new Map<string, string>();
  if (value != null) values.set(SESSION_KEY, value);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, next: string) => values.set(key, next),
      removeItem: (key: string) => values.delete(key)
    }
  });
  return values;
}

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
});

describe("web shell", () => {
  it("has a test harness", () => {
    expect("AIBroker").toContain("Broker");
  });

  it("discards a legacy persisted user that has no signed session token", () => {
    const values = installStorage(JSON.stringify({ user: { id: "admin-1", role: "global_admin" }, expiresAt: Date.now() + 60_000 }));
    expect(readSession()).toBeNull();
    expect(values.has(SESSION_KEY)).toBe(false);
  });

  it("restores a persisted user with a signed session token", () => {
    installStorage(JSON.stringify({
      user: { id: "admin-1", role: "global_admin", session_token: "payload.signature" },
      expiresAt: Date.now() + 60_000
    }));
    expect(readSession()).toMatchObject({ id: "admin-1", session_token: "payload.signature" });
  });

  it("does not render an empty status chip for a missing revocation date", () => {
    expect(renderCell("", "revoked_at")).toBe("");
  });
});
