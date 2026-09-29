import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateOrLocalAddress } from "@aibroker/core";

// Shares the broker's connector blocklist so the two SSRF guards cannot drift apart.
export function isPrivateAddress(address: string): boolean {
  return isPrivateOrLocalAddress(address);
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
  return value === "::" || /^fe[89ab]/.test(value) || value.startsWith("ff");
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
