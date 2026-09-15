import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import * as read from '../src/services/backing/read';
import * as write from '../src/services/backing/write';
import * as didResolver from '../src/utils/did-resolver';
import * as pdsClient from '../src/services/pds-client';
import { pollRoom } from '../src/services/backing/room-sync';
import { GRANULAR_SCOPES, READING_ROOM_SCOPES, SEMBLE_SCOPES } from '../src/config/scopes';

// Reading Rooms — the add-an-article surface. What's pinned here is the
// permission rule (whose collection accepts additions, and from whom) and the
// cross-repo write it enables, because both are enforced server-side and the UI's
// `canAdd` is only a mirror of them.
// See docs/plans/READING_ROOMS_SPIKE.md.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:roomreader';
const OWNER = 'did:plc:roomowner';
const SESSION = 'sess-rooms';
const OWN_COLLECTION = `at://${DID}/network.cosmik.collection/mine`;
const OTHER_COLLECTION = `at://${OWNER}/network.cosmik.collection/theirs`;
const MARGIN_COLLECTION = `at://${OWNER}/at.margin.collection/theirs`;
const FULL_SCOPES = `${GRANULAR_SCOPES} ${SEMBLE_SCOPES.join(' ')}`;

async function reset(grantedScopes = FULL_SCOPES) {
  await env.DB.prepare('DELETE FROM room_reads WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM room_members').run();
  await env.DB.prepare('DELETE FROM room_snapshots').run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at)
     VALUES (?, 'reader.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'reader.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, grantedScopes)
    .run();
}

function request(path: string, body?: unknown, method = 'POST') {
  return new IncomingRequest(`http://localhost${path}`, {
    method,
    headers: {
      Cookie: `session_id=${SESSION}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The same request with no session cookie — a visitor on a shared room link. */
function anonRequest(path: string, method = 'GET') {
  return new IncomingRequest(`http://localhost${path}`, {
    method,
    headers: { Origin: env.FRONTEND_URL, 'Content-Type': 'application/json' },
  });
}

async function call(req: Request): Promise<{ status: number; body: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Stand in for the collection record the room resolves from its owner's PDS. */
function mockCollection(value: Record<string, unknown>, cid = 'bafycollection') {
  vi.spyOn(didResolver, 'resolvePdsUrl').mockResolvedValue('https://owner.pds');
  return vi.spyOn(read, 'getRecordPublicWithCid').mockResolvedValue({ value, cid });
}

/** A snapshot result with the given members, listed and complete. */
function snapshotOf(members: Array<Partial<read.BackedMember> & { url: string }> = []) {
  const full = members.map((m, i) => ({
    urlNormalized: m.url,
    itemType: 'network.cosmik.card',
    itemUri: `at://${OWNER}/network.cosmik.card/c${i}`,
    linkUri: `at://${OWNER}/network.cosmik.collectionLink/l${i}`,
    ...m,
  })) as read.BackedMember[];
  return {
    complete: true,
    members: full,
    skipped: [],
    typeMix: {},
    listed: full.map((m) => m.linkUri),
    listingComplete: true,
  } satisfies read.SnapshotResult;
}

function emptySnapshot() {
  return vi.spyOn(read, 'snapshotBackedCollection').mockResolvedValue(snapshotOf());
}

/** The room's `last_poll_at`, pushed back so the next GET is past its gate. */
async function ageRoom(uri: string) {
  await env.DB.prepare('UPDATE room_snapshots SET last_poll_at = 0 WHERE collection_uri = ?')
    .bind(uri)
    .run();
}

async function storedLinks(uri: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT link_uri FROM room_members WHERE collection_uri = ? ORDER BY link_uri'
  )
    .bind(uri)
    .all<{ link_uri: string }>();
  return rows.results.map((r) => r.link_uri);
}

describe('GET /api/rooms — canAdd', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('is true for a collection you own, whatever its access type', async () => {
    mockCollection({ name: 'Mine', accessType: 'CLOSED', collaborators: [] });
    emptySnapshot();
    const { status, body } = await call(
      request(`/api/rooms?uri=${encodeURIComponent(OWN_COLLECTION)}`, undefined, 'GET')
    );
    expect(status).toBe(200);
    expect(body.canAdd).toBe(true);
  });

  it('is true for an OPEN collection someone else owns', async () => {
    mockCollection({ name: 'Theirs', accessType: 'OPEN', collaborators: [] });
    emptySnapshot();
    const { body } = await call(
      request(`/api/rooms?uri=${encodeURIComponent(OTHER_COLLECTION)}`, undefined, 'GET')
    );
    expect(body.canAdd).toBe(true);
  });

  it('is true for a CLOSED collection that lists you as a collaborator', async () => {
    mockCollection({ name: 'Theirs', accessType: 'CLOSED', collaborators: [DID] });
    emptySnapshot();
    const { body } = await call(
      request(`/api/rooms?uri=${encodeURIComponent(OTHER_COLLECTION)}`, undefined, 'GET')
    );
    expect(body.canAdd).toBe(true);
  });

  it('is false for a CLOSED collection you are not part of', async () => {
    mockCollection({ name: 'Theirs', accessType: 'CLOSED', collaborators: ['did:plc:someone'] });
    emptySnapshot();
    const { body } = await call(
      request(`/api/rooms?uri=${encodeURIComponent(OTHER_COLLECTION)}`, undefined, 'GET')
    );
    expect(body.canAdd).toBe(false);
  });

  it("is false for someone else's Margin collection (the lexicon has no access field)", async () => {
    mockCollection({ name: 'Theirs' });
    emptySnapshot();
    const { body } = await call(
      request(`/api/rooms?uri=${encodeURIComponent(MARGIN_COLLECTION)}`, undefined, 'GET')
    );
    expect(body.canAdd).toBe(false);
  });
});

