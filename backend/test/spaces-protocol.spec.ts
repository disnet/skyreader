import { describe, it, expect, vi } from 'vitest';
import { p256 } from '@noble/curves/nist.js';
import {
  createSpaceSignatureHeaders,
  generateSpaceSigningKey,
  jwtExpirySeconds,
  p256DidKey,
} from '../src/services/spaces/http-signature';
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

// Wire-level coverage of the Spaces client: the HTTP message signatures, the
// credential exchange, and the exact request shapes we send. Method and parameter
// names are pinned against @atproto/api@0.0.0-spaces-alpha-20261001173819 — if the
// alpha renames something, these assertions are what notices.

const DID = 'did:plc:spaceproto';
const SPACE = savedSpaceRef(DID);

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Compressed P-256 public key out of a `did:key`, decoded independently of the encoder. */
function didKeyPublicKey(did: string): Uint8Array {
  expect(did.startsWith('did:key:z')).toBe(true);
  let n = 0n;
  for (const c of did.slice('did:key:z'.length)) n = n * 58n + BigInt(BASE58.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // multicodec p256-pub (0x1200) varint, then the 33-byte compressed point.
  expect(bytes.slice(0, 2)).toEqual([0x80, 0x24]);
  return Uint8Array.from(bytes.slice(2));
}

/**
 * The verifier side of `@atproto/space` `verifySpaceSignature`, enough to prove a
 * signature checks out under the key it names.
 */
function verifySignatureHeaders(headers: Record<string, string>, keyDid: string): boolean {
  const input = headers['signature-input'].replace(/^atproto-space=/, '');
  const signature = /^atproto-space=:(.+):$/.exec(headers.signature)![1];
  const lines = [`"authorization": ${headers.authorization}`];
  if (headers['atproto-space-audience'] !== undefined) {
    lines.push(`"atproto-space-audience": ${headers['atproto-space-audience']}`);
  }
  lines.push(`"@signature-params": ${input}`);
  const sigBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  expect(sigBytes.length).toBe(64);
  return p256.verify(
    sigBytes,
    new TextEncoder().encode(lines.join('\n')),
    didKeyPublicKey(keyDid),
    { lowS: false }
  );
}

describe('space HTTP message signatures', () => {
  it('names a fresh P-256 did:key', async () => {
    const key = await generateSpaceSigningKey();
    // `zDn` is the base58btc prefix every P-256 did:key shares.
    expect(key.did).toMatch(/^did:key:zDn[1-9A-HJ-NP-Za-km-z]+$/);
    expect(() => p256.Point.fromBytes(didKeyPublicKey(key.did))).not.toThrow();
    expect(() => p256DidKey(new Uint8Array(33))).toThrow();
  });

  it('signs only the authorization header, with keyid, when obtaining a credential', async () => {
    const key = await generateSpaceSigningKey();
    const headers = await createSpaceSignatureHeaders(key, { authorization: 'Bearer deleg-1' });

    expect(headers.authorization).toBe('Bearer deleg-1');
    expect(headers['atproto-space-audience']).toBeUndefined();
    expect(headers['signature-input']).toBe(`atproto-space=("authorization");keyid="${key.did}"`);
    expect(verifySignatureHeaders(headers, key.did)).toBe(true);
  });

  it('signs authorization and audience, without keyid, when presenting one', async () => {
    const key = await generateSpaceSigningKey();
    const headers = await createSpaceSignatureHeaders(key, {
      authorization: 'Atproto-Space cred-1',
      audience: DID,
    });

    expect(headers['atproto-space-audience']).toBe(DID);
    expect(headers['signature-input']).toBe(
      'atproto-space=("authorization" "atproto-space-audience")'
    );
    expect(verifySignatureHeaders(headers, key.did)).toBe(true);
    // The audience is covered: retargeting the request breaks the signature.
    expect(
      verifySignatureHeaders({ ...headers, 'atproto-space-audience': 'did:plc:other' }, key.did)
    ).toBe(false);
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
  it('presents the delegation token as Bearer with a keyid-carrying signature', async () => {
    const key = await generateSpaceSigningKey();
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
    expect(headers['signature-input']).toContain(`keyid="${key.did}"`);
    expect(verifySignatureHeaders(headers, key.did)).toBe(true);
    expect(headers.dpop).toBeUndefined();
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
      key: await generateSpaceSigningKey(),
      fetchImpl,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(SpaceCredentialError);
    expect(error.code).toBe('UserNotAuthorized');
    expect(isSpaceAccessDenied(error)).toBe(true);
  });

  it('mints through both legs and caches until close to expiry', async () => {
    clearCredentialCache();
    const exp = Math.floor(Date.now() / 1000) + 600;
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
    // 10 min TTL, read off the token rather than assumed.
    expect(Math.round((first.expiresAt - Date.now()) / 1000)).toBeGreaterThan(590);
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
          credential: token(issued === 1 ? nearlyExpired : Math.floor(Date.now() / 1000) + 600),
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

  it('mints a usable credential that authorizes a request with a bound signature', async () => {
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

    const headers = await credential.authorize(DID);
    expect(headers.authorization).toBe(`Atproto-Space ${token}`);
    expect(headers['atproto-space-audience']).toBe(DID);
    expect(verifySignatureHeaders(headers, credential.key.did)).toBe(true);
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
      spaceType: SAVED_SPACE_TYPE,
      skey: SAVED_SPACE_SKEY,
      readPolicy: PERSONAL_SPACE_POLICY,
      writePolicy: PERSONAL_SPACE_POLICY,
      appAccess: PERSONAL_SPACE_APP_ACCESS,
    });

    expect(calls[0]).toEqual({
      method: 'POST',
      endpoint: 'com.atproto.simplespace.createSpace',
      body: {
        spaceType: 'app.skyreader.space.saved',
        skey: 'self',
        readPolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
        writePolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
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

  it('presents the credential as Atproto-Space, addressed to the audience', async () => {
    const credential = new SpaceCredential(
      'cred-1',
      await generateSpaceSigningKey(),
      Date.now() + 60_000
    );
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenHeaders = init!.headers as Record<string, string>;
      expect(String(url)).toBe('https://host.test/xrpc/com.atproto.space.listRecords?space=x');
      return new Response(JSON.stringify({ records: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const call = credentialCall('https://host.test/', credential, DID, fetchImpl);
    await call('GET', 'com.atproto.space.listRecords?space=x');

    expect(seenHeaders.authorization).toBe('Atproto-Space cred-1');
    expect(seenHeaders['atproto-space-audience']).toBe(DID);
    expect(verifySignatureHeaders(seenHeaders, credential.key.did)).toBe(true);
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
      await generateSpaceSigningKey(),
      Date.now() + 60_000
    );

    const deniedError = await credentialCall(
      'https://host.test',
      credential,
      DID,
      denied
    )('GET', 'com.atproto.space.listRecords?space=x').catch((e) => e);
    expect(isSpaceAccessDenied(deniedError)).toBe(true);
    expect(isSpaceNotFound(deniedError)).toBe(false);

    const missingError = await credentialCall(
      'https://host.test',
      credential,
      DID,
      missing
    )('GET', 'com.atproto.simplespace.getSpace?space=x').catch((e) => e);
    expect(isSpaceNotFound(missingError)).toBe(true);
  });
});
