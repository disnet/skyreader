import { describe, expect, it } from 'bun:test';
import {
  parseRobotsTxt,
  selectGroup,
  matchesPattern,
  evaluatePath,
  RobotsPolicy,
  MAX_CRAWL_DELAY_MS,
} from './robots';

const UA = 'Skyreader/1.0 (+https://skyreader.app)';

describe('parseRobotsTxt', () => {
  it('groups consecutive user-agent lines and attaches rules', () => {
    const groups = parseRobotsTxt(`
      # comment
      User-agent: Googlebot
      User-agent: Bingbot
      Disallow: /private
      Allow: /private/ok

      User-agent: *
      Disallow: /tmp/ # trailing comment
      Crawl-delay: 5
    `);
    expect(groups).toHaveLength(2);
    expect(groups[0].agents).toEqual(['googlebot', 'bingbot']);
    expect(groups[0].rules).toEqual([
      { allow: false, pattern: '/private' },
      { allow: true, pattern: '/private/ok' },
    ]);
    expect(groups[1].agents).toEqual(['*']);
    expect(groups[1].rules).toEqual([{ allow: false, pattern: '/tmp/' }]);
    expect(groups[1].crawlDelaySeconds).toBe(5);
  });

  it('starts a new group when a user-agent line follows a rule', () => {
    const groups = parseRobotsTxt(`
      User-agent: a
      Disallow: /a
      User-agent: b
      Disallow: /b
    `);
    expect(groups.map((g) => g.agents)).toEqual([['a'], ['b']]);
  });

  it('ignores an empty Disallow, malformed patterns, and rules before any user-agent', () => {
    const groups = parseRobotsTxt(`
      Disallow: /orphan
      User-agent: *
      Disallow:
      Disallow: nope
      Allow: /fine
    `);
    expect(groups).toHaveLength(1);
    expect(groups[0].rules).toEqual([{ allow: true, pattern: '/fine' }]);
  });

  it('is case-insensitive on field names and strips a /version from agents', () => {
    const groups = parseRobotsTxt(`USER-AGENT: Skyreader/1.0\nDISALLOW: /x`);
    expect(groups[0].agents).toEqual(['skyreader']);
    expect(groups[0].rules).toEqual([{ allow: false, pattern: '/x' }]);
  });
});

describe('selectGroup', () => {
  const groups = parseRobotsTxt(`
    User-agent: *
    Disallow: /all

    User-agent: Skyreader
    Disallow: /sky

    User-agent: skyreader
    Allow: /sky/ok
    Crawl-delay: 2
  `);

  it('prefers and merges the groups naming our token', () => {
    const g = selectGroup(groups, 'skyreader');
    expect(g?.rules).toEqual([
      { allow: false, pattern: '/sky' },
      { allow: true, pattern: '/sky/ok' },
    ]);
    expect(g?.crawlDelaySeconds).toBe(2);
  });

  it('falls back to the * group', () => {
    expect(selectGroup(groups, 'otherbot')?.rules).toEqual([{ allow: false, pattern: '/all' }]);
  });

  it('returns null when nothing applies', () => {
    expect(selectGroup(parseRobotsTxt('User-agent: x\nDisallow: /'), 'skyreader')).toBeNull();
  });
});

describe('matchesPattern', () => {
  it('matches literal prefixes', () => {
    expect(matchesPattern('/feed', '/feed.xml')).toBe(true);
    expect(matchesPattern('/feed', '/rss')).toBe(false);
  });
  it('honours the $ anchor', () => {
    expect(matchesPattern('/feed$', '/feed')).toBe(true);
    expect(matchesPattern('/feed$', '/feed.xml')).toBe(false);
  });
  it('expands * wildcards', () => {
    expect(matchesPattern('/*.xml', '/a/b/feed.xml')).toBe(true);
    expect(matchesPattern('/*.xml$', '/a/feed.xml?x=1')).toBe(false);
    expect(matchesPattern('/*/rss*', '/blog/rss.xml')).toBe(true);
    expect(matchesPattern('/a*b*c', '/aXXbYYc')).toBe(true);
    expect(matchesPattern('/a*b*c', '/aXXcYYb')).toBe(false);
    expect(matchesPattern('*', '/anything')).toBe(true);
  });
});

describe('evaluatePath', () => {
  it('lets the longest matching rule win, allow winning ties', () => {
    const g = selectGroup(
      parseRobotsTxt(`User-agent: *\nDisallow: /\nAllow: /feed\nDisallow: /feed/private`),
      'skyreader'
    );
    expect(evaluatePath(g, '/feed.xml')).toEqual({ allowed: true });
    expect(evaluatePath(g, '/feed/private/x')).toEqual({
      allowed: false,
      matchedPattern: '/feed/private',
    });
    expect(evaluatePath(g, '/about')).toEqual({ allowed: false, matchedPattern: '/' });
    const tie = selectGroup(parseRobotsTxt(`User-agent: *\nDisallow: /f\nAllow: /f`), 'skyreader');
    expect(evaluatePath(tie, '/feed')).toEqual({ allowed: true });
  });
  it('allows everything with no group or no matching rule', () => {
    expect(evaluatePath(null, '/x')).toEqual({ allowed: true });
    expect(evaluatePath({ agents: ['*'], rules: [{ allow: false, pattern: '/y' }] }, '/x')).toEqual(
      {
        allowed: true,
      }
    );
  });
});

