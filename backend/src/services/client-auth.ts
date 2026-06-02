/**
 * Client Authentication Service for OAuth Confidential Client
 *
 * Implements private_key_jwt authentication per RFC 7523 and AT Protocol spec.
 * The client uses ES256 (ECDSA with P-256 curve) for signing client assertions.
 */

import type { Env } from '../types';
import { generateRandomString } from './oauth';

// Extended JWK type with optional kid field
interface JWKWithKid extends JsonWebKey {
  kid?: string;
}

// Cache for imported key pair to avoid repeated imports
let cachedKeyPair: {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  kid: string;
} | null = null;

/**
 * Clear the cached key pair (for testing purposes only).
 */
export function clearKeyPairCache(): void {
  cachedKeyPair = null;
}

/**
 * Import the client signing key from environment secret.
 * The key is expected to be a JWK-encoded ES256 private key.
 */
export async function getClientKeyPair(
  env: Env
): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; kid: string }> {
  // Return cached key pair if available
  if (cachedKeyPair) {
    return cachedKeyPair;
  }

  const keySecret = (env as Env & { CLIENT_SIGNING_KEY?: string }).CLIENT_SIGNING_KEY;
  if (!keySecret) {
    throw new Error('CLIENT_SIGNING_KEY secret is not configured');
  }

  let privateKeyJwk: JWKWithKid;
  try {
    privateKeyJwk = JSON.parse(keySecret) as JWKWithKid;
  } catch {
    throw new Error('CLIENT_SIGNING_KEY is not valid JSON');
  }

  // Validate JWK structure
  if (privateKeyJwk.kty !== 'EC' || privateKeyJwk.crv !== 'P-256' || !privateKeyJwk.d) {
    throw new Error('CLIENT_SIGNING_KEY must be an ES256 (P-256) private key');
  }

  // Import private key
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, // not extractable
    ['sign']
  );

  // Derive public key JWK (remove private component)
  const publicKeyJwk: JsonWebKey = {
    kty: privateKeyJwk.kty,
    crv: privateKeyJwk.crv,
    x: privateKeyJwk.x,
    y: privateKeyJwk.y,
  };

  // Import public key
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, // extractable for JWKS
    ['verify']
  );

  // Use kid from JWK or generate from thumbprint
  const kid = privateKeyJwk.kid || (await generateKeyThumbprint(publicKeyJwk));

  cachedKeyPair = { privateKey, publicKey, kid };
  return cachedKeyPair;
}

/**
 * Generate a key thumbprint (kid) from a JWK per RFC 7638.
 */
async function generateKeyThumbprint(jwk: JsonWebKey): Promise<string> {
  // For EC keys, the thumbprint is computed from {crv, kty, x, y} in lexicographic order
  const thumbprintInput = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });

  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(thumbprintInput));
  return base64UrlEncode(new Uint8Array(hash));
}

// Extended JWK type for JWKS response (includes standard JOSE header parameters)
interface JWKSKey extends JWKWithKid {
  use?: string;
  alg?: string;
}

/**
 * Get the JWKS (JSON Web Key Set) containing the client's public key.
 * This is returned in the client metadata for the auth server to verify client assertions.
 */
export async function getClientJWKS(env: Env): Promise<{ keys: JWKSKey[] }> {
  const { publicKey, kid } = await getClientKeyPair(env);

  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', publicKey)) as JWKWithKid;

  return {
    keys: [
      {
        ...publicKeyJwk,
        kid,
        use: 'sig',
        alg: 'ES256',
      },
    ],
  };
}

/**
 * Create a client assertion JWT for authenticating to the authorization server.
 *
 * The assertion is a signed JWT per RFC 7523 with:
 * - Header: typ=JWT, alg=ES256, kid
 * - Payload: iss, sub (both = client_id), aud (auth server issuer), jti, iat, exp
 */
export async function createClientAssertion(
  env: Env,
  audience: string,
  clientId: string
): Promise<string> {
  const { privateKey, kid } = await getClientKeyPair(env);

  const now = Math.floor(Date.now() / 1000);

  const header = {
    typ: 'JWT',
    alg: 'ES256',
    kid,
  };

  const payload = {
    iss: clientId,
    sub: clientId,
    aud: audience,
    jti: generateRandomString(16),
    iat: now,
    exp: now + 60, // 60 second expiry
  };

  const encodedHeader = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  const encodedSignature = base64UrlEncode(new Uint8Array(signature));

  return `${signingInput}.${encodedSignature}`;
}

/**
 * Base64URL encode a Uint8Array or string.
 */
function base64UrlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
