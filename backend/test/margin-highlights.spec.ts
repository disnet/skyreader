import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import {
  MATCH_CHUNK,
  buildMarginNoteRecord,
  parseMarginHighlightNote,
} from '../src/routes/integrations';
import * as read from '../src/services/backing/read';
import * as didResolver from '../src/utils/did-resolver';
import { GRANULAR_SCOPES, MARGIN_SCOPES } from '../src/config/scopes';

// GET /api/integrations/margin/highlights — the read direction of the Margin
// integration. at.margin.note is a third-party lexicon that has already changed
// shape once, so parseMarginHighlightNote pins the shape we consume today:
// drift shows up as a test failure rather than silently importing nothing.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:marginhighlights';
const SESSION = 'sess-margin-highlights';
const FULL_SCOPES = `${GRANULAR_SCOPES} ${MARGIN_SCOPES.join(' ')}`;

function noteRecord(rkey: string, value: Record<string, unknown>) {
  return { uri: `at://${DID}/at.margin.note/${rkey}`, cid: `cid-${rkey}`, value };
}

function highlightNote(
  rkey: string,
  source: string,
  overrides: Record<string, unknown> = {}
): { uri: string; cid: string; value: Record<string, unknown> } {
  return noteRecord(rkey, {
    $type: 'at.margin.note',
    motivation: 'highlighting',
    target: {
      source,
      title: 'A Title',
      selector: { type: 'TextQuoteSelector', exact: `quote ${rkey}`, prefix: 'be', suffix: 'af' },
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  });
}

async function reset(grantedScopes = FULL_SCOPES) {
  await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at)
     VALUES (?, 'mh.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'mh.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, grantedScopes)
    .run();
}

async function seedSave(opts: {
  rkey: string;
  url: string;
  urlNormalized: string | null;
  itemGuid?: string | null;
}) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_normalized, item_guid, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      DID,
      opts.rkey,
      `at://${DID}/app.skyreader.feed.saved/${opts.rkey}`,
      opts.url,
      opts.urlNormalized,
      opts.itemGuid ?? null,
      Date.now()
    )
    .run();
}

