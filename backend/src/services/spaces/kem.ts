/**
 * Shared-secret MACs for reading a space repo with a credential.
 *
 * Since `0.0.0-spaces-alpha-20261022141228` (atproto PR #5706) a space repo's
 * commits and records carry no signature. A reader holding a space credential
 * must send `Atproto-Space-Want-Mac` on every method that returns a commit or a
 * record (getRecord, getRepo, getLatestCommit, listRepoOps); the repo host
 * answers with an HMAC in `Atproto-Space-Mac`, keyed by a per-request secret
 * negotiated against the author's `#atproto_kem` DID-doc key. listRecords is not
 * one of those methods and needs no header.
 *
 * The negotiation is RFC 9180's DHKEM(P-256, HKDF-SHA256) `ExtractAndExpand`:
 * a fresh ephemeral P-256 key per request, ECDH against the author's KEM key,
 * then HKDF with the RFC's labels. Ported from `@atproto/space`
 * `dist/{kem,mac}.js` at that version and cross-checked against it.
 *
 * Only the record MAC is implemented: getRecord is the one MAC-bearing method
 * the spike calls with a credential.
 */

import { p256 } from '@noble/curves/nist.js';
import { CID } from 'multiformats/cid';
import { p256DidKey } from './http-signature';

export const WANT_MAC_HEADER = 'atproto-space-want-mac';
export const MAC_HEADER = 'atproto-space-mac';
export const RECORD_MAC_TYPE = 'atproto-space-record';
export const RECORD_MAC_VERSION = 1;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const encoder = new TextEncoder();

export interface Encapsulation {
  /** The ephemeral public key, as a P-256 `did:key`, sent in the request header. */
  keyShare: string;
  /** 32 bytes; keys the MAC the host returns. Never leaves the reader. */
  sharedSecret: Uint8Array;
}

/** Derive a one-request shared secret against the author's `#atproto_kem` key. */
export async function encapsulate(authorKemKey: string): Promise<Encapsulation> {
  const authorKey = p256DidKeyBytes(authorKemKey);
  const ephemeral = p256.utils.randomSecretKey();
  const ephemeralPub = p256.getPublicKey(ephemeral, false);
  const dh = p256.getSharedSecret(ephemeral, authorKey, true).slice(1);
  const authorUncompressed = p256.Point.fromBytes(authorKey).toBytes(false);
  return {
    keyShare: p256DidKey(ephemeralPub),
    sharedSecret: await deriveSharedSecret(dh, ephemeralPub, authorUncompressed),
  };
}

// RFC 9180 labels. 0x0010 identifies DHKEM(P-256, HKDF-SHA256).
const KEM_PREFIX = concat(encoder.encode('HPKE-v1'), encoder.encode('KEM'), uint16be(0x0010));

async function deriveSharedSecret(
  dh: Uint8Array,
  readerKey: Uint8Array,
  authorKey: Uint8Array
): Promise<Uint8Array> {
  const ikm = concat(KEM_PREFIX, encoder.encode('eae_prk'), dh);
  const info = concat(
    uint16be(32),
    KEM_PREFIX,
    encoder.encode('shared_secret'),
    readerKey,
    authorKey
  );
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    key,
    256
  );
  return new Uint8Array(bits);
}

/** `type="atproto-space-record", ver=1, key_share="did:key:…"` */
export function formatWantRecordMacHeader(keyShare: string): string {
  return `type="${RECORD_MAC_TYPE}", ver=${RECORD_MAC_VERSION}, key_share="${keyShare}"`;
}

/**
 * Check a record response's `Atproto-Space-Mac` against the secret this request
 * negotiated. `uri` and `cid` are the response body's own.
 *
 *   mac = HMAC-SHA256(secret, "atproto-space-record-v1" || u16be(len(uri)) || uri || cid_bytes)
 */
export async function verifyRecordMac(
  sharedSecret: Uint8Array,
  header: string | null,
  uri: string,
  cid: string
): Promise<boolean> {
  const mac = parseRecordMacHeader(header);
  if (!mac) return false;
  let cidBytes: Uint8Array;
  try {
    cidBytes = CID.parse(cid).bytes;
  } catch {
    return false;
  }
  const uriBytes = encoder.encode(uri);
  const data = concat(
    encoder.encode(`${RECORD_MAC_TYPE}-v${RECORD_MAC_VERSION}`),
    uint16be(uriBytes.length),
    uriBytes,
    cidBytes
  );
  const key = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify('HMAC', key, mac, data);
}

/** The `mac` byte sequence out of a record MAC header, or null if it isn't one. */
function parseRecordMacHeader(header: string | null): Uint8Array | null {
  if (!header) return null;
  const fields = new Map<string, string>();
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  if (fields.get('type') !== `"${RECORD_MAC_TYPE}"`) return null;
  if (fields.get('ver') !== String(RECORD_MAC_VERSION)) return null;
  const mac = /^:([A-Za-z0-9+/]+={0,2}):$/.exec(fields.get('mac') ?? '');
  if (!mac) return null;
  try {
    return Uint8Array.from(atob(mac[1]), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Compressed P-256 public key out of a `did:key`. */
function p256DidKeyBytes(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) throw new Error('KEM key must be a did:key');
  let n = 0n;
  for (const c of did.slice('did:key:z'.length)) {
    const digit = BASE58_ALPHABET.indexOf(c);
    if (digit < 0) throw new Error('KEM key is not base58btc');
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // multicodec p256-pub (0x1200) varint, then the 33-byte compressed point.
  if (bytes.length !== 35 || bytes[0] !== 0x80 || bytes[1] !== 0x24) {
    throw new Error('KEM key must be a P-256 did:key');
  }
  return Uint8Array.from(bytes.slice(2));
}

function uint16be(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((len, p) => len + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
