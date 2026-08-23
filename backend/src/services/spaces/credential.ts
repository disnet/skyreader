/**
 * The space-credential flow: three legs before the first cross-host read.
 *
 *   1. `com.atproto.space.getDelegationToken` on the *user's* PDS, with ordinary
 *      session auth  →  a short-lived, single-use delegation JWT (60s).
 *   2. `com.atproto.space.getSpaceCredential` on the *authority's* PDS, presenting
 *      that delegation as a Bearer token plus a DPoP proof from a fresh ES256 key
 *      →  a credential JWT bound to that key through `cnf.jkt` (2h).
 *   3. every subsequent space call: `Authorization: DPoP <credential>` and a proof
 *      whose `ath` hashes the credential.
 *
 * TTLs are from `@atproto/space@0.0.0-spaces-alpha-20260818163953`
 * (`dist/credential.d.ts`, `SPACE_TOKEN_TYPES`): delegation 60s/single-use,
 * credential 7200s/reusable, client attestation 60s/single-use.
 *
 * Writing to your OWN repo inside a space does not need any of this — the
 * reference app posts `com.atproto.space.createRecord` to its own PDS with plain
 * session auth, which is what the D1 mirror does. Credentials are for reading a
 * space from somewhere that isn't the author's own authenticated session, which
 * is exactly the portability claim this spike is testing.
 */

import { createSpaceDpopProof, generateSpaceDpopKey, jwtExpirySeconds } from './dpop';
import type { SpaceDpopKey } from './dpop';

/** Documented alpha lifetimes; we re-read `exp` from the token rather than assume. */
export const DELEGATION_TOKEN_TTL_SEC = 60;
export const SPACE_CREDENTIAL_TTL_SEC = 7200;

/** Refresh this long before `exp` so an in-flight request can't expire mid-call. */
const EXPIRY_MARGIN_SEC = 60;

export class SpaceCredential {
  readonly token: string;
  readonly key: SpaceDpopKey;
  /** Epoch ms. */
  readonly expiresAt: number;

  // Plain field assignment rather than constructor parameter properties: these
  // modules are imported directly by the Node experiment in
  // `experiments/spaces-saves/`, which runs them through Node's type stripping,
  // and that only accepts erasable TypeScript syntax.
  constructor(token: string, key: SpaceDpopKey, expiresAt: number) {
    this.token = token;
    this.key = key;
    this.expiresAt = expiresAt;
  }

  isFresh(now = Date.now()): boolean {
    return this.expiresAt - EXPIRY_MARGIN_SEC * 1000 > now;
  }

  /** Authorize an arbitrary request against any host serving this space. */
  async authorize(method: string, url: string): Promise<Record<string, string>> {
    return {
      Authorization: `DPoP ${this.token}`,
      DPoP: await createSpaceDpopProof(this.key, {
        htm: method,
        htu: url,
        credential: this.token,
      }),
    };
  }
}

export class SpaceCredentialError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = 'SpaceCredentialError';
    this.code = code;
    this.status = status;
  }
}

export interface ExchangeCredentialInput {
  /** Base URL of the authority's PDS (no trailing slash). */
  authorityPdsUrl: string;
  /** The single-use delegation token from leg 1. */
  delegationToken: string;
  /** `at://…/space/…` reference. */
  space: string;
  /** The key the credential gets bound to. */
  key: SpaceDpopKey;
  fetchImpl?: typeof fetch;
}

/** Leg 2. Returns the raw credential JWT. */
export async function exchangeSpaceCredential(input: ExchangeCredentialInput): Promise<string> {
  const url = `${input.authorityPdsUrl.replace(/\/$/, '')}/xrpc/com.atproto.space.getSpaceCredential`;
  const proof = await createSpaceDpopProof(input.key, { htm: 'POST', htu: url });

  const response = await (input.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      // Note: Bearer, not DPoP — the delegation token is not itself key-bound;
      // the proof on this leg is what the credential's `cnf.jkt` will name.
      authorization: `Bearer ${input.delegationToken}`,
      dpop: proof,
    },
    body: JSON.stringify({ space: input.space }),
  });

  const body = (await response.json().catch(() => undefined)) as
    | { credential?: unknown; error?: unknown; message?: unknown }
    | undefined;

  if (!response.ok) {
    const code = typeof body?.error === 'string' ? body.error : `HTTP${response.status}`;
    const message = typeof body?.message === 'string' ? body.message : code;
    throw new SpaceCredentialError(message, code, response.status);
  }
  if (typeof body?.credential !== 'string' || !body.credential) {
    throw new SpaceCredentialError('credential exchange returned no credential', 'InvalidResponse');
  }
  return body.credential;
}

export interface MintCredentialInput {
  space: string;
  authorityPdsUrl: string;
  /** Leg 1 — supplied by the caller because it needs the user's session auth. */
  getDelegationToken: (space: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

/** Legs 1 + 2. */
export async function mintSpaceCredential(input: MintCredentialInput): Promise<SpaceCredential> {
  const delegationToken = await input.getDelegationToken(input.space);
  const key = await generateSpaceDpopKey();
  const token = await exchangeSpaceCredential({
    authorityPdsUrl: input.authorityPdsUrl,
    delegationToken,
    space: input.space,
    key,
    fetchImpl: input.fetchImpl,
  });
  const exp = jwtExpirySeconds(token);
  const expiresAt = exp !== null ? exp * 1000 : Date.now() + SPACE_CREDENTIAL_TTL_SEC * 1000;
  return new SpaceCredential(token, key, expiresAt);
}

/**
 * Per-isolate credential cache.
 *
 * In memory only, and deliberately so: a credential is worthless without the
 * private key it is bound to, and persisting that key to D1 would turn a
 * two-hour token into durable stored key material for an alpha protocol. The
 * cost is a re-mint (two round trips) on a cold isolate; the alternative is
 * writing private keys to the database for a spike.
 */
const credentialCache = new Map<string, SpaceCredential>();

export function cacheKeyFor(did: string, space: string): string {
  return `${did}|${space}`;
}

export async function getOrMintSpaceCredential(
  did: string,
  input: MintCredentialInput
): Promise<SpaceCredential> {
  const key = cacheKeyFor(did, input.space);
  const cached = credentialCache.get(key);
  if (cached?.isFresh()) return cached;

  const credential = await mintSpaceCredential(input);
  credentialCache.set(key, credential);
  return credential;
}

/** Test seam. */
export function clearCredentialCache(): void {
  credentialCache.clear();
}
