import { describe, it, expect } from 'vitest';
import { p256 } from '@noble/curves/nist.js';
import { extract, expand } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  encapsulate,
  encapsulateWith,
  formatRecordMacRequest,
  p256DidKeyBytes,
  verifyRecordMac,
} from '../src/services/spaces/kem';
import { generateSpaceSigningKey } from '../src/services/spaces/http-signature';
import { SpaceCredential } from '../src/services/spaces/credential';
import { SpacesClient } from '../src/services/spaces/client';
import { credentialCall } from '../src/services/spaces/transport';
import { SAVED_COLLECTION, savedSpaceRef, spaceRecordUri } from '../src/services/spaces/refs';
import { recordCid } from '../src/services/archive/dag-cbor';

// The record-MAC handshake a credentialed getRecord needs, as of
// 0.0.0-spaces-alpha-20261112204144: an HPKE-exported secret, asked for with
// `Accept-Signature`, answered with an RFC 9421 hmac-sha256 signature over an
// `Atproto-Space-Record` header. The repo-host side below is written against
// @noble/hashes and plain strings rather than WebCrypto and structured-headers,
// so it is an independent implementation, and VECTOR pins both to what
// @atproto/space's own `decapsulate`, `formatMacRequest` and
// `createRecordMacHeaders` produce at that version.

const VECTOR = {
  authorPrivateKey: '11'.repeat(32),
  authorKem: 'did:key:zDnaeQa8zprPhHA7Yuxcgc2Uh6XNQgaKjmFZE4EaA9fk5svmJ',
  // The did:key of private key 0x22…22.
  readerPrivateKey: '22'.repeat(32),
  keyShare: 'did:key:zDnaex62me84JZnkEzmeYRa8FCLNe7y1asoSwBMK26GBYpL7c',
  secret: '19ac581c03a25905d77bbcad0b8f9b3eca96089a62b7e7d2984a502a913516d1',
  request:
    'mac=("atproto-space-record";sf);keyid="did:key:zDnaex62me84JZnkEzmeYRa8FCLNe7y1asoSwBMK26GBYpL7c";tag="atproto-space-record"',
  uri: 'at://did:plc:spaceproto/space/app.skyreader.space.saved/self/did:plc:spaceproto/app.skyreader.feed.saved/3kabc',
  cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
  headers: {
    'atproto-space-record':
      'uri="at://did:plc:spaceproto/space/app.skyreader.space.saved/self/did:plc:spaceproto/app.skyreader.feed.saved/3kabc", cid="bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm"',
    'signature-input':
      'mac=("atproto-space-record";sf);keyid="did:key:zDnaex62me84JZnkEzmeYRa8FCLNe7y1asoSwBMK26GBYpL7c";tag="atproto-space-record"',
    signature: 'mac=:ncw+wBv2k0u6IWVo9Uyx58bJ5Esf7dDwy3hSawTIyag=:',
  },
};

const enc = new TextEncoder();

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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

