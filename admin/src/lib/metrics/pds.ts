// The PDS page: which PDS hosts readers are on, and what each has been seen
// doing where implementations differ (backend/src/services/pds-census.ts).

export interface PdsTraitsRow {
  host: string;
  first_seen_at: number;
  last_seen_at: number;
  writes_ok: number;
  writes_ok_rate_limit_headers: number;
  writes_refused: number;
  writes_refused_rate_limit_headers: number;
  writes_refused_retry_after: number;
  nonce_in_body: number;
  nonce_header_only: number;
  not_found_reference_message: number;
  not_found_other_message: number;
  server: string | null;
}

type Counts = Omit<PdsTraitsRow, 'host' | 'first_seen_at' | 'last_seen_at' | 'server'>;

export interface PdsHostSummary extends Counts {
  /** A host, or a group of them (Bluesky's PDSes are hundreds of hosts). */
  name: string;
  hosts: number;
  readers: number;
  last_seen_at: number | null;
  server: string | null;
}

const BLUESKY_HOSTS = /\.host\.bsky\.network$/;

/** The row a host is shown in: Bluesky's own PDSes are one row. */
export function pdsGroup(host: string): string {
  return BLUESKY_HOSTS.test(host) ? 'Bluesky (*.host.bsky.network)' : host;
}

/** A reader's pds_url as a host, or null when it isn't a URL. */
export function hostOf(pdsUrl: string): string | null {
  try {
    return new URL(pdsUrl).host || null;
  } catch {
    return null;
  }
}

const COUNT_KEYS: (keyof Counts)[] = [
  'writes_ok',
  'writes_ok_rate_limit_headers',
  'writes_refused',
  'writes_refused_rate_limit_headers',
  'writes_refused_retry_after',
  'nonce_in_body',
  'nonce_header_only',
  'not_found_reference_message',
  'not_found_other_message',
];

/** Readers per host and traits per host, merged into one row per group, most readers first. */
export function summarizePdsHosts(
  readers: Array<{ pds_url: string; readers: number }>,
  traits: PdsTraitsRow[]
): PdsHostSummary[] {
  const groups = new Map<string, PdsHostSummary & { hostSet: Set<string> }>();
  const groupFor = (host: string) => {
    const name = pdsGroup(host);
    let g = groups.get(name);
    if (!g) {
      g = {
        name,
        hosts: 0,
        hostSet: new Set(),
        readers: 0,
        last_seen_at: null,
        server: null,
        ...(Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Counts),
      };
      groups.set(name, g);
    }
    g.hostSet.add(host);
    return g;
  };
  for (const r of readers) {
    const host = hostOf(r.pds_url);
    if (host) groupFor(host).readers += r.readers;
  }
  for (const t of traits) {
    const g = groupFor(t.host);
    for (const k of COUNT_KEYS) g[k] += t[k];
    if (g.last_seen_at === null || t.last_seen_at > g.last_seen_at) {
      g.last_seen_at = t.last_seen_at;
      g.server = t.server ?? g.server;
    }
  }
  return [...groups.values()]
    .map(({ hostSet, ...g }) => ({ ...g, hosts: hostSet.size }))
    .sort((a, b) => b.readers - a.readers || b.writes_ok - a.writes_ok);
}

/** When the host sends RateLimit-* headers, in words. */
export function rateLimitHeaders(s: Counts): string {
  if (s.writes_ok === 0 && s.writes_refused === 0) return '—';
  const onOk = s.writes_ok === 0 ? null : s.writes_ok_rate_limit_headers / s.writes_ok;
  const on429 = s.writes_refused === 0 ? null : s.writes_refused_rate_limit_headers > 0;
  if (onOk !== null && onOk >= 0.9) return 'on every write';
  if (onOk !== null && onOk > 0) return `on ${Math.round(onOk * 100)}% of writes`;
  if (on429 === true) return 'only on a 429';
  if (on429 === false) return 'never';
  return 'not on a write (no 429 seen)';
}

/** How the host asks for a DPoP nonce, in words. */
export function nonceSignal(s: Counts): string {
  if (s.nonce_in_body && s.nonce_header_only) return 'mixed';
  if (s.nonce_header_only) return 'header only';
  if (s.nonce_in_body) return 'body + header';
  return '—';
}

/** How the host words RecordNotFound, in words. */
export function notFoundWording(s: Counts): string {
  if (s.not_found_reference_message && s.not_found_other_message) return 'mixed';
  if (s.not_found_other_message) return 'its own';
  if (s.not_found_reference_message) return 'reference';
  return '—';
}

/** Whether a group behaves differently from the reference PDS in any way seen. */
export function differsFromReference(s: Counts): boolean {
  return (
    (s.writes_ok > 0 && s.writes_ok_rate_limit_headers === 0) ||
    s.nonce_header_only > 0 ||
    s.not_found_other_message > 0
  );
}