describe('RobotsPolicy', () => {
  function policy(
    responder: (url: string) => Response | Promise<Response>,
    extra: Partial<ConstructorParameters<typeof RobotsPolicy>[0]> = {}
  ) {
    const calls: string[] = [];
    const p = new RobotsPolicy({
      userAgent: UA,
      fetch: async (url) => {
        calls.push(url);
        return responder(url);
      },
      ...extra,
    });
    return { p, calls };
  }

  it('fetches /robots.txt for the origin once and applies its rules to paths', async () => {
    const { p, calls } = policy(() => new Response('User-agent: *\nDisallow: /private/'));
    expect(await p.check('https://example.com/feed.xml')).toEqual({
      allowed: true,
      crawlDelayMs: 0,
    });
    expect(await p.check('https://example.com/private/feed.xml')).toEqual({
      allowed: false,
      crawlDelayMs: 0,
      matchedPattern: '/private/',
    });
    expect(calls).toEqual(['https://example.com/robots.txt']);
  });

  it('sends the honest identity when fetching robots.txt', async () => {
    let ua = '';
    const p = new RobotsPolicy({
      userAgent: UA,
      fetch: async (_url, init) => {
        ua = (init.headers as Record<string, string>)['User-Agent'];
        return new Response('');
      },
    });
    await p.check('https://example.com/feed');
    expect(ua).toBe(UA);
  });

  it('treats a 404 (and any 4xx) as unrestricted', async () => {
    const { p } = policy(() => new Response('nope', { status: 404 }));
    expect((await p.check('https://example.com/anything')).allowed).toBe(true);
    const { p: p403 } = policy(() => new Response('', { status: 403 }));
    expect((await p403.check('https://example.com/anything')).allowed).toBe(true);
  });

  it('treats 5xx and network errors as unrestricted, re-probing after the short TTL', async () => {
    let now = 1_000_000;
    let status = 503;
    const { p, calls } = policy(() => new Response('', { status }), {
      now: () => now,
      unavailableTtlMs: 1000,
      ttlMs: 10_000,
    });
    expect((await p.check('https://example.com/f')).allowed).toBe(true);
    now += 500;
    await p.check('https://example.com/f');
    expect(calls).toHaveLength(1); // still cached
    now += 600;
    status = 200;
    await p.check('https://example.com/f');
    expect(calls).toHaveLength(2); // re-probed after unavailableTtl

    const { p: pErr } = policy(() => {
      throw new Error('ECONNRESET');
    });
    expect((await pErr.check('https://example.com/f')).allowed).toBe(true);
  });

  it('coalesces concurrent lookups for the same origin', async () => {
    const { p, calls } = policy(
      (url) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(
                  url.startsWith('https://example.com/') ? 'User-agent: *\nDisallow: /x' : ''
                )
              ),
            5
          )
        )
    );
    const results = await Promise.all([
      p.check('https://example.com/x'),
      p.check('https://example.com/y'),
      p.check('https://other.example/x'),
    ]);
    expect(results.map((r) => r.allowed)).toEqual([false, true, true]);
    expect(calls).toEqual(['https://example.com/robots.txt', 'https://other.example/robots.txt']);
  });

  it('reports a capped crawl delay and reserves per-host slots', async () => {
    let now = 0;
    const { p } = policy(
      () =>
        new Response('User-agent: skyreader\nCrawl-delay: 10\nUser-agent: *\nCrawl-delay: 9999'),
      {
        now: () => now,
      }
    );
    const v = await p.check('https://example.com/feed');
    expect(v.crawlDelayMs).toBe(10_000);
    // Two fetches back to back: the first goes now, the second waits 10s.
    expect(p.reserveSlot('example.com', v.crawlDelayMs, 30_000)).toBe(0);
    expect(p.reserveSlot('example.com', v.crawlDelayMs, 30_000)).toBe(10_000);
    // A third would wait 20s — over the caller's patience → deferred, nothing reserved.
    expect(p.reserveSlot('example.com', v.crawlDelayMs, 15_000)).toBeNull();
    expect(p.reserveSlot('example.com', v.crawlDelayMs, 30_000)).toBe(20_000);
    // Other hosts are independent; no delay means no reservation.
    expect(p.reserveSlot('other.example', 0, 0)).toBe(0);
    // Time passes: the slot table drains.
    now = 60_000;
    expect(p.reserveSlot('example.com', v.crawlDelayMs, 0)).toBe(0);
  });

  it('caps a huge Crawl-delay', async () => {
    const { p } = policy(() => new Response('User-agent: *\nCrawl-delay: 3600'));
    expect((await p.check('https://example.com/feed')).crawlDelayMs).toBe(MAX_CRAWL_DELAY_MS);
  });

  it('allows non-http and unparseable URLs through untouched', async () => {
    const { p, calls } = policy(() => new Response(''));
    expect((await p.check('not a url')).allowed).toBe(true);
    expect((await p.check('ftp://example.com/x')).allowed).toBe(true);
    expect(calls).toEqual([]);
  });

  it('truncates an oversized robots.txt instead of failing', async () => {
    const big = 'User-agent: *\nDisallow: /blocked\n' + '#'.repeat(600 * 1024) + '\nDisallow: /';
    const { p } = policy(() => new Response(big));
    expect((await p.check('https://example.com/blocked/x')).allowed).toBe(false);
    // The trailing "Disallow: /" past 512 KiB was never read.
    expect((await p.check('https://example.com/feed')).allowed).toBe(true);
  });
});