const u16 = (n: number) => new Uint8Array([n >> 8, n & 0xff]);
const KEM_ID = cat(enc.encode('KEM'), u16(0x0010));
const SUITE_ID = cat(enc.encode('HPKE'), u16(0x0010), u16(0x0001), u16(0xffff));
const EMPTY = new Uint8Array(0);
const lExtract = (id: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  extract(sha256, cat(enc.encode('HPKE-v1'), id, enc.encode(label), ikm), salt);
const lExpand = (id: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array) =>
  expand(sha256, prk, cat(u16(32), enc.encode('HPKE-v1'), id, enc.encode(label), info), 32);

/** Repo-host side (RFC 9180 ReceiveExportBase): the author's KEM private key plus the key share. */
function decapsulate(authorPrivateKey: Uint8Array, keyShare: string): Uint8Array {
  const reader = p256.Point.fromBytes(p256DidKeyBytes(keyShare)).toBytes(false);
  const author = p256.getPublicKey(authorPrivateKey, false);
  const dh = p256.getSharedSecret(authorPrivateKey, reader, true).slice(1);
  const kemSecret = lExpand(
    KEM_ID,
    lExtract(KEM_ID, EMPTY, 'eae_prk', dh),
    'shared_secret',
    cat(reader, author)
  );
  const context = cat(
    new Uint8Array([0]),
    lExtract(SUITE_ID, EMPTY, 'psk_id_hash', EMPTY),
    lExtract(SUITE_ID, EMPTY, 'info_hash', enc.encode('atproto-mac'))
  );
  const exporter = lExpand(
    SUITE_ID,
    lExtract(SUITE_ID, kemSecret, 'secret', EMPTY),
    'exp',
    context
  );
  return lExpand(SUITE_ID, exporter, 'sec', EMPTY);
}

/** Repo-host side of the response: the covered header and a MAC over it, under `label`. */
function recordMacHeaders(
  secret: Uint8Array,
  keyShare: string,
  uri: string,
  cid: string,
  label = 'mac'
): Record<string, string> {
  const record = `uri="${uri}", cid="${cid}"`;
  const params = `("atproto-space-record";sf);keyid="${keyShare}";tag="atproto-space-record"`;
  const base = `"atproto-space-record";sf: ${record}\n"@signature-params": ${params}`;
  const mac = hmac(sha256, secret, enc.encode(base));
  return {
    'atproto-space-record': record,
    'signature-input': `${label}=${params}`,
    signature: `${label}=:${btoa(String.fromCharCode(...mac))}:`,
  };
}

describe('space record MACs', () => {
  it('the test host matches @atproto/space on a fixed vector', async () => {
    const secret = decapsulate(hexBytes(VECTOR.authorPrivateKey), VECTOR.keyShare);
    expect(toHex(secret)).toBe(VECTOR.secret);
    expect(recordMacHeaders(secret, VECTOR.keyShare, VECTOR.uri, VECTOR.cid)).toEqual(
      VECTOR.headers
    );
    // And the reader side derives the same secret from the same ephemeral key.
    const reader = await encapsulateWith(
      hexBytes(VECTOR.readerPrivateKey),
      p256DidKeyBytes(VECTOR.authorKem)
    );
    expect(reader.keyShare).toBe(VECTOR.keyShare);
    expect(toHex(reader.sharedSecret)).toBe(VECTOR.secret);
    expect(formatRecordMacRequest(VECTOR.keyShare)).toBe(VECTOR.request);
  });

  it('accepts the alpha’s MAC headers and rejects tampered or mismatched ones', async () => {
    const e = { keyShare: VECTOR.keyShare, sharedSecret: hexBytes(VECTOR.secret) };
    const verify = (headers: Record<string, string>, uri = VECTOR.uri, cid = VECTOR.cid) =>
      verifyRecordMac(e, new Headers(headers), uri, cid);
    expect(await verify(VECTOR.headers)).toBe(true);
    // Any label: the MAC is found by its tag.
    expect(
      await verify(recordMacHeaders(e.sharedSecret, e.keyShare, VECTOR.uri, VECTOR.cid, 'other'))
    ).toBe(true);
    // Another record than the body's.
    expect(await verify(VECTOR.headers, `${VECTOR.uri}x`)).toBe(false);
    expect(
      await verify(
        VECTOR.headers,
        VECTOR.uri,
        'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a'
      )
    ).toBe(false);
    // The covered header edited after signing.
    expect(
      await verify({
        ...VECTOR.headers,
        'atproto-space-record': VECTOR.headers['atproto-space-record'].replace('3kabc', '3kabd'),
      })
    ).toBe(false);
    // Another key share than this request's.
    expect(
      await verify({
        ...VECTOR.headers,
        'signature-input': VECTOR.headers['signature-input'].replace(
          VECTOR.keyShare,
          VECTOR.authorKem
        ),
      })
    ).toBe(false);
    // The commit profile's tag, a second record MAC, or a wrong algorithm.
    expect(
      await verify({
        ...VECTOR.headers,
        'signature-input': VECTOR.headers['signature-input'].replace(
          'tag="atproto-space-record"',
          'tag="atproto-space-commit"'
        ),
      })
    ).toBe(false);
    expect(
      await verify({
        ...VECTOR.headers,
        'signature-input': `${VECTOR.headers['signature-input']}, m2=${VECTOR.headers['signature-input'].slice(4)}`,
      })
    ).toBe(false);
    expect(
      await verify({
        ...VECTOR.headers,
        'signature-input': `${VECTOR.headers['signature-input']};alg="ecdsa-p256-sha256"`,
      })
    ).toBe(false);
    // Missing pieces.
    expect(await verify({ ...VECTOR.headers, signature: '' })).toBe(false);
    const { 'atproto-space-record': _covered, ...uncovered } = VECTOR.headers;
    expect(await verify(uncovered)).toBe(false);
  });

  it('negotiates the secret the repo host derives', async () => {
    const { keyShare, sharedSecret } = await encapsulate(VECTOR.authorKem);
    expect(keyShare).toMatch(/^did:key:zDn/);
    expect(toHex(sharedSecret)).toBe(
      toHex(decapsulate(hexBytes(VECTOR.authorPrivateKey), keyShare))
    );
    // A fresh ephemeral key, so a fresh secret, every request.
    expect((await encapsulate(VECTOR.authorKem)).keyShare).not.toBe(keyShare);
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
    type Answer = { uri: string; cid: string; value: unknown; mac: Record<string, string> };
    let respond = (secret: Uint8Array, keyShare: string): Answer => ({
      uri,
      cid,
      value,
      mac: recordMacHeaders(secret, keyShare, uri, cid),
    });
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const want = (init!.headers as Record<string, string>)['accept-signature'];
      expect(want).toMatch(
        /^mac=\("atproto-space-record";sf\);keyid="did:key:[^"]+";tag="atproto-space-record"$/
      );
      const keyShare = /keyid="([^"]+)"/.exec(want)![1];
      const { mac, ...body } = respond(
        decapsulate(hexBytes(VECTOR.authorPrivateKey), keyShare),
        keyShare
      );
      return new Response(JSON.stringify(body), { status: 200, headers: mac });
    }) as unknown as typeof fetch;

    const client = new SpacesClient(
      credentialCall('https://host.test', credential, repo, {
        authorKemKey: VECTOR.authorKem,
        fetchImpl,
      })
    );
    expect((await client.getRecord(read)).value).toEqual(value);

    const attacks: Array<(secret: Uint8Array, keyShare: string) => Answer> = [
      // A MAC over some other record, under the right secret.
      (secret, keyShare) => ({
        uri,
        cid,
        value,
        mac: recordMacHeaders(secret, keyShare, `${uri}x`, cid),
      }),
      // The real uri, cid and MAC, with the value swapped out.
      (secret, keyShare) => ({
        uri,
        cid,
        value: { ...value, url: 'https://evil.test' },
        mac: recordMacHeaders(secret, keyShare, uri, cid),
      }),
      // A different record, correctly MAC'd, in place of the one asked for.
      (secret, keyShare) => {
        const other = `${read.space}/${repo}/${read.collection}/OTHER`;
        return { uri: other, cid, value, mac: recordMacHeaders(secret, keyShare, other, cid) };
      },
      // The right record under a secret this request didn't negotiate.
      (_secret, keyShare) => ({
        uri,
        cid,
        value,
        mac: recordMacHeaders(hexBytes(VECTOR.secret), keyShare, uri, cid),
      }),
    ];
    for (const attack of attacks) {
      respond = attack;
      const error = await client.getRecord(read).catch((e) => e);
      expect(error).toMatchObject({ code: 'InvalidSpaceMac' });
    }

    // No KEM key: refused here, never sent unauthenticated.
    const keyless = new SpacesClient(
      credentialCall('https://host.test', credential, repo, { fetchImpl })
    );
    expect(await keyless.getRecord(read).catch((e) => e)).toMatchObject({ code: 'KemKeyRequired' });
  });
});