async function call(): Promise<{ status: number; body: any }> {
  const req = new IncomingRequest('http://localhost/api/integrations/margin/highlights', {
    headers: { Cookie: `session_id=${SESSION}`, Origin: env.FRONTEND_URL },
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function mockRecords(records: unknown[], truncated = false) {
  vi.spyOn(didResolver, 'resolvePdsUrl').mockResolvedValue('https://pds.test');
  vi.spyOn(read, 'listAllRecordsPublic').mockResolvedValue({
    records: records as never,
    truncated,
  });
}

describe('parseMarginHighlightNote — the at.margin.note shape we consume', () => {
  const uri = `at://${DID}/at.margin.note/abc`;

  it('maps a highlighting note to a highlight', () => {
    const parsed = parseMarginHighlightNote(
      uri,
      highlightNote('abc', 'https://example.com/a').value
    );
    expect(parsed).toMatchObject({
      rkey: 'abc',
      url: 'https://example.com/a',
      urlNormalized: 'https://example.com/a',
      title: 'A Title',
      selector: { type: 'TextQuoteSelector', exact: 'quote abc', prefix: 'be', suffix: 'af' },
      createdAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('reads the note body from the W3C comment shape, and from a bare string', () => {
    const structured = parseMarginHighlightNote(
      uri,
      highlightNote('abc', 'https://example.com/a', {
        body: { value: 'my note', format: 'text/plain' },
      }).value
    );
    expect(structured?.note).toBe('my note');

    const bare = parseMarginHighlightNote(
      uri,
      highlightNote('abc', 'https://example.com/a', { body: 'legacy note' }).value
    );
    expect(bare?.note).toBe('legacy note');
  });

  it('skips bookmarking notes — those are saves, not highlights', () => {
    expect(
      parseMarginHighlightNote(uri, {
        $type: 'at.margin.note',
        motivation: 'bookmarking',
        target: { source: 'https://example.com/a' },
      })
    ).toBeNull();
  });

  it('skips malformed records instead of throwing', () => {
    const bad: unknown[] = [
      null,
      'not an object',
      { motivation: 'highlighting' }, // no target
      { motivation: 'highlighting', target: { source: 'https://x.test' } }, // no selector
      {
        motivation: 'highlighting',
        target: { source: 'https://x.test', selector: { type: 'TextPositionSelector', start: 1 } },
      },
      {
        motivation: 'highlighting',
        target: { source: 'https://x.test', selector: { type: 'TextQuoteSelector', exact: '' } },
      },
      {
        motivation: 'highlighting',
        target: {
          source: 'at://did:plc:x/y/z', // not an http(s) URL
          selector: { type: 'TextQuoteSelector', exact: 'q' },
        },
      },
    ];
    for (const value of bad) expect(parseMarginHighlightNote(uri, value)).toBeNull();
  });
});

describe('GET /api/integrations/margin/highlights', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('403s without the margin scopes', async () => {
    await reset(GRANULAR_SCOPES);
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('scope_upgrade_required');
  });

  it('returns highlighting notes and drops everything else', async () => {
    mockRecords([
      highlightNote('one', 'https://example.com/a'),
      noteRecord('two', {
        motivation: 'bookmarking',
        target: { source: 'https://example.com/b' },
      }),
      noteRecord('three', { motivation: 'highlighting' }),
    ]);
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].rkey).toBe('one');
    expect(res.body.truncated).toBe(false);
  });

  it('joins a note onto the matching save by normalized URL', async () => {
    await seedSave({
      rkey: 'save1',
      url: 'https://example.com/post?utm_source=x',
      urlNormalized: 'https://example.com/post',
      itemGuid: 'guid-1',
    });
    mockRecords([highlightNote('one', 'https://example.com/post/#section')]);

    const res = await call();
    expect(res.body.notes[0].match).toEqual({
      itemGuid: 'guid-1',
      uri: `at://${DID}/app.skyreader.feed.saved/save1`,
    });
  });

  it('matches legacy saves that predate url_normalized', async () => {
    await seedSave({
      rkey: 'save2',
      url: 'https://example.com/legacy?utm_source=newsletter#section',
      urlNormalized: null,
    });
    mockRecords([highlightNote('one', 'https://example.com/legacy#quote')]);

    const res = await call();
    expect(res.body.notes[0].match?.uri).toBe(`at://${DID}/app.skyreader.feed.saved/save2`);
  });

  it('reports match: null when nothing is saved for that URL', async () => {
    mockRecords([highlightNote('one', 'https://example.com/unsaved')]);
    const res = await call();
    expect(res.body.notes[0].match).toBeNull();
  });

  it('matches across the chunk boundary (D1 caps bound params per statement)', async () => {
    const count = MATCH_CHUNK * 2 + 5;
    const notes = [];
    for (let i = 0; i < count; i++) {
      const url = `https://example.com/bulk/${i}`;
      notes.push(highlightNote(`rk${i}`, url));
      // Save only the last one, well past the first chunk.
      if (i === count - 1) {
        await seedSave({ rkey: `s${i}`, url, urlNormalized: url, itemGuid: `guid-${i}` });
      }
    }
    mockRecords(notes);

    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(count);
    expect(res.body.notes[count - 1].match?.itemGuid).toBe(`guid-${count - 1}`);
    expect(res.body.notes[0].match).toBeNull();
  });

  it('propagates truncated so the client can say the poll was partial', async () => {
    mockRecords([highlightNote('one', 'https://example.com/a')], true);
    const res = await call();
    expect(res.body.truncated).toBe(true);
  });

  it('502s when the PDS read fails, rather than reporting an empty set', async () => {
    vi.spyOn(didResolver, 'resolvePdsUrl').mockResolvedValue('https://pds.test');
    vi.spyOn(read, 'listAllRecordsPublic').mockRejectedValue(new Error('listRecords -> 503'));
    const res = await call();
    expect(res.status).toBe(502);
  });
});

describe('Margin highlight records', () => {
  it('writes a canonical source so later exact backlink lookups can find it', () => {
    const record = buildMarginNoteRecord(
      {
        source:
          'https://chinaunread.substack.com/p/a-post?r=clku7&utm_campaign=post-expanded-share&utm_medium=post%20viewer',
        exact: 'A passage',
      },
      '2026-08-25T00:00:00.000Z'
    );

    expect(record.target.source).toBe('https://chinaunread.substack.com/p/a-post');
  });
});
