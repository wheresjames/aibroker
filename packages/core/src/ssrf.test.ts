import { describe, expect, it } from "vitest";
import { connectorFetch, isPrivateOrLocalAddress } from "./ssrf.js";

describe("isPrivateOrLocalAddress", () => {
  it.each([
    "::ffff:127.0.0.1", "::ffff:a00:1", "0:0:0:0:0:ffff:c0a8:101",
    "::ffff:172.16.0.1", "::ffff:169.254.169.254", "0:0:0:0:0:0:0:1"
  ])("blocks mapped or expanded private address %s", (address) => {
    expect(isPrivateOrLocalAddress(address)).toBe(true);
  });

  it("allows mapped public addresses", () => {
    expect(isPrivateOrLocalAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("blocks private and local addresses", () => {
    expect(isPrivateOrLocalAddress("127.0.0.1")).toBe(true);
    expect(isPrivateOrLocalAddress("10.1.2.3")).toBe(true);
    expect(isPrivateOrLocalAddress("172.16.0.1")).toBe(true);
    expect(isPrivateOrLocalAddress("192.168.1.1")).toBe(true);
    expect(isPrivateOrLocalAddress("8.8.8.8")).toBe(false);
  });

  it.each([
    "100.64.0.1", "192.0.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "fe90::1", "febf::1", "fec0::1", "ff02::1", "2002:7f00:1::1", "::7f00:1"
  ])("blocks additional reserved address %s", (address) => {
    expect(isPrivateOrLocalAddress(address)).toBe(true);
  });

  it("allows ordinary public addresses", () => {
    expect(isPrivateOrLocalAddress("1.1.1.1")).toBe(false);
    expect(isPrivateOrLocalAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateOrLocalAddress("64:ff9b::808:808")).toBe(false);
  });
});

describe("connectorFetch", () => {
  const blockedCode = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;

  it("refuses to connect when a hostname resolves to a private address", async () => {
    expect(blockedCode(await connectorFetch("http://localhost:8080/").catch((err) => err))).toBe("ESSRFBLOCKED");
  });

  it("refuses private IP literals", async () => {
    expect(blockedCode(await connectorFetch("http://127.0.0.1:8080/").catch((err) => err))).toBe("ESSRFBLOCKED");
    expect(blockedCode(await connectorFetch("http://[::1]:8080/").catch((err) => err))).toBe("ESSRFBLOCKED");
  });
});
