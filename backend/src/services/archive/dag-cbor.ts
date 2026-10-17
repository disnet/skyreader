// The DAG-CBOR encoding and CID of an atproto record, so a D1 row can carry the
// content hash its record will have once it's written to a repo or space.
//
// Only the slice of DAG-CBOR the atproto data model needs: maps with string keys,
// arrays, strings, safe integers, booleans, null, and bytes. Floats are not part
// of the data model, so a non-integer number throws rather than encoding as a
// float a PDS would reject. A string with a lone surrogate has no UTF-8 form, so
// it throws rather than hashing as U+FFFD text it isn't. Map keys sort by encoded length, then bytewise, as
// DAG-CBOR requires; an `undefined` value is dropped, like an absent field.
//
// Cross-checked against @ipld/dag-cbor + multiformats in
// backend/test/archive-records.spec.ts. See docs/plans/ARCHIVE_RECORDS.md.

const utf8 = new TextEncoder();

export type CborValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | CborValue[]
  | { [key: string]: CborValue | undefined };

class Writer {
  private chunks: Uint8Array[] = [];
  private length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  head(major: number, value: number): void {
    const m = major << 5;
    if (value < 24) {
      this.push(Uint8Array.of(m | value));
    } else if (value < 0x100) {
      this.push(Uint8Array.of(m | 24, value));
    } else if (value < 0x10000) {
      this.push(Uint8Array.of(m | 25, value >> 8, value & 0xff));
    } else if (value < 0x100000000) {
      const out = new Uint8Array(5);
      out[0] = m | 26;
      new DataView(out.buffer).setUint32(1, value);
      this.push(out);
    } else {
      const out = new Uint8Array(9);
      out[0] = m | 27;
      new DataView(out.buffer).setBigUint64(1, BigInt(value));
      this.push(out);
    }
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

function compareKeys(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function encodeString(value: string): Uint8Array {
  if (!value.isWellFormed()) throw new TypeError('DAG-CBOR: string has a lone surrogate');
  return utf8.encode(value);
}

function write(w: Writer, value: CborValue): void {
  if (value === null) {
    w.push(Uint8Array.of(0xf6));
  } else if (value === true) {
    w.push(Uint8Array.of(0xf5));
  } else if (value === false) {
    w.push(Uint8Array.of(0xf4));
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`DAG-CBOR: ${value} is not a safe integer (atproto has no floats)`);
    }
    if (value >= 0) w.head(0, value);
    else w.head(1, -1 - value);
  } else if (typeof value === 'string') {
    const bytes = encodeString(value);
    w.head(3, bytes.length);
    w.push(bytes);
  } else if (value instanceof Uint8Array) {
    w.head(2, value.length);
    w.push(value);
  } else if (Array.isArray(value)) {
    w.head(4, value.length);
    for (const item of value) write(w, item);
  } else if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter((entry): entry is [string, CborValue] => entry[1] !== undefined)
      .map(([key, item]) => ({ key: encodeString(key), item }))
      .sort((a, b) => compareKeys(a.key, b.key));
    w.head(5, entries.length);
    for (const { key, item } of entries) {
      w.head(3, key.length);
      w.push(key);
      write(w, item);
    }
  } else {
    throw new TypeError(`DAG-CBOR: cannot encode ${typeof value}`);
  }
}

export function encodeDagCbor(value: CborValue): Uint8Array {
  const w = new Writer();
  write(w, value);
  return w.bytes();
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * The CIDv1 (dag-cbor, sha2-256, base32) of a record: the `cid` a PDS would
 * report for it. Two records with the same content share a CID wherever they live.
 */
export async function recordCid(record: CborValue): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encodeDagCbor(record)));
  const cid = new Uint8Array(4 + digest.length);
  cid.set([0x01, 0x71, 0x12, 0x20]);
  cid.set(digest, 4);
  return 'b' + base32(cid);
}
