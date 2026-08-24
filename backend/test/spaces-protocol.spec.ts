import { describe, it, expect, vi } from 'vitest';
import {
  createSpaceDpopProof,
  generateSpaceDpopKey,
  jwtExpirySeconds,
  normalizeHtu,
} from '../src/services/spaces/dpop';
import {
  exchangeSpaceCredential,
  mintSpaceCredential,
  getOrMintSpaceCredential,
  clearCredentialCache,
  SpaceCredential,
  SpaceCredentialError,
} from '../src/services/spaces/credential';
import {
  PERSONAL_SPACE_APP_ACCESS,
  PERSONAL_SPACE_POLICY,
  SpacesClient,
  type XrpcCall,
} from '../src/services/spaces/client';
import {
  credentialCall,
  isSpaceAccessDenied,
  isSpaceNotFound,
  sessionCall,
  SpaceXrpcError,
} from '../src/services/spaces/transport';
import { SAVED_SPACE_SKEY, SAVED_SPACE_TYPE, savedSpaceRef } from '../src/services/spaces/refs';

// Wire-level coverage of the Spaces client: the DPoP proofs, the credential
// exchange, and the exact request shapes we send. Method and parameter names are
// pinned against @atproto/api@0.0.0-spaces-alpha-20260818163953 — if the alpha
// renames something, these assertions are what notices.

const DID = 'did:plc:spaceproto';
const SPACE = savedSpaceRef(DID);

function decodeJwtPart(part: string): Record<string, unknown> {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
}

describe('space DPoP proofs', () => {
  it('signs an ES256 proof carrying the bare public JWK', async () => {
    const key = await generateSpaceDpopKey();
    const proof = await createSpaceDpopProof(key, {
      htm: 'POST',
      htu: 'https://pds.test/xrpc/com.atproto.space.createRecord',
    });

    const [header, payload, signature] = proof.split('.');
    expect(signature).toBeTruthy();

    const decodedHeader = decodeJwtPart(header) as { typ: string; alg: string; jwk: JsonWebKey };
    expect(decodedHeader.typ).toBe('dpop+jwt');
    expect(decodedHeader.alg).toBe('ES256');
    expect(Object.keys(decodedHeader.jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    // The private half must never ride along in the proof header.
    expect((decodedHeader.jwk as Record<string, unknown>).d).toBeUndefined();

    const decodedPayload = decodeJwtPart(payload);
    expect(decodedPayload.htm).toBe('POST');
    expect(decodedPayload.jti).toEqual(expect.any(String));
    expect(decodedPayload.iat).toEqual(expect.any(Number));
  });

  it('strips query and fragment from htu (RFC 9449 §4.2)', async () => {
    expect(normalizeHtu('https://pds.test/xrpc/com.atproto.space.listRecords?space=a&repo=b')).toBe(
      'https://pds.test/xrpc/com.atproto.space.listRecords'
    );

    const key = await generateSpaceDpopKey();
    const proof = await createSpaceDpopProof(key, {
      htm: 'GET',
      htu: 'https://pds.test/xrpc/com.atproto.space.listRecords?space=a#frag',
    });
    expect(decodeJwtPart(proof.split('.')[1]).htu).toBe(
      'https://pds.test/xrpc/com.atproto.space.listRecords'
    );
  });

  it('omits ath when obtaining a credential and includes it when presenting one', async () => {
    const key = await generateSpaceDpopKey();

    const obtaining = await createSpaceDpopProof(key, { htm: 'POST', htu: 'https://pds.test/x' });
    expect(decodeJwtPart(obtaining.split('.')[1]).ath).toBeUndefined();

    const presenting = await createSpaceDpopProof(key, {
      htm: 'POST',
      htu: 'https://pds.test/x',
      credential: 'cred-abc',
    });
    expect(decodeJwtPart(presenting.split('.')[1]).ath).toEqual(expect.any(String));
  });

  it('reads exp out of a credential without verifying it', () => {
    const jwt = `x.${btoa(JSON.stringify({ exp: 1800000000 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')}.y`;
    expect(jwtExpirySeconds(jwt)).toBe(1800000000);
    expect(jwtExpirySeconds('not-a-jwt')).toBeNull();
  });
});

describe('space credential exchange', () => {
  it('presents the delegation token as Bearer with an ath-less DPoP proof', async () => {
    const key = await generateSpaceDpopKey();
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ credential: 'cred-1' }), { status: 200 });
    }) as unknown as typeof fetch;

    const credential = await exchangeSpaceCredential({
      authorityPdsUrl: 'https://pds.test/',
      delegationToken: 'deleg-1',
      space: SPACE,
      key,
      fetchImpl,
    });

    expect(credential).toBe('cred-1');
    expect(seen.url).toBe('https://pds.test/xrpc/com.atproto.space.getSpaceCredential');
    const headers = seen.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer deleg-1');
    expect(decodeJwtPart(headers.dpop.split('.')[1]).ath).toBeUndefined();
    expect(JSON.parse(seen.init!.body as string)).toEqual({ space: SPACE });
  });

  it('surfaces the alpha error code when the exchange is refused', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'UserNotAuthorized', message: 'nope' }), {
        status: 401,
      })) as unknown as typeof fetch;

    const error = await exchangeSpaceCredential({
      authorityPdsUrl: 'https://pds.test',
      delegationToken: 'deleg-1',
      space: SPACE,
      key: await generateSpaceDpopKey(),
      fetchImpl,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(SpaceCredentialError);
    expect(error.code).toBe('UserNotAuthorized');
    expect(isSpaceAccessDenied(error)).toBe(true);
  });

  it('mints through both legs and caches until close to expiry', async () => {
    clearCredentialCache();
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const token = `x.${btoa(JSON.stringify({ exp }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')}.y`;

    const getDelegationToken = vi.fn(async () => 'deleg-1');
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ credential: token }), { status: 200 })
    ) as unknown as typeof fetch;

    const input = {
      space: SPACE,
      authorityPdsUrl: 'https://pds.test',
      getDelegationToken,
      fetchImpl,
    };

    const first = await getOrMintSpaceCredential(DID, input);
    const second = await getOrMintSpaceCredential(DID, input);

    expect(second).toBe(first);
    expect(getDelegationToken).toHaveBeenCalledTimes(1);
    expect(first.isFresh()).toBe(true);
    // 2h TTL, read off the token rather than assumed.
    expect(Math.round((first.expiresAt - Date.now()) / 1000)).toBeGreaterThan(7000);
  });

  it('re-mints once the cached credential is inside the expiry margin', async () => {
    clearCredentialCache();
    const nearlyExpired = Math.floor(Date.now() / 1000) + 5;
    const token = (exp: number) =>
      `x.${btoa(JSON.stringify({ exp }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')}.y`;

    let issued = 0;
    const fetchImpl = (async () => {
      issued++;
      return new Response(
        JSON.stringify({
          credential: token(issued === 1 ? nearlyExpired : Math.floor(Date.now() / 1000) + 7200),
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const input = {
      space: SPACE,
      authorityPdsUrl: 'https://pds.test',
      getDelegationToken: async () => 'deleg-1',
      fetchImpl,
    };

    const stale = await getOrMintSpaceCredential(DID, input);
    expect(stale.isFresh()).toBe(false);
    await getOrMintSpaceCredential(DID, input);
    expect(issued).toBe(2);
  });

  it('mints a usable credential that authorizes a request with a bound proof', async () => {
    const token = 'cred-xyz';
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ credential: token }), {
        status: 200,
      })) as unknown as typeof fetch;

    const credential = await mintSpaceCredential({
      space: SPACE,
      authorityPdsUrl: 'https://pds.test',
      getDelegationToken: async () => 'deleg-1',
      fetchImpl,
    });

    const headers = await credential.authorize('GET', 'https://pds.test/xrpc/x?y=1');
    expect(headers.Authorization).toBe(`DPoP ${token}`);
    expect(decodeJwtPart(headers.DPoP.split('.')[1]).ath).toEqual(expect.any(String));
  });
});

