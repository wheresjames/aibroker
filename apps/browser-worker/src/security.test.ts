import { describe, expect, it } from "vitest";
import { isPrivateAddress, validateDestination } from "./security.js";
describe("browser destination policy", () => {
  it("classifies private addresses", () => { expect(isPrivateAddress("127.0.0.1")).toBe(true); expect(isPrivateAddress("10.0.0.1")).toBe(true); expect(isPrivateAddress("8.8.8.8")).toBe(false); });
  it("rejects unlisted origins before lookup", async () => await expect(validateDestination("https://evil.invalid/", { allowedOrigins: ["https://example.com"], allowedPathPrefixes: [], allowPrivate: false })).rejects.toThrow("browser_destination_denied"));
  it("allows only an explicitly named private target", async () => {
    await expect(validateDestination("http://127.0.0.1/", { allowedOrigins: ["http://127.0.0.1"], allowedPathPrefixes: [], allowPrivate: true, privateHostname: "127.0.0.1", pinnedAddresses: new Map() })).resolves.toBeInstanceOf(URL);
    await expect(validateDestination("http://127.0.0.1/", { allowedOrigins: ["http://127.0.0.1"], allowedPathPrefixes: [], allowPrivate: true, privateHostname: "other", pinnedAddresses: new Map() })).rejects.toThrow("browser_destination_denied");
  });
  it("always blocks link-local metadata addresses", async () => {
    await expect(validateDestination("http://169.254.169.254/", { allowedOrigins: ["http://169.254.169.254"], allowedPathPrefixes: [], allowPrivate: true, privateHostname: "169.254.169.254", pinnedAddresses: new Map() })).rejects.toThrow("browser_destination_denied");
  });
});
