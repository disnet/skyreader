// robots.txt for the feed crawl (RFC 9309, plus the de-facto Crawl-delay).
//
// Scope: ONLY the crawl path — the warm loop and the demand-driven feed
// refreshes it shares (fetchParseAndCache in app.ts). Those are Skyreader
// acting on its own schedule, which is what robots.txt governs. The
// user-initiated paths are exempt on purpose: /extract fetches one page because
// a reader clicked Save, /discover fetches one homepage because a reader typed
// a site into Subscribe. Both are a person's request carried out once, not a
// crawl, and treating them as one would only push readers toward pasting page
// text in by hand.
//
// Why at all: honest self-identification is half of what makes a bot
// "verified" to a CDN (see web-bot-auth.ts); obeying robots.txt and
// crawl-delay is the other half, and the stated grounds for losing that status.
//
// Deviations from RFC 9309, chosen for a feed reader:
//   - An UNAVAILABLE robots.txt (5xx, timeout, DNS failure) is treated as
//     "no restrictions" and re-checked after a short TTL. The RFC allows
//     assuming complete disallow; for a reader that would mean every feed on a
//     site with a flaky /robots.txt going dark, which nobody asked for.
//   - Crawl-delay is honoured per host up to MAX_CRAWL_DELAY_MS, and a fetch
//     whose turn is further off than the caller's patience is deferred to the
//     next crawl cycle rather than slept on (see reserveSlot).
import { safeFetch } from './ssrf-guard';

export interface RobotsRule {
  allow: boolean;
  /** Path pattern as written: literal prefix, `*` wildcard, optional `$` anchor. */
  pattern: string;
}

export interface RobotsGroup {
  /** Lower-cased product tokens the group applies to (`*` for the default group). */
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds?: number;
}

export interface RobotsVerdict {
  allowed: boolean;
  /** 0 when the site sets no Crawl-delay for us. Already capped. */
  crawlDelayMs: number;
  /** The rule that decided a disallow, for the error message. */
  matchedPattern?: string;
}

/** Our product token: the first word of the honest User-Agent, per RFC 9309 §2.2.1. */
export const ROBOTS_PRODUCT_TOKEN = 'skyreader';

// RFC 9309 §2.4: crawlers MUST parse at least 500 KiB; we stop there.
const MAX_ROBOTS_BYTES = 512 * 1024;
const ROBOTS_FETCH_TIMEOUT_MS = 10 * 1000;
// RFC 9309 §2.4: cached robots.txt SHOULD NOT be used past 24 hours.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
// A 5xx / network failure is re-probed sooner than a real answer.
const DEFAULT_UNAVAILABLE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;
// Longest Crawl-delay we honour literally. Google ignores the directive
// entirely; Bing caps at ~10 minutes. A minute is enough to be a good citizen
// on a site that asked for spacing without letting one host monopolise a warm
// slot, and anything above it is almost always a typo or a "go away" — which
// robots.txt already has a proper spelling for (Disallow).
export const MAX_CRAWL_DELAY_MS = 60 * 1000;

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

/** Normalize a user-agent line value to a comparable product token. */
function normalizeAgent(value: string): string {
  // "Skyreader/1.0" is not standard but unambiguous in intent.
  return value.trim().toLowerCase().split('/')[0].trim();
}

export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // Consecutive user-agent lines share one group (RFC 9309 §2.2.1). Once a
  // rule line follows, the next user-agent line opens a NEW group.
  let openForAgents = false;

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    switch (field) {
      case 'user-agent': {
        const agent = normalizeAgent(value);
        if (!agent) continue;
        if (!current || !openForAgents) {
          current = { agents: [], rules: [] };
          groups.push(current);
          openForAgents = true;
        }
        current.agents.push(agent);
        break;
      }
      case 'allow':
      case 'disallow': {
        if (!current) continue; // rule before any user-agent: no group, ignored
        openForAgents = false;
        // "Disallow:" (empty) means "nothing is disallowed" — no rule at all.
        if (!value) continue;
        // A pattern must start with "/" (or "*" per common practice). Anything
        // else is malformed; the RFC says to ignore it.
        if (!value.startsWith('/') && !value.startsWith('*')) continue;
        current.rules.push({ allow: field === 'allow', pattern: value });
        break;
      }
      case 'crawl-delay': {
        if (!current) continue;
        openForAgents = false;
        const seconds = Number.parseFloat(value);
        if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
        break;
      }
      default:
        // sitemap, host, unknown: not ours; a rule-like unknown line still
        // closes the agent block per the grammar (it's a non-user-agent line).
        if (current) openForAgents = false;
    }
  }
  return groups;
}

