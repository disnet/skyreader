import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ensureLinkblogPublication,
  getLinkblogTarget,
  isWritablePublicationRkey,
  updatePublication,
  LEGACY_LINKBLOG_RKEY,
  publicationUriFor,
} from '../src/services/linkblog-sync';
import { generateTid } from '../src/utils/tid';
import type { Env, Session } from '../src/types';

// `site.standard.publication` declares `"key": "tid"`, and the PDS enforces it
// now. Our old fixed rkey `skyreader-links` is not a TID, so:
//   · a publication already there can never be rewritten — but it still renders,
//     and documents may still point at it (a document's `site` is a plain string)
//   · a new one has to be minted at a real TID, and remembered, because a fixed
//     constant was the only thing making the URI computable from a DID
const DID = 'did:plc:rkeytest';

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const SESSION: Session = {
  did: DID,
  handle: 'rkey.test',
  pdsUrl: 'https://test.pds.example',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  dpopPrivateKey: JSON.stringify(TEST_DPOP_KEY),
  expiresAt: Date.now() + 3_600_000,
} as Session;

type Listed = { uri: string; value: Record<string, unknown> };
type Call = { endpoint: string; rkey?: string; body?: Record<string, unknown> };

// A share document as it sits on the PDS before a move: our marker, and the
// legacy array `links` every record written before the lexicon change carries.
function shareRecord(rkey: string, site: string): Listed {
  return {
    uri: `at://${DID}/site.standard.document/${rkey}`,
    value: {
      $type: 'site.standard.document',
      site,
      title: 'A share',
      skyreaderLinkblog: 'https://skyreader.app/linkblog',
      links: [{ uri: 'https://example.com/an-article', rel: 'related' }],
    },
  };
}

