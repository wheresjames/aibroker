import { describe, expect, it, vi } from "vitest";
import { prepareApiDatabase } from "./startup.js";

describe("API database startup", () => {
  it("synchronizes plugin manifests after migrations and before startup completes", async () => {
    const calls: string[] = [];
    const migrate = vi.fn(async () => { calls.push("migrate"); });
    const syncCatalog = vi.fn(async () => { calls.push("catalog"); });

    await prepareApiDatabase("postgres://test", { migrate, syncCatalog });

    expect(calls).toEqual(["migrate", "catalog"]);
    expect(syncCatalog).toHaveBeenCalledWith("postgres://test");
  });

  it("does not expose startup when catalog synchronization fails", async () => {
    await expect(prepareApiDatabase("postgres://test", {
      migrate: vi.fn(async () => undefined),
      syncCatalog: vi.fn(async () => { throw new Error("catalog unavailable"); })
    })).rejects.toThrow("catalog unavailable");
  });
});
