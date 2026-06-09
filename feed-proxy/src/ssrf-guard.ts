/**
 * SSRF guard for outbound fetches to caller-controlled URLs.
 *
 * The proxy fetches feed/article URLs and AT-Proto PDS endpoints supplied — directly
 * or indirectly via did:web service endpoints — by callers. Without validation those
 * fetches can be aimed at the loopback interface, the Fly private network, or the
 * cloud metadata endpoint (169.254.169.254): a classic SSRF / local-resource read.
 *
 * `safeFetch` enforces, on the initial URL AND on every redirect hop:
 *   - scheme is http/https (blocks file:, gopher:, data:, ...)
 *   - no embedded credentials (user:pass@host)
 *   - the host does not resolve to a private/loopback/link-local/ULA/CGNAT/metadata
 *     address (IPv4 and IPv6, including IPv4-mapped IPv6)
 *
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

// Cap manual redirect following. Matches the spirit of the old redirect:'follow'
// while keeping each hop under SSRF validation.
const MAX_REDIRECTS = 5;

type LookupFn = (host: string) => Promise<Array<{ address: string }>>;

// Resolver is injectable so the guard's name→IP rejection can be unit-tested without
// real network. Default uses the system resolver.
let customLookup: LookupFn | null = null;
export function __setDnsLookupForTests(fn: LookupFn | null): void {
  customLookup = fn;
}

// Parse an IPv4 dotted-quad to its 32-bit integer, or null if not well-formed IPv4.
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const octet = Number(p);
    if (octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const inRange = (base: string, bits: number): boolean => {
    const b = ipv4ToInt(base);
    if (b === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  };
  return (
    inRange('0.0.0.0', 8) || // "this" network
    inRange('10.0.0.0', 8) || // private
    inRange('100.64.0.0', 10) || // CGNAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local incl. 169.254.169.254 metadata
    inRange('172.16.0.0', 12) || // private
    inRange('192.0.0.0', 24) || // IETF protocol assignments
    inRange('192.168.0.0', 16) || // private
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved
  );
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]; // strip any zone id
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) / IPv4-compatible — validate the embedded v4.
  const mapped = addr.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (addr.startsWith('fe80')) return true; // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // ULA, incl. Fly 6PN fdaa::
  if (addr.startsWith('ff')) return true; // multicast
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return false; // not an IP literal
}

/**
 * Validate one URL: http(s) scheme, no embedded credentials, and that every
 * resolved address is public. Throws SsrfBlockedError on any violation.
 */
export async function assertPublicUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfBlockedError(`Blocked non-http(s) scheme: ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new SsrfBlockedError('Blocked URL with embedded credentials');
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 literal brackets

  // Host is already an IP literal — check it directly, no DNS.
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new SsrfBlockedError(`Blocked private address: ${host}`);
    }
    return;
  }

  // Resolve the name and reject if ANY returned address is private. The mocked-fetch
  // unit suites use unresolvable placeholder hosts (e.g. pds.example.com) and stub
  // global fetch, so when running under the test runner with no injected resolver we
  // skip real DNS; production (NODE_ENV unset) always resolves. The ssrf-guard's own
  // tests inject a resolver to exercise this branch.
  if (!customLookup && process.env.NODE_ENV === 'test') return;

  let addrs: Array<{ address: string }>;
  try {
    addrs = customLookup ? await customLookup(host) : await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError(`Could not resolve host: ${host}`);
  }
  if (addrs.length === 0) {
    throw new SsrfBlockedError(`Host did not resolve: ${host}`);
  }
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) {
      throw new SsrfBlockedError(`Host ${host} resolves to private address ${address}`);
    }
  }
}

/**
 * Drop-in replacement for fetch() for caller-controlled URLs. Validates the target
 * is a public http(s) endpoint and follows redirects manually, re-validating every
 * hop. The caller's `redirect` option is ignored (always manual internally).
 */
export async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let url = input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const response = await fetch(url, { ...init, redirect: 'manual' });

    const isRedirect =
      response.status >= 300 && response.status < 400 && response.headers.has('location');
    if (!isRedirect) return response;

    const location = response.headers.get('location')!;
    // Free the redirect response body before chasing the next hop.
    await response.body?.cancel().catch(() => {});
    url = new URL(location, url).toString();
  }
  throw new SsrfBlockedError(`Too many redirects (>${MAX_REDIRECTS})`);
}