// getRecord answers for the rkeys in `records`, listRecords returns `documents`
// in one page, and every write is captured so a test can assert on it.
//
// `opts.endless` makes listRecords always hand back a cursor, so the move walk
// runs out of pages instead of records. `opts.readError` makes every getRecord
// fail with something that is NOT "no such record".
function stubPds(
  records: Record<string, Record<string, unknown>>,
  documents: Listed[] = [],
  opts: { endless?: boolean; readError?: boolean } = {}
) {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const endpoint = url.pathname.split('/xrpc/')[1] ?? url.pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ endpoint, rkey: url.searchParams.get('rkey') ?? body?.rkey, body });
    if (endpoint === 'com.atproto.repo.getRecord') {
      if (opts.readError) {
        return new Response(JSON.stringify({ error: 'InternalServerError' }), { status: 500 });
      }
      const record = records[url.searchParams.get('rkey') ?? ''];
      if (!record) {
        return new Response(
          JSON.stringify({ error: 'RecordNotFound', message: 'Could not locate record' }),
          { status: 400 }
        );
      }
      return new Response(JSON.stringify({ uri: 'at://x', cid: 'bafy', value: record }), {
        status: 200,
      });
    }
    if (endpoint === 'com.atproto.repo.listRecords') {
      const page: Record<string, unknown> = { records: documents };
      if (opts.endless) page.cursor = 'more';
      return new Response(JSON.stringify(page), { status: 200 });
    }
    return new Response(JSON.stringify({ uri: 'at://x', cid: 'bafy', commit: {} }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return calls;
}

// The write batches sent to applyWrites, in order.
const applyWrites = (calls: Call[]) =>
  calls
    .filter((c) => c.endpoint === 'com.atproto.repo.applyWrites')
    .map((c) => (c.body?.writes ?? []) as Array<{ $type: string; rkey: string; value?: unknown }>);

const puts = (calls: Call[]) => calls.filter((c) => c.endpoint === 'com.atproto.repo.putRecord');

// A publication record shaped like one written before the change: it will always
// look like it needs the url/marker heal.
const STALE_PUBLICATION = {
  $type: 'site.standard.publication',
  name: 'My links',
  url: 'https://an-old-origin.example/blogs/did/',
};

async function storedRkey(): Promise<string | null> {
  const row = await env.DB.prepare('SELECT linkblog_rkey FROM user_settings WHERE user_did = ?')
    .bind(DID)
    .first<{ linkblog_rkey: string | null }>();
  return row?.linkblog_rkey ?? null;
}

describe('publication rkeys', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
    await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
    await env.DB.prepare(
      'INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())'
    )
      .bind(DID, 'rkey.test', 'https://test.pds.example')
      .run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a spec TID and rejects the legacy fixed rkey', () => {
    expect(isWritablePublicationRkey(LEGACY_LINKBLOG_RKEY)).toBe(false);
    expect(isWritablePublicationRkey(generateTid())).toBe(true);
    // 'l' is not in the TID alphabet's first position, and length is exact.
    expect(isWritablePublicationRkey('3skyreaderlnk1')).toBe(false);
  });

  // The heal is cosmetic. Attempting it on a legacy publication is a guaranteed
  // 400, which used to take the whole share down with it.
  it('skips the url/marker heal on a legacy publication instead of failing', async () => {
    const calls = stubPds({ [LEGACY_LINKBLOG_RKEY]: STALE_PUBLICATION });

    const result = await ensureLinkblogPublication(SESSION, env as unknown as Env);

    expect(result.success).toBe(true);
    expect(result.success && result.data.uri).toBe(publicationUriFor(DID, LEGACY_LINKBLOG_RKEY));
    expect(puts(calls)).toHaveLength(0);
  });

  it('mints a TID for a first publication and remembers it', async () => {
    const calls = stubPds({});

    const result = await ensureLinkblogPublication(SESSION, env as unknown as Env);

    expect(result.success).toBe(true);
    const written = puts(calls);
    expect(written).toHaveLength(1);
    const rkey = written[0].body?.rkey as string;
    expect(isWritablePublicationRkey(rkey)).toBe(true);
    expect(await storedRkey()).toBe(rkey);
    expect(result.success && result.data.uri).toBe(publicationUriFor(DID, rkey));
  });

  it('resolves the stored rkey as the default publication, and heals there', async () => {
    const rkey = generateTid();
    await env.DB.prepare(
      `INSERT INTO user_settings (user_did, linkblog_rkey, created_at, updated_at)
       VALUES (?, ?, unixepoch(), unixepoch())`
    )
      .bind(DID, rkey)
      .run();

    const target = await getLinkblogTarget(env as unknown as Env, DID);
    expect(target.defaultSiteUri).toBe(publicationUriFor(DID, rkey));
    expect(target.siteUri).toBe(target.defaultSiteUri);
    expect(target.external).toBe(false);

    const calls = stubPds({ [rkey]: STALE_PUBLICATION });
    const result = await ensureLinkblogPublication(SESSION, env as unknown as Env);
    expect(result.success).toBe(true);
    // Writable, so the heal it skips on a legacy publication does happen here.
    expect(puts(calls).map((c) => c.body?.rkey)).toEqual([rkey]);
  });

  // Renaming would mean rewriting a record the lexicon won't let us write, so
  // the rename becomes a move: same publication, minted at a TID, with every
  // document repointed at it.
  it('moves a legacy publication to a TID on rename, carrying its posts', async () => {
    const calls = stubPds({ [LEGACY_LINKBLOG_RKEY]: STALE_PUBLICATION }, [
      // Ours, at the legacy publication — both must move.
      shareRecord('3kaaa', publicationUriFor(DID, LEGACY_LINKBLOG_RKEY)),
      shareRecord('3kbbb', publicationUriFor(DID, LEGACY_LINKBLOG_RKEY)),
      // Someone else's essay in a publication of their own — never touched.
      {
        uri: `at://${DID}/site.standard.document/3kccc`,
        value: {
          $type: 'site.standard.document',
          site: `at://${DID}/site.standard.publication/3mstjk7sct22d`,
          title: 'An essay',
        },
      },
    ]);

    const result = await updatePublication(SESSION, env as unknown as Env, { name: 'New name' });

    expect(result.success).toBe(true);
    const newRkey = await storedRkey();
    expect(newRkey && isWritablePublicationRkey(newRkey)).toBe(true);
    const newUri = publicationUriFor(DID, newRkey!);
    expect(result.success && result.data.move).toEqual({
      from: publicationUriFor(DID, LEGACY_LINKBLOG_RKEY),
      to: newUri,
      movedPosts: 2,
      complete: true,
    });

    // The publication was written at the TID, with the new name.
    const written = puts(calls);
    expect(written).toHaveLength(1);
    expect(written[0].body?.rkey).toBe(newRkey);
    expect((written[0].body?.record as { name?: string })?.name).toBe('New name');

    // Both of ours were repointed in one applyWrites, and the foreign essay
    // wasn't among them.
    const writes = applyWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0].map((w) => w.rkey)).toEqual(['3kaaa', '3kbbb']);
    for (const write of writes[0]) {
      expect(write.$type).toBe('com.atproto.repo.applyWrites#update');
      expect((write.value as { site: string }).site).toBe(newUri);
      // The whole record goes back to the PDS, so a legacy array `links` has to
      // be re-wrapped on the way or the move itself would fail validation.
      expect((write.value as { links: unknown }).links).toEqual({
        $type: 'app.skyreader.linkblog.links',
        refs: [{ uri: 'https://example.com/an-article', rel: 'related' }],
      });
    }

    // The emptied publication is cleaned up last.
    expect(
      calls.some(
        (c) => c.endpoint === 'com.atproto.repo.deleteRecord' && c.rkey === LEGACY_LINKBLOG_RKEY
      )
    ).toBe(true);
  });

  // Readers scope to the old publication too, so a move that dies partway still
  // shows every post — whichever side of the move it currently sits on.
  it('exposes the legacy publication as a scope once the rkey has moved', async () => {
    const rkey = generateTid();
    await env.DB.prepare(
      `INSERT INTO user_settings (user_did, linkblog_rkey, created_at, updated_at)
       VALUES (?, ?, unixepoch(), unixepoch())`
    )
      .bind(DID, rkey)
      .run();

    const target = await getLinkblogTarget(env as unknown as Env, DID);
    expect(target.legacySiteUri).toBe(publicationUriFor(DID, LEGACY_LINKBLOG_RKEY));
  });

  it('has no legacy scope for a user who never had a legacy publication', async () => {
    const target = await getLinkblogTarget(env as unknown as Env, DID);
    expect(target.defaultSiteUri).toBe(publicationUriFor(DID, LEGACY_LINKBLOG_RKEY));
    expect(target.legacySiteUri).toBeUndefined();
  });

  it('creates at a TID when settings are saved before a first share', async () => {
    const calls = stubPds({});

    const result = await updatePublication(SESSION, env as unknown as Env, { name: 'New name' });

    expect(result.success).toBe(true);
    const written = puts(calls);
    expect(written).toHaveLength(1);
    expect(isWritablePublicationRkey(written[0].body?.rkey as string)).toBe(true);
    expect(await storedRkey()).toBe(written[0].body?.rkey);
  });

  // The new rkey is stored BEFORE the walk, so a move that dies partway resolves
  // to a TID on the next attempt. What says a move is still owed is the record
  // sitting at the legacy rkey — reading the resolved rkey instead would leave
  // the stragglers (and the followers) at the old URI with no way back in.
  it('finishes a move that was interrupted after the rkey was stored', async () => {
    const rkey = generateTid();
    await env.DB.prepare(
      `INSERT INTO user_settings (user_did, linkblog_rkey, created_at, updated_at)
       VALUES (?, ?, unixepoch(), unixepoch())`
    )
      .bind(DID, rkey)
      .run();

    const legacyUri = publicationUriFor(DID, LEGACY_LINKBLOG_RKEY);
    const newUri = publicationUriFor(DID, rkey);
    const calls = stubPds(
      {
        // Both publications exist: the first attempt wrote the new one and never
        // got as far as deleting the old.
        [rkey]: { $type: 'site.standard.publication', name: 'My links', url: 'https://x.example/' },
        [LEGACY_LINKBLOG_RKEY]: STALE_PUBLICATION,
      },
      [
        shareRecord('3kaaa', newUri), // already moved
        shareRecord('3kbbb', legacyUri), // stranded
      ]
    );

    const result = await updatePublication(SESSION, env as unknown as Env, { name: 'New name' });

    expect(result.success).toBe(true);
    // Resumed onto the rkey already stored — a fresh mint would strand the posts
    // the first attempt did move.
    expect(await storedRkey()).toBe(rkey);
    expect(result.success && result.data.move).toEqual({
      from: legacyUri,
      to: newUri,
      movedPosts: 1,
      complete: true,
    });

    const written = puts(calls);
    expect(written).toHaveLength(1);
    expect(written[0].body?.rkey).toBe(rkey);

    // Only the straggler is rewritten; the one already at the new URI is left be.
    const writes = applyWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0].map((w) => w.rkey)).toEqual(['3kbbb']);
    expect(
      calls.some(
        (c) => c.endpoint === 'com.atproto.repo.deleteRecord' && c.rkey === LEGACY_LINKBLOG_RKEY
      )
    ).toBe(true);
  });

  // The legacy record IS the resume marker, so a walk that ran out of pages must
  // leave it standing — deleting it would orphan every document it didn't reach.
  it('keeps the legacy publication when the walk runs out of pages', async () => {
    const legacyUri = publicationUriFor(DID, LEGACY_LINKBLOG_RKEY);
    const calls = stubPds(
      { [LEGACY_LINKBLOG_RKEY]: STALE_PUBLICATION },
      [shareRecord('3kaaa', legacyUri)],
      { endless: true }
    );

    const result = await updatePublication(SESSION, env as unknown as Env, { name: 'New name' });

    expect(result.success).toBe(true);
    expect(result.success && result.data.move?.complete).toBe(false);
    expect(
      calls.some(
        (c) => c.endpoint === 'com.atproto.repo.deleteRecord' && c.rkey === LEGACY_LINKBLOG_RKEY
      )
    ).toBe(false);
  });

  // A read that merely failed is not a publication that isn't there. Minting on
  // one would put a second publication over a perfectly good one and repoint the
  // stored rkey at it, orphaning every document in the original.
  it('refuses to mint when the publication read fails for any other reason', async () => {
    const calls = stubPds({}, [], { readError: true });

    const ensured = await ensureLinkblogPublication(SESSION, env as unknown as Env);
    expect(ensured.success).toBe(false);
    expect(puts(calls)).toHaveLength(0);
    expect(await storedRkey()).toBeNull();

    const updated = await updatePublication(SESSION, env as unknown as Env, { name: 'New name' });
    expect(updated.success).toBe(false);
    expect(puts(calls)).toHaveLength(0);
    expect(await storedRkey()).toBeNull();
  });
});
