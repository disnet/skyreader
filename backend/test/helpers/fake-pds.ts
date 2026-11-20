// An in-memory PDS for tests, with the behaviors where PDS implementations differ
// set by a profile. Skyreader talks to whatever PDS a reader's DID names: Bluesky's
// reference PDS, rsky-pds (Blacksky), Cocoon, Tranquil, millipds and more. A test
// that hand-stubs fetch encodes one of them, usually the reference, so a fix that
// leans on its quirks (#810 leaned on RateLimit-* headers on every write) passes.
//
// Run a scenario against every profile with `describe.each(PDS_PROFILES)`. A profile
// is only as good as what we know about the servers: when a PDS is found doing
// something new, add the trait here (and a profile, if it's a combination no profile
// has), with where it was seen.
import { vi } from 'vitest';
import type { Session } from '../../src/types';

export interface PdsProfile {
  name: string;
  /**
   * When RateLimit-Limit / -Remaining / -Reset / -Policy are sent. The reference
   * PDS sends them on every rate-limited route; rsky-pds only on a 429 (#810).
   */
  rateLimitHeaders: 'always' | 'on429' | 'never';
  /** Whether a 429 carries Retry-After. */
  retryAfterOn429: boolean;
  /**
   * How a resource server asks for a DPoP nonce. The reference PDS puts
   * `use_dpop_nonce` in the JSON body and the WWW-Authenticate header; RFC 9449
   * §9 only requires the header.
   */
  nonceSignal: 'body+header' | 'header';
  /**
   * The `message` of a RecordNotFound error. The lexicon fixes only the error
   * name; the reference PDS says "Could not locate record: <uri>", others may
   * say anything (or nothing).
   */
  notFoundMessage: (uri: string) => string | undefined;
}

export const REFERENCE: PdsProfile = {
  name: 'reference (Bluesky PDS)',
  rateLimitHeaders: 'always',
  retryAfterOn429: false,
  nonceSignal: 'body+header',
  notFoundMessage: (uri) => `Could not locate record: ${uri}`,
};

export const RSKY: PdsProfile = {
  name: 'rsky-pds (Blacksky)',
  rateLimitHeaders: 'on429',
  retryAfterOn429: true,
  nonceSignal: 'body+header',
  notFoundMessage: (uri) => `Could not locate record: ${uri}`,
};

/**
 * Only what the specs require: no rate-limit headers, a bare 429, the nonce
 * asked for in the header alone, and a RecordNotFound in its own words. No
 * server is known to do all of this; each trait is one some server may.
 */
export const SPEC_MINIMAL: PdsProfile = {
  name: 'spec-minimal',
  rateLimitHeaders: 'never',
  retryAfterOn429: false,
  nonceSignal: 'header',
  notFoundMessage: () => 'Record not found',
};

export const PDS_PROFILES = [REFERENCE, RSKY, SPEC_MINIMAL];

// Test DPoP key pair (ES256). Only ever signs proofs for a fake host.
const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

/** Write costs in points, as the reference PDS charges them (putRecord: 2, new or not). */
const COST = { create: 3, update: 2, delete: 1 } as const;
const PUT_RECORD_COST = 2;

interface StoredRecord {
  cid: string;
  value: unknown;
}

export interface FakePdsOptions {
  did?: string;
  pdsUrl?: string;
  /** The write budget: points per window. Defaults to the reference's hourly 5,000. */
  budget?: { limit: number; windowSeconds: number };
  /** Ask for a new DPoP nonce every N requests (0: only the first). */
  rotateNonceEvery?: number;
}

export interface FakePdsCall {
  method: string;
  nsid: string;
  status: number;
}

export class FakePds {
  readonly profile: PdsProfile;
  readonly did: string;
  readonly pdsUrl: string;
  readonly calls: FakePdsCall[] = [];
  private readonly repo = new Map<string, Map<string, StoredRecord>>();
  private readonly budget: { limit: number; windowSeconds: number };
  private remaining: number;
  private windowStart = Date.now();
  private readonly rotateNonceEvery: number;
  private nonce = 'nonce-0';
  private nonceCount = 0;
  private requestCount = 0;
  private cidCount = 0;

  constructor(profile: PdsProfile, opts: FakePdsOptions = {}) {
    this.profile = profile;
    this.did = opts.did ?? 'did:plc:fakepds';
    this.pdsUrl = opts.pdsUrl ?? 'https://fake-pds.test';
    this.budget = opts.budget ?? { limit: 5000, windowSeconds: 3600 };
    this.remaining = this.budget.limit;
    this.rotateNonceEvery = opts.rotateNonceEvery ?? 0;
  }

