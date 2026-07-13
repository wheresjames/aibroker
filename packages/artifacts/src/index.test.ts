import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesystemArtifactStore, S3ArtifactStore } from "./index.js";

afterEach(() => vi.unstubAllGlobals());

describe("FilesystemArtifactStore", () => {
  it("stores, reads, and deletes bounded artifacts", async () => {
    const store = new FilesystemArtifactStore(await mkdtemp(path.join(tmpdir(), "aib-artifacts-")));
    const value = new TextEncoder().encode("image"); const stored = await store.put(value, 100);
    expect(new TextDecoder().decode(await store.get(stored.key, 100))).toBe("image");
    await store.delete(stored.key); await expect(store.get(stored.key, 100)).rejects.toThrow();
  });
  it("rejects oversized artifacts", async () => {
    const store = new FilesystemArtifactStore(await mkdtemp(path.join(tmpdir(), "aib-artifacts-")));
    await expect(store.put(new Uint8Array(2), 1)).rejects.toThrow("artifact_size_exceeded");
  });
});

describe("S3ArtifactStore", () => {
  it("implements the bounded signed storage contract", async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      if (init?.method === "GET") return new Response("image", { status: 200, headers: { "content-length": "5" } });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = new S3ArtifactStore({ endpoint: "https://objects.example", region: "test-1", bucket: "artifacts", accessKeyId: "id", secretAccessKey: "secret" });
    const stored = await store.put(new TextEncoder().encode("image"), 100);
    expect(new TextDecoder().decode(await store.get(stored.key, 100))).toBe("image");
    await store.delete(stored.key); await store.health();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const authorization = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization");
    expect(authorization).toContain("AWS4-HMAC-SHA256 Credential=id/");
  });
});
