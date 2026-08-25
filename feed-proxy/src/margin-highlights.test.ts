import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase } from './app';
import { getMarginHighlights, MentionLaneUnavailableError } from './margin-highlights';
import { resetConstellationBreaker } from './constellation-client';

const ARTICLE = 'https://example.com/article';
function db() {
  const value = new Database(':memory:');
  initDatabase(value);
  return value;
}
function seedDid(value: Database, did: string) {
  value.run('INSERT INTO did_cache (did,pds_url,handle,cached_at) VALUES (?,?,?,?)', [
    did,
    'https://pds.test',
    `${did.slice(8)}.test`,
    Date.now(),
  ]);
}
function mock(
  records: Array<{ did: string; rkey: string }>,
  values: Record<string, unknown>,
  reachable = true
) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    const url = new URL(String(input));
    if (!reachable && url.hostname.includes('constellation'))
      return new Response('no', { status: 503 });
    if (url.pathname === '/links/all')
      return Response.json({
        links: { 'at.margin.note': { '.target.source': { records: records.length } } },
      });
    if (url.pathname === '/links')
      return Response.json({
        linking_records: records.map((r) => ({ ...r, collection: 'at.margin.note' })),
      });
    if (url.pathname.includes('getRecord'))
      return Response.json({ value: values[url.searchParams.get('rkey')!] ?? {} });
    return new Response('{}', { status: 404 });
  }) as typeof fetch);
}