  /** A session on this PDS, with a DPoP key PDSClient can sign with. */
  session(overrides: Partial<Session> = {}): Session {
    return {
      did: this.did,
      handle: 'fake.test',
      pdsUrl: this.pdsUrl,
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      dpopPrivateKey: JSON.stringify(TEST_DPOP_KEY),
      expiresAt: Date.now() + 3_600_000,
      ...overrides,
    };
  }

  /**
   * Route fetches for this PDS's host here; everything else goes to whatever
   * fetch was there before. Undone by vi.restoreAllMocks().
   */
  install(): this {
    const passthrough = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).origin !== new URL(this.pdsUrl).origin) {
        return passthrough(input as RequestInfo, init);
      }
      return this.handle(new Request(input as RequestInfo, init));
    });
    return this;
  }

  /** The records in one collection, by rkey. */
  records(collection: string): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const [rkey, rec] of this.repo.get(collection) ?? []) out.set(rkey, rec.value);
    return out;
  }

  /** Put a record straight into the repo, as if another app had written it. */
  seed(collection: string, rkey: string, value: unknown): string {
    return this.store(collection, rkey, value).cid;
  }

  /** Points left in the current window. */
  get budgetRemaining(): number {
    return this.remaining;
  }

  /** Start a new rate-limit window with the whole budget. */
  resetBudget(): void {
    this.remaining = this.budget.limit;
    this.windowStart = Date.now();
  }

  /** Spend the budget down to `points`, as the reader's own posting would. */
  spendBudgetTo(points: number): void {
    this.remaining = Math.min(this.remaining, points);
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const nsid = url.pathname.replace(/^\/xrpc\//, '');
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      this.calls.push({ method: req.method, nsid, status });
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    };

    // DPoP: the proof must carry the current nonce, which rotates on schedule.
    this.requestCount++;
    if (this.rotateNonceEvery > 0 && this.requestCount % this.rotateNonceEvery === 0) {
      this.nonce = `nonce-${++this.nonceCount}`;
    }
    if (!req.headers.get('authorization')?.startsWith('DPoP ')) {
      return respond(401, { error: 'AuthRequired', message: 'Authentication Required' });
    }
    if (proofNonce(req.headers.get('dpop')) !== this.nonce) {
      const headers = {
        'WWW-Authenticate': 'DPoP error="use_dpop_nonce", error_description="nonce required"',
        'DPoP-Nonce': this.nonce,
      };
      const body =
        this.profile.nonceSignal === 'body+header'
          ? { error: 'use_dpop_nonce', message: 'DPoP nonce mismatch' }
          : { error: 'InvalidToken', message: 'Invalid DPoP proof' };
      return respond(401, body, headers);
    }
    const nonceHeader = { 'DPoP-Nonce': this.nonce };

    const input =
      req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, any>) : {};
    const q = (k: string) => url.searchParams.get(k) ?? '';

    switch (nsid) {
      case 'com.atproto.repo.getRecord': {
        const rec = this.repo.get(q('collection'))?.get(q('rkey'));
        if (!rec) return respond(400, this.notFound(q('collection'), q('rkey')), nonceHeader);
        return respond(
          200,
          { uri: this.uri(q('collection'), q('rkey')), cid: rec.cid, value: rec.value },
          nonceHeader
        );
      }
      case 'com.atproto.repo.listRecords': {
        // Newest (highest rkey) first, as the reference PDS lists; reverse=true is oldest first.
        const reverse = q('reverse') === 'true';
        const all = [...(this.repo.get(q('collection')) ?? [])].sort(([a], [b]) =>
          a < b === reverse ? -1 : 1
        );
        const after = q('cursor');
        const limit = Number(q('limit')) || 50;
        const page = all
          .filter(([rkey]) => !after || (reverse ? rkey > after : rkey < after))
          .slice(0, limit);
        const records = page.map(([rkey, rec]) => ({
          uri: this.uri(q('collection'), rkey),
          cid: rec.cid,
          value: rec.value,
        }));
        // Any non-empty page has a cursor; the end is an empty page, as on the reference.
        const cursor = page.at(-1)?.[0];
        return respond(200, { records, ...(cursor ? { cursor } : {}) }, nonceHeader);
      }
      case 'com.atproto.repo.createRecord':
      case 'com.atproto.repo.putRecord':
      case 'com.atproto.repo.deleteRecord':
      case 'com.atproto.repo.applyWrites': {
        const writes = this.writesOf(nsid, input);
        // A create over an existing record is refused, and fails the whole batch.
        const taken = writes.find(
          (w) => w.op === 'create' && this.repo.get(w.collection)?.has(w.rkey)
        );
        if (taken) {
          const message = `Record already exists: ${this.uri(taken.collection, taken.rkey)}`;
          return respond(400, { error: 'InvalidRequest', message }, nonceHeader);
        }
        const cost =
          nsid === 'com.atproto.repo.putRecord'
            ? PUT_RECORD_COST
            : writes.reduce((sum, w) => sum + COST[w.op], 0);
        if (this.remaining < cost) {
          return respond(
            429,
            { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' },
            { ...nonceHeader, ...this.rateLimitHeaders(429) }
          );
        }
        this.remaining -= cost;
        const results = writes.map((w) => {
          if (w.op === 'delete') {
            this.repo.get(w.collection)?.delete(w.rkey);
            return { $type: 'com.atproto.repo.applyWrites#deleteResult' };
          }
          const { cid } = this.store(w.collection, w.rkey, w.value);
          return {
            $type: `com.atproto.repo.applyWrites#${w.op}Result`,
            uri: this.uri(w.collection, w.rkey),
            cid,
          };
        });
        const headers = { ...nonceHeader, ...this.rateLimitHeaders(200) };
        const commit = { cid: this.nextCid(), rev: String(this.cidCount) };
        if (nsid === 'com.atproto.repo.applyWrites')
          return respond(200, { commit, results }, headers);
        if (nsid === 'com.atproto.repo.deleteRecord') return respond(200, { commit }, headers);
        const { uri, cid } = results[0] as { uri: string; cid: string };
        return respond(200, { uri, cid, commit }, headers);
      }
      default:
        return respond(501, { error: 'MethodNotImplemented', message: `${nsid} not implemented` });
    }
  }

  private writesOf(
    nsid: string,
    input: Record<string, any>
  ): Array<{
    op: 'create' | 'update' | 'delete';
    collection: string;
    rkey: string;
    value?: unknown;
  }> {
    const exists = (c: string, k: string) => this.repo.get(c)?.has(k) ?? false;
    if (nsid === 'com.atproto.repo.applyWrites') {
      return (input.writes as Array<Record<string, any>>).map((w) => {
        const op = String(w.$type).split('#')[1] as 'create' | 'update' | 'delete';
        return { op, collection: w.collection, rkey: w.rkey ?? this.tid(), value: w.value };
      });
    }
    const rkey = input.rkey ?? this.tid();
    if (nsid === 'com.atproto.repo.deleteRecord') {
      return [{ op: 'delete', collection: input.collection, rkey }];
    }
    const op =
      nsid === 'com.atproto.repo.putRecord' && exists(input.collection, rkey) ? 'update' : 'create';
    return [{ op, collection: input.collection, rkey, value: input.record }];
  }

  private rateLimitHeaders(status: number): Record<string, string> {
    const { limit, windowSeconds } = this.budget;
    const send =
      this.profile.rateLimitHeaders === 'always' ||
      (this.profile.rateLimitHeaders === 'on429' && status === 429);
    const resetEpoch = Math.ceil(this.windowStart / 1000) + windowSeconds;
    const headers: Record<string, string> = send
      ? {
          'RateLimit-Limit': String(limit),
          // A refusing limiter reports nothing left, whatever a smaller write could still spend.
          'RateLimit-Remaining': String(status === 429 ? 0 : this.remaining),
          'RateLimit-Reset': String(resetEpoch),
          'RateLimit-Policy': `${limit};w=${windowSeconds}`,
        }
      : {};
    if (status === 429 && this.profile.retryAfterOn429) {
      headers['Retry-After'] = String(Math.max(1, resetEpoch - Math.floor(Date.now() / 1000)));
    }
    return headers;
  }

  private notFound(collection: string, rkey: string): { error: string; message?: string } {
    const message = this.profile.notFoundMessage(this.uri(collection, rkey));
    return { error: 'RecordNotFound', ...(message ? { message } : {}) };
  }

  private store(collection: string, rkey: string, value: unknown): StoredRecord {
    let coll = this.repo.get(collection);
    if (!coll) this.repo.set(collection, (coll = new Map()));
    const rec = { cid: this.nextCid(), value };
    coll.set(rkey, rec);
    return rec;
  }

  private uri(collection: string, rkey: string): string {
    return `at://${this.did}/${collection}/${rkey}`;
  }

  private nextCid(): string {
    return `bafyreifake${++this.cidCount}`;
  }

  private tid(): string {
    return `3fake${String(++this.cidCount).padStart(8, '0')}`;
  }
}

/** The `nonce` claim of a DPoP proof, read without verifying it. */
function proofNonce(proof: string | null): string | undefined {
  const payload = proof?.split('.')[1];
  if (!payload) return undefined;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json) as { nonce?: string }).nonce;
  } catch {
    return undefined;
  }
}
