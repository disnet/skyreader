import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import {
  MATCH_CHUNK,
  buildMarginNoteRecord,
  mergeMarginNoteUpdate,
  parseMarginHighlightNote,
  readProvesAbsence,
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

  // url_normalized is only written on the backed-save path, so an un-keyed row is
  // the normal state for a default-backing account — not a legacy tail.
  it('matches un-keyed saves whose raw URL carries tracking params and a fragment', async () => {
    await seedSave({
      rkey: 'save2',
      url: 'https://example.com/legacy?utm_source=newsletter#section',
      urlNormalized: null,
    });
    mockRecords([highlightNote('one', 'https://example.com/legacy#quote')]);

    const res = await call();
    expect(res.body.notes[0].match?.uri).toBe(`at://${DID}/app.skyreader.feed.saved/save2`);
  });

  it('narrows the un-keyed read by host without dropping same-host matches', async () => {
    // Same path on another host: reachable only if the host filter is per-host,
    // and proof the filter doesn't leak a match across hosts.
    await seedSave({ rkey: 'other', url: 'https://elsewhere.test/legacy', urlNormalized: null });
    await seedSave({
      rkey: 'same',
      url: 'https://example.com/legacy?ref=twitter',
      urlNormalized: null,
    });
    mockRecords([
      highlightNote('one', 'https://example.com/legacy'),
      highlightNote('two', 'https://nowhere.test/legacy'),
    ]);

    const res = await call();
    expect(res.body.notes[0].match?.uri).toBe(`at://${DID}/app.skyreader.feed.saved/same`);
    expect(res.body.notes[1].match).toBeNull();
  });

  it('resolves duplicate un-keyed saves of one article to the oldest row, every time', async () => {
    // Two saves of the same article with different tracking params normalize to
    // one key; ORDER BY id keeps the winner stable across polls.
    await seedSave({
      rkey: 'first',
      url: 'https://example.com/dupe?utm_source=a',
      urlNormalized: null,
    });
    await seedSave({
      rkey: 'second',
      url: 'https://example.com/dupe?fbclid=b',
      urlNormalized: null,
    });
    mockRecords([highlightNote('one', 'https://example.com/dupe')]);

    for (let i = 0; i < 3; i++) {
      const res = await call();
      expect(res.body.notes[0].match?.uri).toBe(`at://${DID}/app.skyreader.feed.saved/first`);
    }
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

  it('skips the un-keyed read when the indexed pass answered every URL', async () => {
    // A Semble/Margin-backed account has a normalized key on every save, so the
    // fallback would be one statement per 40 hosts, every poll, over rows that
    // by definition hold none of them.
    const url = 'https://example.com/keyed';
    await seedSave({ rkey: 'k', url, urlNormalized: url, itemGuid: 'guid-k' });
    mockRecords([highlightNote('one', url)]);

    const prepare = vi.spyOn(env.DB, 'prepare');
    const res = await call();

    expect(res.body.notes[0].match?.itemGuid).toBe('guid-k');
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes('url_normalized IS NULL'))).toBe(
      false
    );
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

// A note edit reuses the rkey and putRecord replaces the whole record. Now that
// a reader can annotate a highlight Margin itself made, rebuilding that record
// from the fields Skyreader models would quietly take it over.
describe('readProvesAbsence', () => {
  // mergeMarginNoteUpdate rebuilds when there is nothing to merge onto, and
  // putRecord replaces — so calling a failed read "absent" would let a transient
  // PDS error stamp Skyreader's shape over a note Margin wrote.
  it('accepts a successful read and a definitive miss', () => {
    expect(readProvesAbsence({ success: true })).toBe(true);
    expect(readProvesAbsence({ success: false, retryable: false })).toBe(true);
  });

  it('refuses a read that failed for a reason that might not fail again', () => {
    expect(readProvesAbsence({ success: false, retryable: true })).toBe(false);
  });
});

describe('mergeMarginNoteUpdate', () => {
  function marginNative(overrides: Record<string, unknown> = {}) {
    return {
      $type: 'at.margin.note',
      motivation: 'highlighting',
      target: {
        // Margin's own record, with the query string it chose to keep.
        source: 'https://example.com/post?ref=margin',
        selector: { type: 'TextQuoteSelector', exact: 'A passage' },
      },
      generator: { name: 'Margin', homepage: 'https://margin.at' },
      createdAt: '2026-01-01T00:00:00.000Z',
      marginOnlyField: 'keep me',
      ...overrides,
    };
  }

  const edit = {
    source: 'https://example.com/post?ref=margin&utm_source=x',
    exact: 'A passage',
    note: 'my thought',
  };

  it('changes only the note body of a record Margin wrote', () => {
    const merged = mergeMarginNoteUpdate(marginNative(), edit, '2026-08-25T00:00:00.000Z');

    expect(merged.body).toEqual({ value: 'my thought', format: 'text/plain' });
    // Everything that isn't the note survives: the generator stays Margin's,
    // the source keeps the form Margin stored it in, unmodelled fields persist,
    // and the original creation time is untouched.
    expect(merged.generator).toEqual({ name: 'Margin', homepage: 'https://margin.at' });
    expect(merged.target).toEqual({
      source: 'https://example.com/post?ref=margin',
      selector: { type: 'TextQuoteSelector', exact: 'A passage' },
    });
    expect(merged.marginOnlyField).toBe('keep me');
    expect(merged.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('keeps the body format the record already declared', () => {
    const merged = mergeMarginNoteUpdate(
      marginNative({ body: { value: 'old', format: 'text/markdown' } }),
      edit,
      '2026-08-25T00:00:00.000Z'
    );
    expect(merged.body).toEqual({ value: 'my thought', format: 'text/markdown' });
  });

  it('drops the body when the note is cleared, and nothing else', () => {
    const merged = mergeMarginNoteUpdate(
      marginNative({ body: { value: 'old', format: 'text/plain' } }),
      { source: edit.source, exact: edit.exact },
      '2026-08-25T00:00:00.000Z'
    );
    expect(merged).not.toHaveProperty('body');
    expect(merged.marginOnlyField).toBe('keep me');
  });

  it('falls back to building the record when there is nothing to merge onto', () => {
    // putRecord is creating it here, so Skyreader's own shape is the right one.
    const merged = mergeMarginNoteUpdate(null, edit, '2026-08-25T00:00:00.000Z');
    expect(merged.generator).toEqual({ name: 'Skyreader', homepage: 'https://skyreader.app' });
    expect(merged.createdAt).toBe('2026-08-25T00:00:00.000Z');
  });

  it('rebuilds rather than merging onto a record of some other type', () => {
    const merged = mergeMarginNoteUpdate(
      { $type: 'at.margin.bookmark', createdAt: '2020-01-01T00:00:00.000Z' },
      edit,
      '2026-08-25T00:00:00.000Z'
    );
    expect(merged.$type).toBe('at.margin.note');
  });
});