describe('getMarginHighlights', () => {
  afterEach(() => {
    (globalThis.fetch as ReturnType<typeof spyOn>).mockRestore?.();
    resetConstellationBreaker();
  });

  it('preserves selector context and note metadata without author dedup', async () => {
    const value = db();
    seedDid(value, 'did:plc:alice');
    mock(
      [
        { did: 'did:plc:alice', rkey: 'one' },
        { did: 'did:plc:alice', rkey: 'two' },
      ],
      {
        one: {
          target: { selector: { exact: 'first', prefix: 'before', suffix: 'after' } },
          body: { value: 'Thoughtful note', format: 'text/plain' },
          motivation: 'commenting',
          createdAt: '2026-01-02T00:00:00Z',
        },
        two: { target: { selector: { exact: 'second' } }, motivation: 'highlighting' },
      }
    );
    const result = await getMarginHighlights(value, ARTICLE);
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0].selector).toEqual({
      type: 'TextQuoteSelector',
      exact: 'first',
      prefix: 'before',
      suffix: 'after',
    });
    expect(result.notes[0].note).toBe('Thoughtful note');
  });

  it('probes the exact raw URL for notes written before source canonicalization', async () => {
    const value = db();
    const did = 'did:plc:alice';
    seedDid(value, did);
    const raw =
      'https://chinaunread.substack.com/p/a-post?r=clku7&utm_campaign=post-expanded-share&utm_medium=post%20viewer';
    const queried: string[] = [];
    spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === '/links/all') {
        const target = url.searchParams.get('target') ?? '';
        queried.push(target);
        return Response.json({
          links: target === raw ? { 'at.margin.note': { '.target.source': { records: 1 } } } : {},
        });
      }
      if (url.pathname === '/links')
        return Response.json({
          linking_records: [{ did, collection: 'at.margin.note', rkey: 'one' }],
        });
      if (url.pathname.includes('getRecord'))
        return Response.json({
          value: { target: { selector: { exact: 'legacy passage' } } },
        });
      return new Response('{}', { status: 404 });
    }) as typeof fetch);

    expect((await getMarginHighlights(value, raw)).notes[0]?.selector.exact).toBe('legacy passage');
    expect(queried).toContain('https://chinaunread.substack.com/p/a-post');
    expect(queried).toContain(raw);
  });

  it('recovers tracked legacy notes through Margin using the canonical URL', async () => {
    const value = db();
    const source =
      'https://chinaunread.substack.com/p/a-post?r=clku7&utm_campaign=post-expanded-share&utm_medium=post%20viewer';
    let searchQuery = '';
    spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      if (url.hostname === 'margin.at' && url.pathname === '/api/search') {
        searchQuery = url.searchParams.get('q') ?? '';
        return Response.json({
          items: [
            {
              motivation: 'highlighting',
              creator: { did: 'did:plc:alice', handle: 'alice.test' },
              body: { value: 'Underrated', format: 'text/plain' },
              target: { source, selector: { exact: 'the recovered passage' } },
              created: '2026-08-23T01:21:30.058Z',
            },
          ],
        });
      }
      throw new Error(`Constellation should not be needed: ${url}`);
    }) as typeof fetch);

    const result = await getMarginHighlights(
      value,
      'https://chinaunread.substack.com/p/a-post?r=clku7'
    );
    expect(searchQuery).toBe('https://chinaunread.substack.com/p/a-post');
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].note).toBe('Underrated');
    expect(result.notes[0].selector.exact).toBe('the recovered passage');
  });

  it('drops bookmarks and malformed notes without passage selectors', async () => {
    const value = db();
    seedDid(value, 'did:plc:alice');
    mock(
      [
        { did: 'did:plc:alice', rkey: 'bookmark' },
        { did: 'did:plc:alice', rkey: 'bad' },
      ],
      {
        bookmark: { motivation: 'bookmarking', target: {} },
        bad: { target: { selector: { exact: '   ' } } },
      }
    );
    expect((await getMarginHighlights(value, ARTICLE)).notes).toEqual([]);
  });

  it('caps the record fan-out and reports the cap', async () => {
    const value = db();
    const records = Array.from({ length: 51 }, (_, i) => ({
      did: `did:plc:user${i}`,
      rkey: `r${i}`,
    }));
    const values = Object.fromEntries(
      records.map((r) => [r.rkey, { target: { selector: { exact: r.rkey } } }])
    );
    for (const record of records) seedDid(value, record.did);
    mock(records, values);
    const result = await getMarginHighlights(value, ARTICLE);
    expect(result.notes).toHaveLength(50);
    expect(result.capped).toBe(true);
  });

  it('bounds profile PDS lookups for articles with many distinct authors', async () => {
    const value = db();
    const records = Array.from({ length: 20 }, (_, i) => ({
      did: `did:plc:user${i}`,
      rkey: `r${i}`,
    }));
    for (const record of records) seedDid(value, record.did);
    let activeProfiles = 0;
    let maxActiveProfiles = 0;
    spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === '/links/all')
        return Response.json({
          links: { 'at.margin.note': { '.target.source': { records: records.length } } },
        });
      if (url.pathname === '/links')
        return Response.json({
          linking_records: records.map((record) => ({
            ...record,
            collection: 'at.margin.note',
          })),
        });
      if (url.pathname.includes('getRecord')) {
        if (url.searchParams.get('rkey') === 'self') {
          activeProfiles++;
          maxActiveProfiles = Math.max(maxActiveProfiles, activeProfiles);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeProfiles--;
          return Response.json({ value: {} });
        }
        return Response.json({
          value: { target: { selector: { exact: url.searchParams.get('rkey') } } },
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch);

    expect((await getMarginHighlights(value, ARTICLE)).notes).toHaveLength(records.length);
    expect(maxActiveProfiles).toBeGreaterThan(1);
    expect(maxActiveProfiles).toBeLessThanOrEqual(6);
  });

  it('serves a fresh cache entry without network work', async () => {
    const value = db();
    value.run('INSERT INTO constellation_cache (cache_key,context_json,cached_at) VALUES (?,?,?)', [
      `margin-highlights:${ARTICLE}`,
      JSON.stringify({ notes: [], capped: true }),
      Date.now(),
    ]);
    const fetchSpy = spyOn(globalThis, 'fetch');
    expect(await getMarginHighlights(value, ARTICLE)).toEqual({ notes: [], capped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('distinguishes an unavailable index from an empty reachable result', async () => {
    const unavailable = db();
    mock([], {}, false);
    await expect(getMarginHighlights(unavailable, ARTICLE)).rejects.toBeInstanceOf(
      MentionLaneUnavailableError
    );
    (globalThis.fetch as ReturnType<typeof spyOn>).mockRestore();
    resetConstellationBreaker();
    const empty = db();
    mock([], {});
    expect(await getMarginHighlights(empty, ARTICLE)).toEqual({ notes: [], capped: false });
  });
});
