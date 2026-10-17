// The DAG-CBOR encoding and CID of an atproto record, so a D1 row can carry the
// content hash its record will have once it's written to a repo or space.
//
// The encoding is @ipld/dag-cbor's and the CID multiformats'. What this adds is
// the atproto data model on top: floats are not part of it, so a non-integer
// number throws rather than encoding as a float a PDS would reject. A string with
// a lone surrogate has no UTF-8 form, so it throws rather than hashing as U+FFFD
// text it isn't. An `undefined` value is dropped, like an absent field (the
// library refuses one). See docs/plans/ARCHIVE_RECORDS.md.

import * as dagCbor from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

export type CborValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | CborValue[]
  | { [key: string]: CborValue | undefined };

function checkString(value: string): string {
  if (!value.isWellFormed()) throw new TypeError('DAG-CBOR: string has a lone surrogate');
  return value;
}

// A copy of `value` with undefined fields dropped, after checking it against the
// atproto data model.
function toDataModel(value: CborValue): CborValue {
  if (value === null || typeof value === 'boolean' || value instanceof Uint8Array) return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`DAG-CBOR: ${value} is not a safe integer (atproto has no floats)`);
    }
    return value;
  }
  if (typeof value === 'string') return checkString(value);
  if (Array.isArray(value)) return value.map(toDataModel);
  if (typeof value === 'object') {
    const out: { [key: string]: CborValue } = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      // defineProperty, so an own `__proto__` key stays a field.
      Object.defineProperty(out, checkString(key), {
        value: toDataModel(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  throw new TypeError(`DAG-CBOR: cannot encode ${typeof value}`);
}

export function encodeDagCbor(value: CborValue): Uint8Array {
  return dagCbor.encode(toDataModel(value));
}

/**
 * The CIDv1 (dag-cbor, sha2-256, base32) of a record: the `cid` a PDS would
 * report for it. Two records with the same content share a CID wherever they live.
 */
export async function recordCid(record: CborValue): Promise<string> {
  return CID.create(1, dagCbor.code, await sha256.digest(encodeDagCbor(record))).toString();
}