describe('SpacesClient request shapes', () => {
  function recording() {
    const calls: Array<{ method: string; endpoint: string; body?: unknown }> = [];
    const call: XrpcCall = async <T>(method: 'GET' | 'POST', endpoint: string, body?: unknown) => {
      calls.push({ method, endpoint, body });
      return {} as T;
    };
    return { calls, client: new SpacesClient(call) };
  }

  it('creates a personal space that is member-list private with open app access', async () => {
    const { calls, client } = recording();
    await client.createSpace({
      type: SAVED_SPACE_TYPE,
      skey: SAVED_SPACE_SKEY,
      policy: PERSONAL_SPACE_POLICY,
      appAccess: PERSONAL_SPACE_APP_ACCESS,
    });

    expect(calls[0]).toEqual({
      method: 'POST',
      endpoint: 'com.atproto.simplespace.createSpace',
      body: {
        type: 'app.skyreader.space.saved',
        skey: 'self',
        policy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
        appAccess: { $type: 'com.atproto.simplespace.defs#open' },
      },
    });
  });

  it('writes and deletes records with the space, repo, collection and rkey', async () => {
    const { calls, client } = recording();
    await client.createRecord({
      space: SPACE,
      repo: DID,
      collection: 'app.skyreader.feed.saved',
      rkey: '3laaaaaaaaaaa',
      record: { $type: 'app.skyreader.feed.saved', savedAt: '2026-01-01T00:00:00.000Z' },
    });
    await client.deleteRecord({
      space: SPACE,
      repo: DID,
      collection: 'app.skyreader.feed.saved',
      rkey: '3laaaaaaaaaaa',
    });

    expect(calls[0].endpoint).toBe('com.atproto.space.createRecord');
    expect(calls[0].body).toMatchObject({ space: SPACE, repo: DID, rkey: '3laaaaaaaaaaa' });
    expect(calls[1].endpoint).toBe('com.atproto.space.deleteRecord');
  });

  it('encodes reads as query strings on the GET endpoints', async () => {
    const { calls, client } = recording();
    await client.getSpace(SPACE);
    await client.getDelegationToken(SPACE);
    await client.listRecords({ space: SPACE, repo: DID, collection: 'app.skyreader.feed.saved' });

    expect(calls[0].method).toBe('GET');
    expect(calls[0].endpoint).toContain('com.atproto.simplespace.getSpace?space=');
    expect(calls[1].endpoint).toContain('com.atproto.space.getDelegationToken?space=');
    expect(calls[2].endpoint).toContain('com.atproto.space.listRecords?space=');
    expect(calls[2].endpoint).toContain('collection=app.skyreader.feed.saved');
  });

  it('follows the cursor when listing a whole collection', async () => {
    let page = 0;
    const call: XrpcCall = async <T>() => {
      page++;
      return (
        page === 1
          ? { records: [{ collection: 'c', rkey: 'a', cid: '1' }], cursor: 'next' }
          : { records: [{ collection: 'c', rkey: 'b', cid: '2' }] }
      ) as T;
    };

    const listing = await new SpacesClient(call).listAllRecords({ space: SPACE, repo: DID });
    expect(listing.records.map((r) => r.rkey)).toEqual(['a', 'b']);
    expect(listing.truncated).toBe(false);
  });

  it('marks a listing truncated when the page cap stops a pending cursor', async () => {
    const call: XrpcCall = async <T>() =>
      ({ records: [{ collection: 'c', rkey: 'a', cid: '1' }], cursor: 'next' }) as T;

    const listing = await new SpacesClient(call).listAllRecords({ space: SPACE, repo: DID }, 1);
    expect(listing.records).toHaveLength(1);
    expect(listing.truncated).toBe(true);
  });
});

