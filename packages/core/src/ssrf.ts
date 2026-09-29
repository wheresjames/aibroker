import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

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

  const records = await dns.promises.lookup(url.hostname, { all: true, verbatim: true });
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

// validateConnectorTarget alone is a check-then-use race: fetch() resolves the hostname
// again, so a short-TTL record can rebind to an internal address between the two. This
// dispatcher re-checks every address at socket-connect time, so the address actually
// dialled is the one that was validated.
const guardedAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, records) => {
        if (err) return callback(err, "", 0);
        const blocked = records.find((record) => isPrivateOrLocalAddress(record.address));
        if (blocked) {
          return callback(Object.assign(new Error(`Connector target resolves to disallowed address ${blocked.address}`), { code: "ESSRFBLOCKED" }), "", 0);
        }
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, r: dns.LookupAddress[]) => void)(null, records);
        const first = records[0];
        if (!first) return callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: "ENOTFOUND" }), "", 0);
        return callback(null, first.address, first.family);
      });
    }
  }
});

/**
 * fetch() for connector targets. With private targets disallowed, every connection is
 * checked against the private/local blocklist at connect time (DNS-rebinding safe).
 */
export function connectorFetch(
  input: string | URL,
  init: RequestInit = {},
  options: ConnectorTargetValidationOptions = {}
): Promise<Response> {
  if (options.allowPrivateTargets) return fetch(input, init);
  // Sockets skip `lookup` for IP-literal hosts, so literals are checked here instead.
  const host = new URL(input).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateOrLocalAddress(host)) {
    return Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error(`Connector target is disallowed address ${host}`), { code: "ESSRFBLOCKED" }) }));
  }
  return undiciFetch(input, { ...(init as UndiciRequestInit), dispatcher: guardedAgent }) as unknown as Promise<Response>;
}

export function isPrivateOrLocalAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map((part) => Number.parseInt(part, 10));
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true; // IETF protocol assignments (192.0.0.0/24 incl.)
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateIpv6(address: string): boolean {
  // URL canonicalization handles expanded and dotted IPv4-mapped IPv6 forms.
  const lower = new URL(`http://[${address.split("%")[0]}]/`).hostname.slice(1, -1).toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) embed an IPv4 address in
  // the low 32 bits; judge them by that address.
  const embedded = /^(?:::ffff|64:ff9b:):([0-9a-f]+):([0-9a-f]+)$/.exec(lower);
  if (embedded) {
    const high = Number.parseInt(embedded[1]!, 16);
    const low = Number.parseInt(embedded[2]!, 16);
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const firstHextet = Number.parseInt(lower.startsWith("::") ? "0" : lower.split(":")[0]!, 16);
  return (
    lower === "::1" ||
    lower === "::" ||
    /^::[0-9a-f]+:[0-9a-f]+$/.test(lower) || // deprecated IPv4-compatible ::a.b.c.d
    (firstHextet & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (firstHextet & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (firstHextet & 0xffc0) === 0xfec0 || // deprecated site-local fec0::/10
    (firstHextet & 0xff00) === 0xff00 || // multicast
    firstHextet === 0x2002 // 6to4 can tunnel to an arbitrary embedded IPv4 address
  );
}