// A room IS a public collection, and a shared link is often a visitor's first
// page: the read has to answer without a session. What a session adds is the two
// per-reader fields.
describe('GET /api/rooms — signed out', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('resolves a room for a visitor with no session', async () => {
    mockCollection({ name: 'Theirs', description: 'Open to all', accessType: 'OPEN' });
    emptySnapshot();
    const { status, body } = await call(
      anonRequest(`/api/rooms?uri=${encodeURIComponent(OTHER_COLLECTION)}`)
    );
    expect(status).toBe(200);
    expect(body.name).toBe('Theirs');
    expect(body.description).toBe('Open to all');
    expect(body.ownerDid).toBe(OWNER);
  });

  it('reports canAdd false even for an OPEN collection — adding needs a repo', async () => {
    mockCollection({ name: 'Theirs', accessType: 'OPEN' });
    emptySnapshot();
    const { body } = await call(
      anonRequest(`/api/rooms?uri=${encodeURIComponent(OTHER_COLLECTION)}`)
    );
    expect(body.canAdd).toBe(false);
  });

  it('serves the aggregate read count but never readByMe', async () => {
    mockCollection({ name: 'Theirs', accessType: 'OPEN' });
    vi.spyOn(read, 'snapshotBackedCollection').mockResolvedValue(
      snapshotOf([{ url: 'https://a.test/x', urlNormalized: 'a.test/x' }])
    );
    // Someone else has read this article through the room.
    await env.DB.prepare(
      `INSERT INTO room_reads (collection_uri, url_normalized, did, read_at)
       VALUES (?, 'a.test/x', ?, unixepoch())`
    )
      .bind(OTHER_COLLECTION, DID)
      .run();

    const { body } = await call(
      anonRequest(`/api/rooms?uri=${encodeURIComponent(OTHER_COLLECTION)}`)
    );
    expect(body.items).toHaveLength(1);
    expect(body.items[0].readCount).toBe(1);
    expect(body.items[0].readByMe).toBe(false);
  });

  it('still requires a session to start a room', async () => {
    const created = vi.spyOn(write, 'createCollection');
    const { status } = await call(anonRequest('/api/rooms', 'POST'));
    expect(status).toBe(401);
    expect(created).not.toHaveBeenCalled();
  });
});

