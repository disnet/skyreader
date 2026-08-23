/**
 * atproto Spaces — identifiers and constants for the saved-articles spike.
 *
 * Deliberately dependency-free (no Env, no D1, no Workers globals) so the same
 * module is importable from the standalone Node experiment in
 * `experiments/spaces-saves/`, which exercises this exact code against a real
 * spaces-capable PDS. See that directory's FINDINGS.md.
 */

/**
 * The space *type* NSID. A space type is just an NSID naming the modality of the
 * space; the alpha does not require a lexicon document for it (the reference app,
 * bluesky-social/bulletin, ships none for `my.bulletin.board`).
 */
export const SAVED_SPACE_TYPE = 'app.skyreader.space.saved';

/** One saved-space per user, so the space key is constant. */
export const SAVED_SPACE_SKEY = 'self';

/**
 * The record collection inside the space. Same NSID the retired public-repo
 * export used — inside a permissioned repo it finally means what it says, so the
 * synthetic `record_uri` D1 already stores lines up with a record that exists.
 */
export const SAVED_COLLECTION = 'app.skyreader.feed.saved';

/**
 * OAuth permission set that would be requested (as `include:<nsid>`) to get space
 * access for a real user. NOT requested by this spike — see `config/scopes.ts` and
 * the risks section of the spike memo.
 */
export const SAVED_SPACE_PERMISSION_SET = 'app.skyreader.space.savedAccess';

export interface SpaceRef {
  /** DID of the space authority. For a personal space this is the user's own DID. */
  authority: string;
  /** Space type NSID. */
  type: string;
  /** Space key. */
  skey: string;
  /** The canonical `at://…/space/…` reference. */
  uri: string;
}

/** `at://{authority}/space/{type}/{skey}` — the alpha's space-ref string format. */
export function formatSpaceRef(authority: string, type: string, skey: string): string {
  return `at://${authority}/space/${type}/${skey}`;
}

/** The saved-articles space owned by (and hosted for) `did`. */
export function savedSpaceRef(did: string): string {
  return formatSpaceRef(did, SAVED_SPACE_TYPE, SAVED_SPACE_SKEY);
}

/** Parse a space-ref, returning null when it isn't one. */
export function parseSpaceRef(uri: string): SpaceRef | null {
  const match = /^at:\/\/(did:[^/]+)\/space\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match) return null;
  return { authority: match[1], type: match[2], skey: match[3], uri };
}

/**
 * Address of a single record inside a space:
 * `at://{authority}/space/{type}/{skey}/{authorDid}/{collection}/{rkey}`.
 */
export function spaceRecordUri(
  space: string,
  authorDid: string,
  collection: string,
  rkey: string
): string {
  return `${space}/${authorDid}/${collection}/${rkey}`;
}
