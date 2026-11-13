/**
 * Shared-secret MACs for reading a space repo with a credential.
 *
 * Since `0.0.0-spaces-alpha-20261022141228` (atproto PR #5706) a space repo's
 * commits and records carry no signature. A reader holding a space credential
 * asks for a MAC on every method that returns a commit or a record (getRecord,
 * getRepo, getLatestCommit, listRepoOps), keyed by a per-request secret
 * negotiated against the author's `#atproto_kem` DID-doc key. listRecords is not
 * one of those methods and needs no MAC.
 *
 * Since `0.0.0-spaces-alpha-20261112204144` (atproto PRs #5862 and #5865):
 *
 *   - The secret is RFC 9180 HPKE secret export, base mode, DHKEM(P-256,
 *     HKDF-SHA256) / HKDF-SHA256 / Export-only AEAD, `info = "atproto-mac"`,
 *     empty exporter context, L = 32. Before, it was the bare KEM shared secret.
 *   - The MAC is an RFC 9421 HTTP message signature using `hmac-sha256`. The
 *     reader asks for it with `Accept-Signature` (it was `Atproto-Space-Want-Mac`):
 *
 *       Accept-Signature: mac=("atproto-space-record";sf);keyid="did:key:…";tag="atproto-space-record"
 *
 *     and the host answers with an `Atproto-Space-Record: uri="…", cid="…"`
 *     header, plus `Signature-Input` / `Signature` covering it under the label
 *     the reader asked for (it was one `Atproto-Space-Mac` header). A verifier
 *     finds the MAC by its `tag`, not its label.
 *
 * Ported from `@atproto/space@0.0.0-spaces-alpha-20261112204144`
 * (`dist/{kem,mac,http-signature}.js`); `test/spaces-kem.spec.ts` pins a vector
 * those functions produced.
 *
 * Only the record MAC is implemented: getRecord is the one MAC-bearing method
 * the spike calls with a credential.
 */

import { p256 } from '@noble/curves/nist.js';
import {
  isByteSequence,
  isInnerList,
  parseDictionary,
  serializeDictionary,
  serializeInnerList,
  type Dictionary,
  type InnerList,
} from 'structured-headers';
import { p256DidKey } from './http-signature';

export const RECORD_MAC_PROFILE = 'atproto-space-record';
/** The response header a record MAC covers. */
export const RECORD_MAC_HEADER = 'atproto-space-record';
export const ACCEPT_SIGNATURE_HEADER = 'accept-signature';
const MAC_ALG = 'hmac-sha256';
/** The label this reader asks for its MAC under; the host answers under it. */
const MAC_LABEL = 'mac';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const encoder = new TextEncoder();

export interface Encapsulation {
  /** The ephemeral public key, as a P-256 `did:key`: the request's `keyid`. */
  keyShare: string;
  /** 32 bytes; keys the MAC the host returns. Never leaves the reader. */
  sharedSecret: Uint8Array;
}

/** Derive a one-request shared secret against the author's `#atproto_kem` key. */
export async function encapsulate(authorKemKey: string): Promise<Encapsulation> {
  const authorKey = p256DidKeyBytes(authorKemKey);
  const ephemeral = p256.utils.randomSecretKey();
  return encapsulateWith(ephemeral, authorKey);
}

/** `encapsulate` with a given ephemeral private key. Exported for the fixed test vector. */
export async function encapsulateWith(
  ephemeralPrivateKey: Uint8Array,
  authorKey: Uint8Array
): Promise<Encapsulation> {
  const ephemeralPub = p256.getPublicKey(ephemeralPrivateKey, false);
  const dh = p256.getSharedSecret(ephemeralPrivateKey, authorKey, true).slice(1);
  const authorUncompressed = p256.Point.fromBytes(authorKey).toBytes(false);
  return {
    keyShare: p256DidKey(ephemeralPub),
    sharedSecret: await deriveSharedSecret(dh, ephemeralPub, authorUncompressed),
  };
}

// RFC 9180 suite IDs: 0x0010 is DHKEM(P-256, HKDF-SHA256), 0x0001 HKDF-SHA256,
// 0xffff the Export-only AEAD.
const HPKE_VERSION = encoder.encode('HPKE-v1');
const KEM_ID = concat(encoder.encode('KEM'), uint16be(0x0010));
const SUITE_ID = concat(
  encoder.encode('HPKE'),
  uint16be(0x0010),
  uint16be(0x0001),
  uint16be(0xffff)
);
const HPKE_INFO = encoder.encode('atproto-mac');
const MODE_BASE = new Uint8Array([0x00]);
const EMPTY = new Uint8Array(0);

