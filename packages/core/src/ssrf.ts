import dns from "node:dns/promises";
import net from "node:net";

export interface ConnectorTargetValidationOptions {
  allowPrivateTargets?: boolean;
}

export interface ConnectorTargetValidationResult {
  url: URL;
  addresses: string[];
}

export async function validateConnectorTarget(
  rawUrl: string,
  options: ConnectorTargetValidationOptions = {}
): Promise<ConnectorTargetValidationResult> {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Connector target must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Connector target URL must not include credentials");
  }

  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  const addresses = records.map((record) => record.address);
  if (!options.allowPrivateTargets) {
    for (const address of addresses) {
      if (isPrivateOrLocalAddress(address)) {
        throw new Error(`Connector target resolves to disallowed address ${address}`);
      }
    }
  }
  return { url, addresses };
}

export function isPrivateOrLocalAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map((part) => Number.parseInt(part, 10));
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  return (
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80:") ||
    lower === "::"
  );
}
