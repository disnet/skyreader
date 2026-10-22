import { describe, it, expect } from 'vitest';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import {
  encapsulate,
  formatWantRecordMacHeader,
  verifyRecordMac,
} from '../src/services/spaces/kem';
import { generateSpaceSigningKey } from '../src/services/spaces/http-signature';
import { SpaceCredential } from '../src/services/spaces/credential';
import { SpacesClient } from '../src/services/spaces/client';
import { credentialCall } from '../src/services/spaces/transport';
import { SAVED_COLLECTION, savedSpaceRef, spaceRecordUri } from '../src/services/spaces/refs';
import { recordCid } from '../src/services/archive/dag-cbor';

// The record-MAC handshake a credentialed getRecord needs since
// 0.0.0-spaces-alpha-20261022141228. The repo-host side below is written against
// @noble/hashes rather than WebCrypto, so it is an independent implementation,
// and VECTOR pins it to what @atproto/space's own `decapsulate` and
// `computeRecordMac` produce at that version.

const VECTOR = {
  authorPrivateKey: '11'.repeat(32),
  authorKem: 'did:key:zDnaeQa8zprPhHA7Yuxcgc2Uh6XNQgaKjmFZE4EaA9fk5svmJ',
  // The did:key of private key 0x22…22.
  keyShare: 'did:key:zDnaex62me84JZnkEzmeYRa8FCLNe7y1asoSwBMK26GBYpL7c',
  secret: '76bccf1264f5f7f5b7df0b78b6c1037f2e22fb513288207ad2dede881710d4c3',
  macHeader:
    'type="atproto-space-record", ver=1, mac=:NAJ+eVEWosQhsPepqtY4zoANRRgnsnpHNJiZy2lKdSw=:',
  uri: 'ats://did:plc:spaceproto/space/app.skyreader.space.saved/self/app.skyreader.feed.saved/3kabc',
  cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
};

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const enc = new TextEncoder();

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function didKeyPoint(did: string): Uint8Array {
  let n = 0n;
  for (const c of did.slice('did:key:z'.length)) n = n * 58n + BigInt(BASE58.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from(bytes.slice(2));
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Repo-host side: the author's KEM private key plus the reader's key share. */
function decapsulate(authorPrivateKey: Uint8Array, keyShare: string): Uint8Array {
  const reader = p256.Point.fromBytes(didKeyPoint(keyShare)).toBytes(false);
  const author = p256.getPublicKey(authorPrivateKey, false);
  const dh = p256.getSharedSecret(authorPrivateKey, reader, true).slice(1);
  const prefix = cat(enc.encode('HPKE-v1'), enc.encode('KEM'), new Uint8Array([0x00, 0x10]));
  return hkdf(
    sha256,
    cat(prefix, enc.encode('eae_prk'), dh),
    new Uint8Array(0),
    cat(new Uint8Array([0x00, 0x20]), prefix, enc.encode('shared_secret'), reader, author),
    32
  );
}

function recordMacHeader(secret: Uint8Array, uri: string, cid: string): string {
  const uriBytes = enc.encode(uri);
  const mac = hmac(
    sha256,
    secret,
    cat(
      enc.encode('atproto-space-record-v1'),
      new Uint8Array([uriBytes.length >> 8, uriBytes.length & 0xff]),
      uriBytes,
      CID.parse(cid).bytes
    )
  );
  return `type="atproto-space-record", ver=1, mac=:${btoa(String.fromCharCode(...mac))}:`;
}

describe('space record MACs', () => {
  it('the test host matches @atproto/space on a fixed vector', () => {
    const secret = decapsulate(hexBytes(VECTOR.authorPrivateKey), VECTOR.keyShare);
    expect(toHex(secret)).toBe(VECTOR.secret);
    expect(recordMacHeader(secret, VECTOR.uri, VECTOR.cid)).toBe(VECTOR.macHeader);
  });

  it('accepts the alpha’s MAC header and rejects one for another record', async () => {
    const secret = hexBytes(VECTOR.secret);
    expect(await verifyRecordMac(secret, VECTOR.macHeader, VECTOR.uri, VECTOR.cid)).toBe(true);
    expect(await verifyRecordMac(secret, VECTOR.macHeader, `${VECTOR.uri}x`, VECTOR.cid)).toBe(
      false
    );
    expect(
      await verifyRecordMac(
        secret,
        VECTOR.macHeader,
        VECTOR.uri,
        'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a'
      )
    ).toBe(false);
    expect(
      await verifyRecordMac(
        secret,
        VECTOR.macHeader.replace('atproto-space-record', 'atproto-space-repo'),
        VECTOR.uri,
        VECTOR.cid
      )
    ).toBe(false);
    expect(await verifyRecordMac(secret, null, VECTOR.uri, VECTOR.cid)).toBe(false);
  });

  it('negotiates the secret the repo host derives', async () => {
    const { keyShare, sharedSecret } = await encapsulate(VECTOR.authorKem);
    expect(keyShare).toMatch(/^did:key:zDn/);
    expect(toHex(sharedSecret)).toBe(
      toHex(decapsulate(hexBytes(VECTOR.authorPrivateKey), keyShare))
    );
    // A fresh ephemeral key, so a fresh secret, every request.
    expect((await encapsulate(VECTOR.authorKem)).keyShare).not.toBe(keyShare);
    expect(formatWantRecordMacHeader(keyShare)).toBe(
      `type="atproto-space-record", ver=1, key_share="${keyShare}"`
    );
  });

  it('a credentialed getRecord accepts only the requested record, MAC-verified, its value matching its cid', async () => {
    const credential = new SpaceCredential(
      'cred-1',
      await generateSpaceSigningKey(),
      Date.now() + 60_000
    );
    const repo = 'did:plc:spaceproto';
    const read = { space: savedSpaceRef(repo), repo, collection: SAVED_COLLECTION, rkey: '3kabc' };
    const uri = spaceRecordUri(read.space, repo, read.collection, read.rkey);
    const value = { $type: SAVED_COLLECTION, url: 'https://example.com/a', wordCount: 12 };
    const cid = await recordCid(value);

    // How the host misbehaves, per case: the honest answer, then each attack.
    let respond = (secret: Uint8Array) => ({
      uri,
      cid,
      value,
      mac: recordMacHeader(secret, uri, cid),
    });
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const want = (init!.headers as Record<string, string>)['atproto-space-want-mac'];
      const keyShare = /key_share="([^"]+)"/.exec(want)![1];
      const { mac, ...body } = respond(decapsulate(hexBytes(VECTOR.authorPrivateKey), keyShare));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'atproto-space-mac': mac },
      });
    }) as unknown as typeof fetch;

    const client = new SpacesClient(
      credentialCall('https://host.test', credential, repo, {
        authorKemKey: VECTOR.authorKem,
        fetchImpl,
      })
    );
    expect((await client.getRecord(read)).value).toEqual(value);

    const attacks: Array<(secret: Uint8Array) => ReturnType<typeof respond>> = [
      // A MAC over some other record, under the right secret.
      (secret) => ({ uri, cid, value, mac: recordMacHeader(secret, `${uri}x`, cid) }),
      // The real uri, cid and MAC, with the value swapped out.
      (secret) => ({
        uri,
        cid,
        value: { ...value, url: 'https://evil.test' },
        mac: recordMacHeader(secret, uri, cid),
      }),
      // A different record, correctly MAC'd, in place of the one asked for.
      (secret) => {
        const other = `${read.space}/${repo}/${read.collection}/OTHER`;
        return { uri: other, cid, value, mac: recordMacHeader(secret, other, cid) };
      },
    ];
    for (const attack of attacks) {
      respond = attack;
      const error = await client.getRecord(read).catch((e) => e);
      expect(error).toMatchObject({ code: 'BadSpaceMac' });
    }

    // No KEM key: refused here, never sent unauthenticated.
    const keyless = new SpacesClient(
      credentialCall('https://host.test', credential, repo, { fetchImpl })
    );
    expect(await keyless.getRecord(read).catch((e) => e)).toMatchObject({ code: 'KemKeyRequired' });
  });
});
