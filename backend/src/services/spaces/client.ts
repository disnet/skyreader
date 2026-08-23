/**
 * Workers-native client for the two atproto Spaces namespaces.
 *
 *   `com.atproto.simplespace.*` — the space authority: create/inspect a space and
 *                                 manage its member list. Session-authed against
 *                                 the authority's own PDS.
 *   `com.atproto.space.*`       — the permissioned repo: records, sync, and the
 *                                 delegation/credential exchange.
 *
 * Method names, parameter names and error codes were read off the published alpha
 * SDK (`@atproto/api@0.0.0-spaces-alpha-20260818163953`,
 * `dist/client/types/com/atproto/{simplespace,space}/*.d.ts`) rather than taken
 * from proposal 0016 — see `experiments/spaces-saves/FINDINGS.md` for the diffs
 * that matters.
 *
 * No `@atproto/*` dependency: the alpha SDK assumes Node, and the backend already
 * hand-rolls its XRPC (`services/pds-client.ts`). Transport is injected as an
 * `XrpcCall`, so the same client works with session auth (the mirror), with a
 * space credential (cross-host reads), or with a stub (tests).
 */

import { SAVED_COLLECTION } from './refs';

export type XrpcCall = <T>(
  method: 'GET' | 'POST',
  /** NSID plus, for GETs, an already-encoded query string. */
  endpoint: string,
  body?: unknown
) => Promise<T>;

export type SpacePolicy =
  | { $type: 'com.atproto.simplespace.defs#publicPolicy' }
  | { $type: 'com.atproto.simplespace.defs#memberListPolicy' }
  | { $type: 'com.atproto.simplespace.defs#managingAppPolicy'; managingApp: string };

export type SpaceAppAccess =
  | { $type: 'com.atproto.simplespace.defs#open' }
  | { $type: 'com.atproto.simplespace.defs#allowList'; allowed: string[] };

export interface SpaceView {
  uri: string;
  policy: { $type: string };
  appAccess: { $type: string };
}

export interface SpaceRecordRef {
  uri: string;
  cid: string;
  validationStatus?: string;
}

export interface SpaceListedRecord {
  collection: string;
  rkey: string;
  cid: string;
  value?: Record<string, unknown>;
}

export class SpacesClient {
  // Plain field assignment, not a parameter property: `experiments/spaces-saves/`
  // imports this module directly under Node's (erasable-syntax-only) type
  // stripping, and parameter properties aren't erasable.
  private readonly call: XrpcCall;

  constructor(call: XrpcCall) {
    this.call = call;
  }

  // --- com.atproto.simplespace (authority) ---------------------------------

  /**
   * Create the space. `skey` is optional in the lexicon (a TID is generated when
   * omitted); we always pass one so the space ref is derivable from the DID and
   * no lookup table is needed.
   */
  createSpace(input: {
    type: string;
    skey?: string;
    policy: SpacePolicy;
    appAccess: SpaceAppAccess;
  }): Promise<{ uri: string }> {
    return this.call<{ uri: string }>('POST', 'com.atproto.simplespace.createSpace', input);
  }

  getSpace(space: string): Promise<SpaceView> {
    const params = new URLSearchParams({ space });
    return this.call<SpaceView>('GET', `com.atproto.simplespace.getSpace?${params}`);
  }

  addMember(space: string, did: string): Promise<void> {
    return this.call<void>('POST', 'com.atproto.simplespace.addMember', { space, did });
  }

  removeMember(space: string, did: string): Promise<void> {
    return this.call<void>('POST', 'com.atproto.simplespace.removeMember', { space, did });
  }

  listMembers(space: string, limit = 100): Promise<{ members: Array<{ did: string }> }> {
    const params = new URLSearchParams({ space, limit: String(limit) });
    return this.call('GET', `com.atproto.simplespace.listMembers?${params}`);
  }

  // --- com.atproto.space (permissioned repo) -------------------------------

  /** Leg 1 of the credential flow; must run against the *user's* PDS. */
  getDelegationToken(space: string): Promise<{ token: string }> {
    const params = new URLSearchParams({ space });
    return this.call<{ token: string }>('GET', `com.atproto.space.getDelegationToken?${params}`);
  }

  createRecord(input: {
    space: string;
    repo: string;
    collection: string;
    rkey?: string;
    record: Record<string, unknown>;
    validate?: boolean;
  }): Promise<SpaceRecordRef> {
    return this.call<SpaceRecordRef>('POST', 'com.atproto.space.createRecord', input);
  }

  putRecord(input: {
    space: string;
    repo: string;
    collection: string;
    rkey: string;
    record: Record<string, unknown>;
    validate?: boolean;
  }): Promise<SpaceRecordRef> {
    return this.call<SpaceRecordRef>('POST', 'com.atproto.space.putRecord', input);
  }

  getRecord(input: {
    space: string;
    repo: string;
    collection: string;
    rkey: string;
  }): Promise<{ uri: string; cid: string; value: Record<string, unknown> }> {
    const params = new URLSearchParams(input);
    return this.call('GET', `com.atproto.space.getRecord?${params}`);
  }

  deleteRecord(input: {
    space: string;
    repo: string;
    collection: string;
    rkey: string;
  }): Promise<void> {
    return this.call<void>('POST', 'com.atproto.space.deleteRecord', input);
  }

  listRecords(input: {
    space: string;
    repo: string;
    collection?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ records: SpaceListedRecord[]; cursor?: string }> {
    const params = new URLSearchParams({ space: input.space, repo: input.repo });
    if (input.collection) params.set('collection', input.collection);
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    if (input.cursor) params.set('cursor', input.cursor);
    return this.call('GET', `com.atproto.space.listRecords?${params}`);
  }

  /** Paginated read of one collection, with a page cap so a bad cursor can't spin. */
  async listAllRecords(
    input: { space: string; repo: string; collection?: string },
    maxPages = 20
  ): Promise<SpaceListedRecord[]> {
    const records: SpaceListedRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.listRecords({ ...input, limit: 100, cursor });
      records.push(...result.records);
      if (!result.cursor || result.records.length === 0) break;
      cursor = result.cursor;
    }
    return records;
  }
}

/**
 * The policy the spike creates a personal saved-space with: member-list (so it
 * starts private to its owner) and open app access.
 *
 * `#open` is a spike choice, not a recommendation. It means any app holding the
 * user's authorization can read the space; `#allowList` (pinned to Skyreader's
 * OAuth client_id) is what a shipped version would want, and it needs a stable
 * client_id per environment. Noted in the spike memo.
 */
export const PERSONAL_SPACE_POLICY: SpacePolicy = {
  $type: 'com.atproto.simplespace.defs#memberListPolicy',
};
export const PERSONAL_SPACE_APP_ACCESS: SpaceAppAccess = {
  $type: 'com.atproto.simplespace.defs#open',
};

export { SAVED_COLLECTION };
