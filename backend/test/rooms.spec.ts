import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import * as read from '../src/services/backing/read';
import * as write from '../src/services/backing/write';
import * as didResolver from '../src/utils/did-resolver';
import * as pdsClient from '../src/services/pds-client';
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

function emptySnapshot() {
  return vi
    .spyOn(read, 'snapshotBackedCollection')
    .mockResolvedValue({ complete: true, members: [], skipped: [], typeMix: {} });
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
