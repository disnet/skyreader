import type { Env } from '../types';

/**
 * Where a save's kept files live: an uploaded PDF or EPUB, the original of one
 * saved by link (routes/saved-pdf.ts), and the pictures a snapshot of its body
 * captured (services/archive/snapshot-images.ts).
 *
 * Every read, write and delete of a kept original goes through a SavedFileStore,
 * so a file can live somewhere other than R2 without the routes knowing. Each
 * saved_files row records which store holds its file (`storage`) and the store's
 * own locator for it: `r2_key` for R2, and `blob_cid` / `record_uri` for a file
 * kept as a blob under a record in the reader's own atproto space, which is the
 * store this prepares for (not built yet: R2 is the only one today).
 *
 * The staging area for linked books (services/linked-originals.ts) isn't a
 * store: it's server-side scratch for one save, wherever that save's original
 * then goes.
 */

/** The stores a kept original can live in. */
export type FileStorage = 'r2';

/** A kept original's place in its store: the saved_files columns that locate it. */
export interface StoredFileRef {
  storage: FileStorage;
  r2Key: string;
  blobCid: string | null;
  recordUri: string | null;
}

/** The saved_files columns a StoredFileRef is read from. */
export const STORED_FILE_COLUMNS = 'storage, r2_key, blob_cid, record_uri';
/** One `?` per STORED_FILE_COLUMNS column, for the values storedFileBindings gives. */
export const STORED_FILE_PLACEHOLDERS = '?, ?, ?, ?';

/** A StoredFileRef as the values bound to STORED_FILE_COLUMNS, in order. */
export function storedFileBindings(
  ref: StoredFileRef
): [string, string, string | null, string | null] {
  return [ref.storage, ref.r2Key, ref.blobCid, ref.recordUri];
}

export interface StoredFileColumns {
  storage: string;
  r2_key: string;
  blob_cid: string | null;
  record_uri: string | null;
}

/** What a stored file is, for the store to label it with. */
export interface SavedFileMeta {
  did: string;
  rkey: string;
  kind: 'pdf' | 'epub';
  mimeType: string;
  filename: string | null;
}

/** A picture a snapshot captured, for the store to label it with. */
export interface SnapshotImageMeta {
  did: string;
  saveRkey: string;
  sha256: string;
  mimeType: string;
}

/** A file's bytes, as a stream of known length. */
export interface StoredFileBody {
  body: ReadableStream<Uint8Array>;
  size: number;
}

export interface SavedFileStore {
  readonly storage: FileStorage;
  /**
   * Keep a save's original. The same save always lands in the same place, so a
   * racing second write of it replaces the first rather than leaving a stray.
   * A bare stream (length unknown) is written a part at a time, so the file is
   * never held whole; if the stream errors, nothing is kept and its error is
   * what put rejects with.
   */
  put(
    meta: SavedFileMeta,
    bytes: ArrayBuffer | StoredFileBody | ReadableStream<Uint8Array>
  ): Promise<StoredFileRef>;
  /**
   * Keep a picture a snapshot captured. Keyed by its digest within the save, so
   * the same picture captured twice is kept once.
   */
  putImage(meta: SnapshotImageMeta, bytes: Uint8Array): Promise<StoredFileRef>;
  /** The whole file, or null when the store no longer has it. */
  get(ref: StoredFileRef): Promise<StoredFileBody | null>;
  /** The file's size in bytes, or null when the store no longer has it. */
  size(ref: StoredFileRef): Promise<number | null>;
  /** `length` bytes from `offset`, or null when the store no longer has the file. */
  readRange(ref: StoredFileRef, offset: number, length: number): Promise<Uint8Array | null>;
  delete(ref: StoredFileRef): Promise<void>;
}

/** Where an R2-kept original lives: one object per save, by reader and rkey. */
export function savedFileKey(did: string, rkey: string, kind: 'pdf' | 'epub' = 'pdf'): string {
  return `${kind}/${did}/${rkey}.${kind}`;
}