// The room's list is materialized in D1 and refreshed incrementally: a poll
// hands the snapshot every link it already holds, resolves only the rest, and
// deletes what the listing no longer names — but only off a listing it can
// vouch for. What's pinned here is that contract, since it is what makes a
// room cost what changed rather than what it holds.
describe('GET /api/rooms — materialized in D1', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  const ROOM = `/api/rooms?uri=${encodeURIComponent(OTHER_COLLECTION)}`;
  const L0 = `at://${OWNER}/network.cosmik.collectionLink/l0`;
  const L1 = `at://${OWNER}/network.cosmik.collectionLink/l1`;

  it('snapshots a room on first sight, then serves the stored list without another snapshot', async () => {
    mockCollection({ name: 'Theirs', accessType: 'OPEN' });
    const snapshot = vi
      .spyOn(read, 'snapshotBackedCollection')
      .mockResolvedValue(
        snapshotOf([{ url: 'https://a.test/one' }, { url: 'https://a.test/two' }])
      );

    const first = await call(anonRequest(ROOM));
    expect(first.status).toBe(200);
    expect(first.body.items.map((i: { url: string }) => i.url)).toEqual([
      'https://a.test/one',
      'https://a.test/two',
    ]);
    expect(first.body.complete).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(1);

    const second = await call(anonRequest(ROOM));
    expect(second.body.items).toHaveLength(2);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(await storedLinks(OTHER_COLLECTION)).toEqual([L0, L1]);
  });

  it('refreshes a stale room behind the response, resolving only links it does not hold', async () => {
    mockCollection({ name: 'Theirs', accessType: 'OPEN' });
    const snapshot = vi
      .spyOn(read, 'snapshotBackedCollection')
      .mockResolvedValue(
        snapshotOf([{ url: 'https://a.test/one', addedAt: '2026-01-01T00:00:00Z' }])
      );
    await call(anonRequest(ROOM));
    await ageRoom(OTHER_COLLECTION);

    // The second poll: the stored link is still listed but not re-resolved, and
    // a new contributor link arrives.
    const L2 = `at://did:plc:friend/network.cosmik.collectionLink/theirs`;
    snapshot.mockResolvedValue({
      ...snapshotOf([
        { url: 'https://a.test/three', linkUri: L2, addedAt: '2026-02-01T00:00:00Z' },
      ]),
      listed: [L0, L2],
    });
    const { body } = await call(anonRequest(ROOM));
    // The response was served from the stored copy; the refresh ran in waitUntil.
    expect(body.items.map((i: { url: string }) => i.url)).toEqual(['https://a.test/one']);
    expect(snapshot).toHaveBeenCalledTimes(2);
    const opts = snapshot.mock.calls[1][3]!;
    expect([...opts.skipLinks!]).toEqual([L0]);
    expect(opts.includeForeign).toBe(true);

    const after = await call(anonRequest(ROOM));
    expect(after.body.items.map((i: { url: string }) => i.url)).toEqual([
      'https://a.test/one',
      'https://a.test/three',
    ]);
  });

  it('drops a link the listing no longer names, but only off a complete listing', async () => {
    mockCollection({ name: 'Theirs', accessType: 'OPEN' });
    const snapshot = vi
      .spyOn(read, 'snapshotBackedCollection')
      .mockResolvedValue(
        snapshotOf([{ url: 'https://a.test/one' }, { url: 'https://a.test/two' }])
      );
    await call(anonRequest(ROOM));

    // A truncated walk lists only one of the two: nothing may be deleted off it.
    snapshot.mockResolvedValue({ ...snapshotOf(), listed: [L0], listingComplete: false });
    await pollRoom(env, OTHER_COLLECTION, { force: true });
    expect(await storedLinks(OTHER_COLLECTION)).toEqual([L0, L1]);
    expect((await call(anonRequest(ROOM))).body.complete).toBe(false);

    // A whole listing that omits l1 means l1 left the collection.
    snapshot.mockResolvedValue({ ...snapshotOf(), listed: [L0] });
    await pollRoom(env, OTHER_COLLECTION, { force: true });
    expect(await storedLinks(OTHER_COLLECTION)).toEqual([L0]);
    const { body } = await call(anonRequest(ROOM));
    expect(body.items.map((i: { url: string }) => i.url)).toEqual(['https://a.test/one']);
    expect(body.complete).toBe(true);
  });

  it('is complete only once every listed link has a row, filling in across polls', async () => {
    mockCollection({ name: 'Theirs', accessType: 'OPEN' });
    // First look: two links listed, the budget only resolved one.
    const snapshot = vi.spyOn(read, 'snapshotBackedCollection').mockResolvedValue({
      ...snapshotOf([{ url: 'https://a.test/one' }]),
      skipped: [{ reason: read.TRANSIENT_SKIP, linkUri: L1 }],
      listed: [L0, L1],
    });
    const first = await call(anonRequest(ROOM));
    expect(first.body.complete).toBe(false);
    expect(first.body.items).toHaveLength(1);

    // Next poll resolves the rest. A NOTE card is not an article: it gets a row
    // (so it is never fetched again) but no place in the list.
    const L2 = `at://${OWNER}/network.cosmik.collectionLink/note`;
    snapshot.mockResolvedValue({
      ...snapshotOf([{ url: 'https://a.test/two', linkUri: L1 }]),
      skipped: [{ reason: 'no-url (network.cosmik.card)', linkUri: L2 }],
      listed: [L0, L1, L2],
    });
    await pollRoom(env, OTHER_COLLECTION, { force: true });
    const { body } = await call(anonRequest(ROOM));
    expect(body.complete).toBe(true);
    expect(body.items).toHaveLength(2);
    expect(await storedLinks(OTHER_COLLECTION)).toEqual([L0, L1, L2]);
  });

  it('lets one poll through at a time', async () => {
    mockCollection({ name: 'Theirs', accessType: 'OPEN' });
    const snapshot = emptySnapshot();
    await call(anonRequest(ROOM));
    await ageRoom(OTHER_COLLECTION);

    const results = await Promise.all([
      pollRoom(env, OTHER_COLLECTION),
      pollRoom(env, OTHER_COLLECTION),
    ]);
    expect(results.filter((r) => r.polled)).toHaveLength(1);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('forgets a room whose collection is gone, and 404s the next open', async () => {
    const record = mockCollection({ name: 'Theirs', accessType: 'OPEN' });
    emptySnapshot();
    await call(anonRequest(ROOM));

    record.mockResolvedValue(null);
    const result = await pollRoom(env, OTHER_COLLECTION, { force: true });
    expect(result).toMatchObject({ polled: true, gone: true });
    expect(await storedLinks(OTHER_COLLECTION)).toEqual([]);
    expect((await call(anonRequest(ROOM))).status).toBe(404);
  });

  it('serves a stored room while its refresh is gated', async () => {
    mockCollection({ name: 'Theirs', accessType: 'OPEN' });
    const snapshot = emptySnapshot();
    await call(anonRequest(ROOM));
    expect(await pollRoom(env, OTHER_COLLECTION)).toEqual({ polled: false, reason: 'gated' });
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});

// The join is idempotent off a listing of the caller's own repo, so what that
// listing does when it FAILS is the whole correctness question: read "not
// joined" from an unreadable repo and you mint a second readAlong for one room.
describe('POST /api/rooms/join', () => {
  const JOINER_SCOPES = `${FULL_SCOPES} ${READING_ROOM_SCOPES.join(' ')}`;
  const RKEY = '3kzabcdefghij';
  beforeEach(() => reset(JOINER_SCOPES));
  afterEach(() => vi.restoreAllMocks());

  /** A PDS whose readAlong listing answers `list`, and whose writes succeed. */
  function pdsWithRecords(list: { success: boolean; data?: unknown[] }) {
    const putRecord = vi.fn(async (collection: string, rkey: string) => ({
      success: true,
      data: { uri: `at://${DID}/${collection}/${rkey}`, cid: 'c' },
    }));
    const listAllRecords = vi.fn(async () =>
      list.success
        ? { success: true, data: list.data ?? [] }
        : { success: false, error: 'pds down' }
    );
    vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue({
      putRecord,
      listAllRecords,
    } as never);
    return putRecord;
  }

  it('writes one readAlong record for a room you have not joined', async () => {
    const putRecord = pdsWithRecords({ success: true, data: [] });
    const { status, body } = await call(
      request('/api/rooms/join', { collectionUri: OTHER_COLLECTION, rkey: RKEY })
    );
    expect(status).toBe(200);
    expect(body.joined).toBe(true);
    expect(putRecord).toHaveBeenCalledTimes(1);
    expect(putRecord.mock.calls[0][1]).toBe(RKEY);
  });

  it('is idempotent: an existing join is the answer, not a second record', async () => {
    const existing = `at://${DID}/app.skyreader.reading.readAlong/already`;
    const putRecord = pdsWithRecords({
      success: true,
      data: [{ uri: existing, value: { subject: OTHER_COLLECTION } }],
    });
    const { status, body } = await call(
      request('/api/rooms/join', { collectionUri: OTHER_COLLECTION, rkey: RKEY })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ joined: true, uri: existing });
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('fails the join when the repo cannot be read, rather than minting a duplicate', async () => {
    const putRecord = pdsWithRecords({ success: false });
    const { status } = await call(
      request('/api/rooms/join', { collectionUri: OTHER_COLLECTION, rkey: RKEY })
    );
    expect(status).toBe(502);
    expect(putRecord).not.toHaveBeenCalled();
  });
});

describe('POST /api/rooms/items', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('writes the membership with the PUBLICLY resolved collection cid', async () => {
    mockCollection({ name: 'Theirs', accessType: 'OPEN' }, 'bafyopencollection');
    const createMember = vi.spyOn(write, 'createMember').mockResolvedValue({
      itemUri: `at://${DID}/network.cosmik.card/c1`,
      linkUri: `at://${DID}/network.cosmik.collectionLink/l1`,
    });

    const { status, body } = await call(
      request('/api/rooms/items', {
        collectionUri: OTHER_COLLECTION,
        url: 'https://example.com/post/?utm_source=x',
        title: 'A Post',
      })
    );

    expect(status).toBe(200);
    // The strongRef must come from the owner's repo — pds.getRecord only ever
    // reads our own, so a missing cid here is a link that can't be written.
    expect(createMember.mock.calls[0][5]).toEqual({ collectionCid: 'bafyopencollection' });
    expect(createMember.mock.calls[0][3]).toBe(OTHER_COLLECTION);
    expect(body.item.title).toBe('A Post');
    expect(body.item.urlNormalized).toBe('https://example.com/post');
    expect(body.linkUri).toContain('network.cosmik.collectionLink');
  });

  it('refuses a closed collection you are not part of, without writing anything', async () => {
    mockCollection({ name: 'Theirs', accessType: 'CLOSED', collaborators: [] });
    const createMember = vi.spyOn(write, 'createMember');
    const { status } = await call(
      request('/api/rooms/items', { collectionUri: OTHER_COLLECTION, url: 'https://a.test/x' })
    );
    expect(status).toBe(403);
    expect(createMember).not.toHaveBeenCalled();
  });

  it('403s a session without the provider scopes into the scope-upgrade flow', async () => {
    await reset(GRANULAR_SCOPES); // no Semble repo scopes
    mockCollection({ name: 'Mine', accessType: 'CLOSED' });
    const createMember = vi.spyOn(write, 'createMember');
    const { status, body } = await call(
      request('/api/rooms/items', { collectionUri: OWN_COLLECTION, url: 'https://a.test/x' })
    );
    expect(status).toBe(403);
    expect(body.error).toBe('scope_upgrade_required');
    expect(createMember).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) link', async () => {
    const { status } = await call(
      request('/api/rooms/items', {
        collectionUri: OWN_COLLECTION,
        url: 'javascript:alert(1)',
      })
    );
    expect(status).toBe(400);
  });

  it('carries the room read count of a URL someone already read here', async () => {
    await env.DB.prepare(
      `INSERT INTO room_reads (collection_uri, url_normalized, did, read_at)
       VALUES (?, 'https://example.com/post', ?, unixepoch())`
    )
      .bind(OWN_COLLECTION, DID)
      .run();
    mockCollection({ name: 'Mine', accessType: 'CLOSED' });
    vi.spyOn(write, 'createMember').mockResolvedValue({
      itemUri: `at://${DID}/network.cosmik.card/c1`,
      linkUri: `at://${DID}/network.cosmik.collectionLink/l1`,
    });
    const { body } = await call(
      request('/api/rooms/items', {
        collectionUri: OWN_COLLECTION,
        url: 'https://example.com/post',
        title: 'A Post',
      })
    );
    expect(body.item.readCount).toBe(1);
    expect(body.item.readByMe).toBe(true);
  });
});

describe('POST /api/rooms/items — the materialized room', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('shows the added article on the next open, before any poll has run', async () => {
    mockCollection({ name: 'Theirs', accessType: 'OPEN' });
    const snapshot = emptySnapshot();
    const ROOM = `/api/rooms?uri=${encodeURIComponent(OTHER_COLLECTION)}`;
    expect((await call(anonRequest(ROOM))).body.items).toHaveLength(0);

    vi.spyOn(write, 'createMember').mockResolvedValue({
      itemUri: `at://${DID}/network.cosmik.card/c1`,
      linkUri: `at://${DID}/network.cosmik.collectionLink/l1`,
    });
    const added = await call(
      request('/api/rooms/items', {
        collectionUri: OTHER_COLLECTION,
        url: 'https://example.com/post',
        title: 'A Post',
      })
    );
    expect(added.status).toBe(200);

    const { body } = await call(anonRequest(ROOM));
    expect(body.items.map((i: { url: string; title?: string }) => [i.url, i.title])).toEqual([
      ['https://example.com/post', 'A Post'],
    ]);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/rooms — start a room', () => {
  const CREATOR_SCOPES = `${FULL_SCOPES} ${READING_ROOM_SCOPES.join(' ')}`;
  beforeEach(() => reset(CREATOR_SCOPES));
  afterEach(() => vi.restoreAllMocks());

  /** A PDS that accepts every write; returns the readAlong puts for inspection. */
  function acceptingPds(joinResult: { success: boolean; error?: string } = { success: true }) {
    const putRecord = vi.fn(async (collection: string, rkey: string) =>
      joinResult.success
        ? { success: true, data: { uri: `at://${DID}/${collection}/${rkey}`, cid: 'c' } }
        : { success: false, error: joinResult.error ?? 'nope', retryable: false }
    );
    vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue({ putRecord } as never);
    return putRecord;
  }

  it('creates a closed Semble collection by default and joins it', async () => {
    const putRecord = acceptingPds();
    const created = vi
      .spyOn(write, 'createCollection')
      .mockResolvedValue({ uri: `at://${DID}/network.cosmik.collection/newroom` });

    const { status, body } = await call(request('/api/rooms', { name: '  Slow Reads  ' }));

    expect(status).toBe(201);
    expect(created).toHaveBeenCalledTimes(1);
    const [, provider, name, opts] = created.mock.calls[0];
    expect(provider).toBe('semble');
    expect(name).toBe('Slow Reads');
    expect(opts).toEqual({ accessType: 'CLOSED', description: undefined });

    // The creator's own readAlong record, pointing at the new collection.
    expect(putRecord).toHaveBeenCalledTimes(1);
    const [collection, rkey, record] = putRecord.mock.calls[0];
    expect(collection).toBe('app.skyreader.reading.readAlong');
    expect(rkey).toMatch(/^[a-z0-9]{13,16}$/);
    expect(record.subject).toBe(`at://${DID}/network.cosmik.collection/newroom`);

    expect(body).toMatchObject({
      uri: `at://${DID}/network.cosmik.collection/newroom`,
      provider: 'semble',
      name: 'Slow Reads',
      access: 'closed',
      joined: true,
    });
  });

  it('passes open access and the description through to the collection', async () => {
    acceptingPds();
    const created = vi
      .spyOn(write, 'createCollection')
      .mockResolvedValue({ uri: `at://${DID}/network.cosmik.collection/open` });

    const { status, body } = await call(
      request('/api/rooms', { name: 'Open Reads', description: ' Anyone adds. ', access: 'open' })
    );

    expect(status).toBe(201);
    expect(created.mock.calls[0][3]).toEqual({ accessType: 'OPEN', description: 'Anyone adds.' });
    expect(body.access).toBe('open');
    expect(body.description).toBe('Anyone adds.');
  });

  it('still returns the room when the join write fails after the collection exists', async () => {
    acceptingPds({ success: false, error: 'pds down' });
    vi.spyOn(write, 'createCollection').mockResolvedValue({
      uri: `at://${DID}/network.cosmik.collection/lonely`,
    });

    const { status, body } = await call(request('/api/rooms', { name: 'Lonely' }));

    expect(status).toBe(201);
    expect(body.uri).toBe(`at://${DID}/network.cosmik.collection/lonely`);
    expect(body.joined).toBe(false);
  });

  it('refuses a session missing the readAlong scope before writing anything', async () => {
    await reset(FULL_SCOPES); // provider scopes only
    const putRecord = acceptingPds();
    const created = vi.spyOn(write, 'createCollection');

    const { status, body } = await call(request('/api/rooms', { name: 'Nope' }));

    expect(status).toBe(403);
    expect(body.error).toBe('scope_upgrade_required');
    expect(created).not.toHaveBeenCalled();
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('refuses a session missing the provider scopes before writing anything', async () => {
    await reset(`${GRANULAR_SCOPES} ${READING_ROOM_SCOPES.join(' ')}`);
    acceptingPds();
    const created = vi.spyOn(write, 'createCollection');

    const { status } = await call(request('/api/rooms', { name: 'Nope' }));

    expect(status).toBe(403);
    expect(created).not.toHaveBeenCalled();
  });

  it('rejects a blank name, an unknown provider, and an unknown access value', async () => {
    acceptingPds();
    const created = vi.spyOn(write, 'createCollection');

    expect((await call(request('/api/rooms', { name: '   ' }))).status).toBe(400);
    expect((await call(request('/api/rooms', { name: 'X', provider: 'pocket' }))).status).toBe(400);
    expect((await call(request('/api/rooms', { name: 'X', access: 'secret' }))).status).toBe(400);
    expect(created).not.toHaveBeenCalled();
  });
});
