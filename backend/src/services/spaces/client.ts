/**
 * Workers-native client for the atproto Spaces namespaces.
 *
 *   `com.atproto.space.*`       — the space lifecycle (create/get/update, governed
 *                                 by one `policy`), the permissioned repo's records,
 *                                 and the delegation/credential exchange.
 *   `com.atproto.memberspace.*` — the member list of a `memberspace`-policy space.
 *                                 Session-authed against the authority's own PDS.
 *
 * Method names, parameter names and error codes were read off the published alpha
 * SDK (`@atproto/api@0.0.0-spaces-alpha-20261029171913`,
 * `dist/client/types/com/atproto/{space,memberspace}/*.d.ts`) rather than taken
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

export interface MemberspacePolicy {
  $type: 'com.atproto.memberspace.policy';
  publicRead: boolean;
  publicWrite: boolean;
  /** Apps (OAuth client_ids) allowed a credential; omitted means any app. */
  allowedApps?: string[];
  publishPolicy: boolean;
  publishMembers: boolean;
}

/** The space's single `policy`, an open union on `$type` (Oct 29 alpha). */
export type SpacePolicy =
  | { $type: 'com.atproto.personalspace.policy' }
  | MemberspacePolicy
  | { $type: 'com.atproto.managedspace.policy'; managingApp: string; publishPolicy: boolean };

export interface SpaceView {
  uri: string;
  policy: { $type: string } & Partial<Omit<MemberspacePolicy, '$type'>>;
}

export interface SpaceMember {
  did: string;
  read: boolean;
  write: boolean;
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

export interface SpaceRecordListing {
  records: SpaceListedRecord[];
  /** True when the safety page cap stopped a listing that still had a cursor. */
  truncated: boolean;
}

export class SpacesClient {
  // Plain field assignment, not a parameter property: `experiments/spaces-saves/`
  // imports this module directly under Node's (erasable-syntax-only) type
  // stripping, and parameter properties aren't erasable.
  private readonly call: XrpcCall;

  constructor(call: XrpcCall) {
    this.call = call;
  }

  // --- com.atproto.space (lifecycle) ----------------------------------------

  /**
   * Create the space. `skey` is optional in the lexicon (a TID is generated when
   * omitted); we always pass one so the space ref is derivable from the DID and
   * no lookup table is needed.
   *
   * One `policy` governs both who may read and whose writes the authority tracks.
   * (The Oct 29 alpha folded `readPolicy`/`writePolicy`/`appAccess` into it and
   * moved the method out of `com.atproto.simplespace`.)
   */
  createSpace(input: {
    spaceType: string;
    skey?: string;
    policy: SpacePolicy;
  }): Promise<{ uri: string }> {
    return this.call<{ uri: string }>('POST', 'com.atproto.space.createSpace', input);
  }

  /** Owner-only (OAuth `read_self`); a space credential is refused. */
  getSpace(space: string): Promise<SpaceView> {
    const params = new URLSearchParams({ space });
    return this.call<SpaceView>('GET', `com.atproto.space.getSpace?${params}`);
  }

  /**
   * Replace the space's policy wholesale: nothing is merged, so to change one
   * field, read it with getSpace and send the whole object back. A different
   * `$type` migrates the space and discards the old policy's state.
   */
  updateSpace(input: { space: string; policy: SpacePolicy }): Promise<void> {
    return this.call<void>('POST', 'com.atproto.space.updateSpace', input);
  }

  // --- com.atproto.memberspace (member list) --------------------------------

  /** Upsert a member. `PolicyMismatch` on a space that isn't a memberspace. */
  putMember(space: string, member: SpaceMember): Promise<void> {
    return this.call<void>('POST', 'com.atproto.memberspace.putMember', { space, ...member });
  }

  removeMember(space: string, did: string): Promise<void> {
    return this.call<void>('POST', 'com.atproto.memberspace.removeMember', { space, did });
  }

  listMembers(space: string, limit = 100): Promise<{ members: SpaceMember[] }> {
    const params = new URLSearchParams({ space, limit: String(limit) });
    return this.call('GET', `com.atproto.memberspace.listMembers?${params}`);
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
  ): Promise<SpaceRecordListing> {
    const records: SpaceListedRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.listRecords({ ...input, limit: 100, cursor });
      records.push(...result.records);
      if (!result.cursor || result.records.length === 0) return { records, truncated: false };
      cursor = result.cursor;
    }
    return { records, truncated: cursor !== undefined };
  }
}

/**
 * The policy the spike creates a personal saved-space with: a memberspace with no
 * members and nothing public, so it starts private to its owner. This is the
 * Oct 22 member-list-for-both configuration, converted as the alpha's own
 * migration converts it.
 *
 * Omitting `allowedApps` (formerly `#open`) is a spike choice, not a
 * recommendation. It means any app holding the user's authorization can get a
 * credential; `allowedApps: [Skyreader's client_id]` is what a shipped version
 * would want, and it needs a stable client_id per environment. That allow-list is
 * also why this isn't `com.atproto.personalspace.policy`, which fits "only the
 * owner sees it" but has no app allow-list at all. Noted in the spike memo.
 */
export const PERSONAL_SPACE_POLICY: MemberspacePolicy = {
  $type: 'com.atproto.memberspace.policy',
  publicRead: false,
  publicWrite: false,
  publishPolicy: false,
  publishMembers: false,
};

/**
 * The memberspace policy with its app allow-list set, or removed when `apps` is
 * undefined. Every other field is kept: updateSpace replaces the policy
 * wholesale, so the caller sends the whole object back.
 */
export function withAllowedApps(
  policy: MemberspacePolicy,
  apps: string[] | undefined
): MemberspacePolicy {
  const next = { ...policy };
  delete next.allowedApps;
  return apps ? { ...next, allowedApps: apps } : next;
}

export { SAVED_COLLECTION };
