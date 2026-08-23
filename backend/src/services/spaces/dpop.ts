/**
 * DPoP proofs for atproto Spaces credentials.
 *
 * This is NOT the same proof the OAuth path builds (`services/oauth.ts`
 * `createDPoPProof`): a space proof normalizes `htu` to origin+path (RFC 9449
 * §4.2, so one proof covers any query string), carries no `nonce`, and its `ath`
 * hashes the *space credential* rather than an access token. Kept separate on
 * purpose — folding the two would make the OAuth proof's behaviour depend on a
 * spike flag.
 *
 * Shapes verified against `@atproto/space@0.0.0-spaces-alpha-20260818163953`
 * (`dist/dpop.js`, `createDpopProof` / `verifyDpopProof`).
 *
 * WebCrypto + fetch only, so it runs unchanged on Workers and on Node.
 */

export interface SpaceDpopKey {
  privateKey: CryptoKey;
  /** Bare public JWK (kty/crv/x/y) — the `jwk` header of every proof. */
  publicJwk: JsonWebKey;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Fresh ES256 key. The private half never leaves the isolate — see credential.ts. */
export async function generateSpaceDpopKey(): Promise<SpaceDpopKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return {
    privateKey: pair.privateKey,
    publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  };
}

/** RFC 9449 §4.2: the proof binds the origin + path only, never the query. */
export function normalizeHtu(url: string): string {
  const parsed = new URL(url);
  return parsed.origin + parsed.pathname;
}

async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64url(new Uint8Array(digest));
}

export interface SpaceDpopProofOptions {
  htm: string;
  htu: string;
  /**
   * The space credential this proof is presented with. Omitted on the leg that
   * *obtains* a credential — the alpha rejects an `ath` there ("DPoP proof 'ath'
   * must be omitted when obtaining a credential").
   */
  credential?: string;
}

export async function createSpaceDpopProof(
  key: SpaceDpopKey,
  opts: SpaceDpopProofOptions
): Promise<string> {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk };
  const payload: Record<string, unknown> = {
    jti: randomHex(16),
    htm: opts.htm,
    htu: normalizeHtu(opts.htu),
    iat: Math.floor(Date.now() / 1000),
  };
  if (opts.credential !== undefined) {
    payload.ath = await sha256Base64url(opts.credential);
  }

  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

/** `exp` (seconds) of a JWT, without verifying it — used only for cache expiry. */
export function jwtExpirySeconds(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}
