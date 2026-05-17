import dns from "dns/promises";
import net from "net";

/**
 * True if `ip` (a v4 or v6 literal) is loopback / private / link-local /
 * unique-local / unspecified — i.e. an address an outbound request must not
 * be allowed to reach.
 */
export function isPrivateAddress(ip: string): boolean {
  // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];

  if (net.isIPv4(ip)) {
    const o = ip.split(".").map(Number);
    if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = o;
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 127) return true;                        // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::") return true;        // loopback / unspecified
    if (x.startsWith("fe80")) return true;             // fe80::/10 link-local
    if (x.startsWith("fc") || x.startsWith("fd")) return true; // fc00::/7 ULA
    return false;
  }
  return true; // not a recognizable IP literal → treat as unsafe
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

/**
 * Throws unless `rawUrl` is a public http(s) URL. Defends the webhook reply
 * path against SSRF: an inbound caller (signature-verified, but not
 * necessarily benign) must not be able to make the server hit internal
 * hosts. DNS names are resolved and rejected if ANY resolved address is
 * private, which also defeats DNS-rebinding to internal ranges.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`scheme not allowed: ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const lower = host.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower) || lower.endsWith(".local")) {
    throw new Error(`host not allowed: ${host}`);
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`private address: ${host}`);
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`host does not resolve: ${host}`);
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`resolves to a private address: ${host}`);
  }
}