describe('transports', () => {
  it('turns a failed session call into a throw the mirror can swallow', async () => {
    const call = sessionCall({
      xrpc: async () => ({ success: false as const, error: 'boom', retryable: false }),
    });
    await expect(call('POST', 'com.atproto.space.createRecord', {})).rejects.toBeInstanceOf(
      SpaceXrpcError
    );
  });

  it('preserves the structured error code and status from a failed session call', async () => {
    const call = sessionCall({
      xrpc: async () => ({
        success: false as const,
        error: 'No such space',
        code: 'SpaceNotFound',
        status: 400,
        retryable: false,
      }),
    });
    const error = await call('GET', 'com.atproto.simplespace.getSpace?space=x').catch((e) => e);
    expect(error).toMatchObject({ code: 'SpaceNotFound', status: 400 });
    expect(isSpaceNotFound(error)).toBe(true);
  });

  it('presents the credential as DPoP on every credential-authed call', async () => {
    const credential = new SpaceCredential(
      'cred-1',
      await generateSpaceDpopKey(),
      Date.now() + 60_000
    );
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenHeaders = init!.headers as Record<string, string>;
      expect(String(url)).toBe('https://host.test/xrpc/com.atproto.space.listRecords?space=x');
      return new Response(JSON.stringify({ records: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const call = credentialCall('https://host.test/', credential, fetchImpl);
    await call('GET', 'com.atproto.space.listRecords?space=x');

    expect(seenHeaders.Authorization).toBe('DPoP cred-1');
    expect(seenHeaders.DPoP).toEqual(expect.any(String));
  });

  it('classifies the alpha error codes the spike branches on', async () => {
    const denied = (async () =>
      new Response(JSON.stringify({ error: 'UserNotAuthorized' }), {
        status: 403,
      })) as unknown as typeof fetch;
    const missing = (async () =>
      new Response(JSON.stringify({ error: 'SpaceNotFound' }), {
        status: 400,
      })) as unknown as typeof fetch;

    const credential = new SpaceCredential(
      'cred-1',
      await generateSpaceDpopKey(),
      Date.now() + 60_000
    );

    const deniedError = await credentialCall(
      'https://host.test',
      credential,
      denied
    )('GET', 'com.atproto.space.listRecords?space=x').catch((e) => e);
    expect(isSpaceAccessDenied(deniedError)).toBe(true);
    expect(isSpaceNotFound(deniedError)).toBe(false);

    const missingError = await credentialCall(
      'https://host.test',
      credential,
      missing
    )('GET', 'com.atproto.simplespace.getSpace?space=x').catch((e) => e);
    expect(isSpaceNotFound(missingError)).toBe(true);
  });
});
