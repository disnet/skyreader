/**
 * The space-credential flow: three legs before the first cross-host read.
 *
 *   1. `com.atproto.space.getDelegationToken` on the *user's* PDS, with ordinary
 *      session auth  →  a short-lived, single-use delegation JWT (60s).
 *   2. `com.atproto.space.getSpaceCredential` on the *authority's* PDS, presenting
 *      that delegation as a Bearer token plus an HTTP message signature naming a
 *      fresh P-256 `did:key` as `keyid`  →  a credential JWT bound to that key
 *      through `cnf.kid` (10 min).
 *   3. every subsequent space call: `Authorization: Atproto-Space <credential>`,
 *      an `atproto-space-audience` DID, and a signature over both.
 *
 * TTLs are from `@atproto/space@0.0.0-spaces-alpha-20261001173819`
 * (`dist/credential.js`, `SPACE_TOKEN_TYPES`): delegation 60s/single-use,
 * credential 600s/reusable (verifiers cap it at 3600s), client attestation
 * 60s/single-use. Until that release the credential was DPoP-bound and lived 2h.
 *
 * Writing to your OWN repo inside a space does not need any of this — the
 * reference app posts `com.atproto.space.createRecord` to its own PDS with plain
 * session auth, which is what the D1 mirror does. Credentials are for reading a
 * space from somewhere that isn't the author's own authenticated session, which
 * is exactly the portability claim this spike is testing.
 */

import {
  createSpaceSignatureHeaders,
  generateSpaceSigningKey,
  jwtExpirySeconds,
} from './http-signature';
import type { SpaceSigningKey } from './http-signature';

/** Documented alpha lifetimes; we re-read `exp` from the token rather than assume. */
export const DELEGATION_TOKEN_TTL_SEC = 60;
export const SPACE_CREDENTIAL_TTL_SEC = 600;

/** Refresh this long before `exp` so an in-flight request can't expire mid-call. */
const EXPIRY_MARGIN_SEC = 60;

export class SpaceCredential {
  readonly token: string;
  readonly key: SpaceSigningKey;
  /** Epoch ms. */
  readonly expiresAt: number;

  // Plain field assignment rather than constructor parameter properties: these
  // modules are imported directly by the Node experiment in
  // `experiments/spaces-saves/`, which runs them through Node's type stripping,
  // and that only accepts erasable TypeScript syntax.
  constructor(token: string, key: SpaceSigningKey, expiresAt: number) {
    this.token = token;
    this.key = key;
    this.expiresAt = expiresAt;
  }

  isFresh(now = Date.now()): boolean {
    return this.expiresAt - EXPIRY_MARGIN_SEC * 1000 > now;
  }

  /**
   * Headers for one request to any host serving this space. `audience` is the DID
   * the request is addressed to: the repo DID for record reads, the space
   * authority for space-host methods. Nothing about the URL is signed, so the
   * headers are only as specific as that audience.
   */
  authorize(audience: string): Promise<Record<string, string>> {
    return createSpaceSignatureHeaders(this.key, {
      authorization: `Atproto-Space ${this.token}`,
      audience,
    });
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
  key: SpaceSigningKey;
  fetchImpl?: typeof fetch;
}

/** Leg 2. Returns the raw credential JWT. */
export async function exchangeSpaceCredential(input: ExchangeCredentialInput): Promise<string> {
  const url = `${input.authorityPdsUrl.replace(/\/$/, '')}/xrpc/com.atproto.space.getSpaceCredential`;

  const response = await (input.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      // The delegation token is not itself key-bound: this leg's signature
      // carries `keyid`, and that is what the credential's `cnf.kid` will name.
      ...(await createSpaceSignatureHeaders(input.key, {
        authorization: `Bearer ${input.delegationToken}`,
      })),
    },
    body: JSON.stringify({ space: input.space }),
  });

  const body = (await response.json().catch(() => undefined)) as
    { credential?: unknown; error?: unknown; message?: unknown } | undefined;

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
  const key = await generateSpaceSigningKey();
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
 * short-lived token into durable stored key material for an alpha protocol. The
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
