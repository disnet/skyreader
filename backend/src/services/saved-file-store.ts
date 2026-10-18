import type { Env } from '../types';

/**
 * Where a save's kept original lives: an uploaded PDF or EPUB, or the original
 * of one saved by link (routes/saved-pdf.ts).
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
   */
  put(meta: SavedFileMeta, bytes: ArrayBuffer | StoredFileBody): Promise<StoredFileRef>;
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

function r2Store(bucket: R2Bucket): SavedFileStore {
  return {
    storage: 'r2',
    async put(meta, bytes) {
      const key = savedFileKey(meta.did, meta.rkey, meta.kind);
      // R2 needs a stream's length up front.
      const value =
        'body' in bytes ? bytes.body.pipeThrough(new FixedLengthStream(bytes.size)) : bytes;
      await bucket.put(key, value, {
        httpMetadata: { contentType: meta.mimeType },
        customMetadata: {
          did: meta.did,
          rkey: meta.rkey,
          ...(meta.filename ? { filename: meta.filename } : {}),
        },
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
