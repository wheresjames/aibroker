import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function privateV4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a = -1, b = -1] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return privateV4(address);
  if (isIP(address) !== 6) return true;
  const value = address.toLowerCase();
  return value === "::" || value === "::1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")
    || value.startsWith("ff") || (value.startsWith("::ffff:") && privateV4(value.slice(7)));
}

export interface DestinationPolicy {
  allowedOrigins: string[]; allowedPathPrefixes: string[]; allowPrivate: boolean; privateHostname?: string;
  pinnedAddresses?: Map<string, Set<string>>;
}

function alwaysBlocked(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = -1, b = -1] = address.split(".").map(Number);
    return a === 0 || (a === 169 && b === 254) || a >= 224;
  }
  const value = address.toLowerCase();
  if (value.startsWith("::ffff:")) return alwaysBlocked(value.slice(7));
  return value === "::" || value.startsWith("fe80:") || value.startsWith("ff");
}

export async function validateDestination(raw: string, policy: DestinationPolicy): Promise<URL> {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !policy.allowedOrigins.includes(url.origin)) throw new Error("browser_destination_denied");
  if (policy.allowedPathPrefixes.length && !policy.allowedPathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) throw new Error("browser_destination_denied");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => alwaysBlocked(address))) throw new Error("browser_destination_denied");
  const resolved = new Set(addresses.map(({ address }) => address));
  const pinned = policy.pinnedAddresses?.get(url.hostname);
  if (pinned && (resolved.size !== pinned.size || [...resolved].some((address) => !pinned.has(address)))) throw new Error("browser_destination_denied");
  if (!pinned) (policy.pinnedAddresses ??= new Map()).set(url.hostname, resolved);
  if (addresses.some(({ address }) => isPrivateAddress(address)) && (!policy.allowPrivate || policy.privateHostname !== url.hostname)) throw new Error("browser_destination_denied");
  return url;
}