/**
 * The rules that apply to `productToken`: every group naming it, merged (RFC
 * 9309 §2.2.1); else every `*` group, merged; else null (no restrictions).
 */
export function selectGroup(
  groups: RobotsGroup[],
  productToken = ROBOTS_PRODUCT_TOKEN
): RobotsGroup | null {
  const token = productToken.toLowerCase();
  const merge = (matching: RobotsGroup[]): RobotsGroup | null => {
    if (matching.length === 0) return null;
    const merged: RobotsGroup = { agents: [token], rules: [] };
    for (const g of matching) {
      merged.rules.push(...g.rules);
      if (g.crawlDelaySeconds !== undefined) merged.crawlDelaySeconds = g.crawlDelaySeconds;
    }
    return merged;
  };
  const specific = groups.filter((g) => g.agents.includes(token));
  if (specific.length > 0) return merge(specific);
  return merge(groups.filter((g) => g.agents.includes('*')));
}

/**
 * RFC 9309 §2.2.2 pattern match: literal prefix, `*` matches any run of
 * characters, a trailing `$` anchors to the end of the path.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  let anchored = false;
  let p = pattern;
  if (p.endsWith('$')) {
    anchored = true;
    p = p.slice(0, -1);
  }
  const parts = p.split('*');
  // Fast path: no wildcard.
  if (parts.length === 1) {
    return anchored ? path === p : path.startsWith(p);
  }
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0) {
      if (!path.startsWith(part)) return false;
      pos = part.length;
      continue;
    }
    if (i === parts.length - 1) {
      if (anchored)
        return part === '' ? true : path.endsWith(part) && path.length - part.length >= pos;
      if (part === '') return true;
      return path.indexOf(part, pos) !== -1;
    }
    const idx = path.indexOf(part, pos);
    if (idx === -1) return false;
    pos = idx + part.length;
  }
  return true;
}

/**
 * Evaluate a path against a group. Longest matching pattern wins (RFC 9309
 * §2.2.2); on a tie the allow rule wins. No group / no matching rule = allowed.
 */
