import { describe, expect, it } from "vitest";
import { isPrivateOrLocalAddress } from "./ssrf.js";

describe("isPrivateOrLocalAddress", () => {
  it("blocks private and local addresses", () => {
    expect(isPrivateOrLocalAddress("127.0.0.1")).toBe(true);
    expect(isPrivateOrLocalAddress("10.1.2.3")).toBe(true);
    expect(isPrivateOrLocalAddress("172.16.0.1")).toBe(true);
    expect(isPrivateOrLocalAddress("192.168.1.1")).toBe(true);
    expect(isPrivateOrLocalAddress("8.8.8.8")).toBe(false);
  });
});