/** Where an R2-kept snapshot picture lives: one object per distinct picture in a save. */
export function snapshotImageKey(did: string, saveRkey: string, sha256: string): string {
  return `images/${did}/${saveRkey}/${sha256}`;
}

// R2's multipart parts must all be one size (at least 5 MiB) bar the last, so
// a streamed file is cut into parts of exactly this many bytes, and this is
// all of it the Worker holds at once.
const PART_BYTES = 5 * 1024 * 1024;

/** Write a stream of unknown length to `key` as a multipart upload. */
async function putStream(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  options: R2MultipartOptions
): Promise<void> {
  const upload = await bucket.createMultipartUpload(key, options);
  const reader = body.getReader();
  try {
    const parts: R2UploadedPart[] = [];
    let part = new Uint8Array(PART_BYTES);
    let filled = 0;
    const send = async (bytes: Uint8Array) => {
      parts.push(await upload.uploadPart(parts.length + 1, bytes));
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const n = Math.min(PART_BYTES - filled, value.byteLength - offset);
        part.set(value.subarray(offset, offset + n), filled);
        filled += n;
        offset += n;
        if (filled === PART_BYTES) {
          await send(part);
          part = new Uint8Array(PART_BYTES);
          filled = 0;
        }
      }
    }
    // An upload needs at least one part, even an empty one.
    if (filled > 0 || parts.length === 0) await send(part.subarray(0, filled));
    await upload.complete(parts);
  } catch (err) {
    await reader.cancel(err).catch(() => {});
    await upload.abort().catch(() => {});
    throw err;
  }
}

function r2Store(bucket: R2Bucket): SavedFileStore {
  return {
    storage: 'r2',
    async put(meta, bytes) {
      const key = savedFileKey(meta.did, meta.rkey, meta.kind);
      const options = {
        httpMetadata: { contentType: meta.mimeType },
        customMetadata: {
          did: meta.did,
          rkey: meta.rkey,
          ...(meta.filename ? { filename: meta.filename } : {}),
        },
      };
      if (bytes instanceof ReadableStream) {
        await putStream(bucket, key, bytes, options);
      } else {
        // R2 needs a stream's length up front.
        const value =
          'body' in bytes ? bytes.body.pipeThrough(new FixedLengthStream(bytes.size)) : bytes;
        await bucket.put(key, value, options);
      }
      return { storage: 'r2', r2Key: key, blobCid: null, recordUri: null };
    },
    async putImage(meta, bytes) {
      const key = snapshotImageKey(meta.did, meta.saveRkey, meta.sha256);
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: meta.mimeType },
        customMetadata: { did: meta.did, save: meta.saveRkey, sha256: meta.sha256 },
      });
      return { storage: 'r2', r2Key: key, blobCid: null, recordUri: null };
    },
    async get(ref) {
      const object = await bucket.get(ref.r2Key);
      return object ? { body: object.body, size: object.size } : null;
    },
    async size(ref) {
      return (await bucket.head(ref.r2Key))?.size ?? null;
    },
    async readRange(ref, offset, length) {
      const object = await bucket.get(ref.r2Key, { range: { offset, length } });
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    async delete(ref) {
      await bucket.delete(ref.r2Key);
    },
  };
}

/** The store new originals are kept in, or null when this server keeps none. */
export function savedFileStore(env: Env): SavedFileStore | null {
  return env.SAVED_FILES ? r2Store(env.SAVED_FILES) : null;
}

/** The store holding `ref`, or null when it isn't one this server can reach. */
export function storeFor(env: Env, ref: StoredFileRef): SavedFileStore | null {
  return ref.storage === 'r2' ? savedFileStore(env) : null;
}

/** A saved_files row's StoredFileRef. */
export function storedFileRef(row: StoredFileColumns): StoredFileRef {
  return {
    storage: row.storage as FileStorage,
    r2Key: row.r2_key,
    blobCid: row.blob_cid,
    recordUri: row.record_uri,
  };
}