export function evaluatePath(
  group: RobotsGroup | null,
  path: string
): { allowed: boolean; matchedPattern?: string } {
  if (!group) return { allowed: true };
  let best: RobotsRule | null = null;
  for (const rule of group.rules) {
    if (!matchesPattern(rule.pattern, path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  if (!best) return { allowed: true };
  return best.allow ? { allowed: true } : { allowed: false, matchedPattern: best.pattern };
}

/** The part of a URL robots.txt rules are matched against. */
export function robotsPathOf(url: URL): string {
  return `${url.pathname}${url.search}`;
}

interface CacheEntry {
  group: RobotsGroup | null;
  expiresAt: number;
}

export type RobotsFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RobotsPolicyOptions {
  /** User-Agent sent when fetching robots.txt itself (the honest identity). */
  userAgent: string;
  productToken?: string;
  fetch?: RobotsFetch;
  ttlMs?: number;
  unavailableTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class RobotsPolicy {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();
  // Per-host earliest time the next crawl-delayed fetch may start.
  private readonly nextSlotAt = new Map<string, number>();
  private readonly userAgent: string;
  private readonly productToken: string;
  private readonly fetchImpl: RobotsFetch;
  private readonly ttlMs: number;
  private readonly unavailableTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: RobotsPolicyOptions) {
    this.userAgent = opts.userAgent;
    this.productToken = opts.productToken ?? ROBOTS_PRODUCT_TOKEN;
    this.fetchImpl = opts.fetch ?? ((url, init) => safeFetch(url, init));
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.unavailableTtlMs = opts.unavailableTtlMs ?? DEFAULT_UNAVAILABLE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = opts.now ?? (() => Date.now());
  }

  /** For /stats. */
  get cachedOrigins(): number {
    return this.cache.size;
  }

  /**
   * May the crawler fetch `url` on its own schedule? Never throws: an
   * unparseable URL is "allowed" (the fetch itself will fail with a clearer
   * error) and an unreachable robots.txt is "allowed" (see file comment).
   */
  async check(url: string): Promise<RobotsVerdict> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: true, crawlDelayMs: 0 };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: true, crawlDelayMs: 0 };
    }
    const entry = await this.entryFor(parsed.origin);
    const verdict = evaluatePath(entry.group, robotsPathOf(parsed));
    const delaySeconds = entry.group?.crawlDelaySeconds ?? 0;
    const crawlDelayMs = Math.min(Math.max(0, delaySeconds) * 1000, MAX_CRAWL_DELAY_MS);
    return { ...verdict, crawlDelayMs };
  }

  /**
   * Claim the next crawl-delay slot for `host`. Returns how long the caller
   * must wait before fetching, or null if that wait would exceed `maxWaitMs`
   * — in which case nothing is reserved and the caller should defer the fetch
   * (the next crawl cycle will try again) instead of parking a worker on it.
   */
  reserveSlot(host: string, crawlDelayMs: number, maxWaitMs: number): number | null {
    if (crawlDelayMs <= 0) return 0;
    const now = this.now();
    const start = Math.max(now, this.nextSlotAt.get(host) ?? 0);
    const wait = start - now;
    if (wait > maxWaitMs) return null;
    this.nextSlotAt.set(host, start + crawlDelayMs);
    // Bound the map: drop slots already in the past (they're no-ops anyway).
    if (this.nextSlotAt.size > this.maxEntries) {
      for (const [h, at] of this.nextSlotAt) {
        if (at <= now) this.nextSlotAt.delete(h);
      }
    }
    return wait;
  }

  /** Drop everything (tests). */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.nextSlotAt.clear();
  }

  private async entryFor(origin: string): Promise<CacheEntry> {
    const now = this.now();
    const cached = this.cache.get(origin);
    if (cached && cached.expiresAt > now) return cached;

    let pending = this.inFlight.get(origin);
    if (!pending) {
      pending = this.load(origin)
        .then((entry) => {
          this.remember(origin, entry);
          return entry;
        })
        .finally(() => this.inFlight.delete(origin));
      this.inFlight.set(origin, pending);
    }
    return pending;
  }

  private remember(origin: string, entry: CacheEntry): void {
    this.cache.delete(origin);
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(origin, entry);
  }

  private async load(origin: string): Promise<CacheEntry> {
    const now = this.now();
    const unrestricted = (ttl: number): CacheEntry => ({ group: null, expiresAt: now + ttl });
    let response: Response;
    try {
      response = await this.fetchImpl(`${origin}/robots.txt`, {
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'text/plain, */*;q=0.1',
        },
        signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
      });
    } catch {
      // DNS/TLS/timeout/SSRF-guard: unavailable → unrestricted, re-probe soon.
      return unrestricted(this.unavailableTtlMs);
    }

    if (response.status >= 400 && response.status < 500) {
      // RFC 9309 §2.3.1.3: 4xx (incl. 401/403) means "no robots.txt": unrestricted.
      await response.body?.cancel().catch(() => {});
      return unrestricted(this.ttlMs);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return unrestricted(this.unavailableTtlMs);
    }

    let text: string;
    try {
      text = await readBounded(response, MAX_ROBOTS_BYTES);
    } catch {
      return unrestricted(this.unavailableTtlMs);
    }
    return {
      group: selectGroup(parseRobotsTxt(text), this.productToken),
      expiresAt: now + this.ttlMs,
    };
  }
}

// Read up to `maxBytes` of the body as UTF-8 and stop — a robots.txt past the
// RFC's 500 KiB is truncated, not rejected.
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const room = joined.length - offset;
    if (room <= 0) break;
    joined.set(chunk.byteLength > room ? chunk.subarray(0, room) : chunk, offset);
    offset += Math.min(chunk.byteLength, room);
  }
  return new TextDecoder().decode(joined);
}