/** HPKE SetupBaseS, then Export(exporter_context = "", L = 32). */
async function deriveSharedSecret(
  dh: Uint8Array,
  enc: Uint8Array,
  authorKey: Uint8Array
): Promise<Uint8Array> {
  const eaePrk = await labeledExtract(KEM_ID, EMPTY, 'eae_prk', dh);
  const kemSecret = await labeledExpand(KEM_ID, eaePrk, 'shared_secret', concat(enc, authorKey));
  const pskIdHash = await labeledExtract(SUITE_ID, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = await labeledExtract(SUITE_ID, EMPTY, 'info_hash', HPKE_INFO);
  const context = concat(MODE_BASE, pskIdHash, infoHash);
  const secret = await labeledExtract(SUITE_ID, kemSecret, 'secret', EMPTY);
  const exporterSecret = await labeledExpand(SUITE_ID, secret, 'exp', context);
  return labeledExpand(SUITE_ID, exporterSecret, 'sec', EMPTY);
}

function labeledExtract(
  id: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array
): Promise<Uint8Array> {
  // HKDF-Extract: an empty salt is HashLen zero bytes (RFC 5869 §2.2).
  return hmacSha256(
    salt.length ? salt : new Uint8Array(32),
    concat(HPKE_VERSION, id, encoder.encode(label), ikm)
  );
}

/** HKDF-Expand to 32 bytes, which is one HMAC block: T(1) = HMAC(prk, info || 0x01). */
function labeledExpand(
  id: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array
): Promise<Uint8Array> {
  const labeledInfo = concat(uint16be(32), HPKE_VERSION, id, encoder.encode(label), info);
  return hmacSha256(prk, concat(labeledInfo, new Uint8Array([0x01])));
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/**
 * The `Accept-Signature` value asking for a record MAC keyed for `keyShare`:
 * `mac=("atproto-space-record";sf);keyid="did:key:…";tag="atproto-space-record"`
 */
export function formatRecordMacRequest(keyShare: string): string {
  return `${MAC_LABEL}=${serializeInnerList(recordMacParams(keyShare))}`;
}

function recordMacParams(keyShare: string): InnerList {
  return [
    [[RECORD_MAC_HEADER, new Map([['sf', true]])]],
    new Map([
      ['keyid', keyShare],
      ['tag', RECORD_MAC_PROFILE],
    ]),
  ];
}

/**
 * Check a record response's MAC against the secret this request negotiated,
 * and that the `Atproto-Space-Record` header it covers names `uri` and `cid`
 * (the response body's own). As `@atproto/space`'s `verifyRecordMac`: exactly
 * one signature tagged `atproto-space-record`, covering exactly that header
 * (`sf`), with `alg`, if given, `hmac-sha256` and `keyid`, if given, this
 * request's key share.
 */
export async function verifyRecordMac(
  encapsulation: Encapsulation,
  headers: Headers,
  uri: string,
  cid: string
): Promise<boolean> {
  const inputs = parseField(headers.get('signature-input'));
  const signatures = parseField(headers.get('signature'));
  const covered = parseField(headers.get(RECORD_MAC_HEADER));
  if (!inputs || !signatures || !covered) return false;

  const tagged = [...inputs].filter(
    ([, member]) => isInnerList(member) && member[1].get('tag') === RECORD_MAC_PROFILE
  );
  if (tagged.length !== 1) return false;
  const [label, member] = tagged[0];
  const [components, params] = member as InnerList;
  if (
    components.length !== 1 ||
    components[0][0] !== RECORD_MAC_HEADER ||
    components[0][1].size !== 1 ||
    components[0][1].get('sf') !== true
  ) {
    return false;
  }
  if (params.has('alg') && params.get('alg') !== MAC_ALG) return false;
  if (params.has('keyid') && params.get('keyid') !== encapsulation.keyShare) return false;

  const signature = signatures.get(label);
  if (
    !signature ||
    isInnerList(signature) ||
    !isByteSequence(signature[0]) ||
    signature[1].size !== 0
  ) {
    return false;
  }
  let mac: Uint8Array;
  try {
    mac = Uint8Array.from(atob(signature[0].toBase64()), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }

  // The `sf` flag covers the header as re-serialized from its parsed form.
  const base = encoder.encode(
    `"${RECORD_MAC_HEADER}";sf: ${serializeDictionary(covered)}\n` +
      `"@signature-params": ${serializeInnerList(member as InnerList)}`
  );
  const key = await crypto.subtle.importKey(
    'raw',
    encapsulation.sharedSecret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  if (!(await crypto.subtle.verify('HMAC', key, mac, base))) return false;
  return bareItem(covered, 'uri') === uri && bareItem(covered, 'cid') === cid;
}

function parseField(value: string | null): Dictionary | null {
  if (!value) return null;
  try {
    return parseDictionary(value);
  } catch {
    return null;
  }
}

function bareItem(fields: Dictionary, key: string): unknown {
  const member = fields.get(key);
  return member && !isInnerList(member) ? member[0] : undefined;
}

/** Compressed P-256 public key out of a `did:key`. */
export function p256DidKeyBytes(did: string): Uint8Array {
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
