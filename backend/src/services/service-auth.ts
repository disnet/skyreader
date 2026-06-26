import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p256 } from '@noble/curves/nist.js';
import { base58, base64urlnopad } from '@scure/base';
import { SKYREADER_APP_DID } from '../config/identity';
import { resolveAtprotoSigningKey } from '../utils/did-resolver';

// atproto inter-service authentication ("service auth").
//
// A consumer that holds a user's session mints a short-lived JWT via the user's PDS
// (com.atproto.server.getServiceAuth), signed by the USER's atproto signing key, with:
//   iss = the user's DID, aud = the service's DID, lxm = the XRPC method, exp = soon.
// We verify it by resolving the issuer's signing key from their DID document and checking
// the signature + claims. A valid token proves "this request is user <iss>"; it does NOT
// grant us access to their PDS — the caller maps the verified DID to a stored Skyreader
// session to actually act.
//
// Workers' WebCrypto can't verify secp256k1 (ES256K), which is the atproto default, so we
// use @noble/curves for both ES256K (secp256k1) and ES256 (P-256).

const CLOCK_SKEW_SEC = 30;

// Upper bound on a token's remaining lifetime. atproto service-auth tokens are meant to
// be short-lived (the convention is ~60s); we hold close to that, allowing only modest
// slack for slow consumers (plus CLOCK_SKEW_SEC on top at the check site). A short window
// is the primary control against replay: these JWTs carry no jti/nonce and bind only the
// method (lxm), NOT the call's parameters, so a leaked token can be replayed with
// attacker-chosen params (e.g. an arbitrary public linkblog post) until it expires. The
// tighter this is, the smaller that window.
const MAX_LIFETIME_SEC = 2 * 60;

export type VerifyResult =
  | { ok: true; did: string }
  | { ok: false; error: string; message: string };

function fail(message: string): VerifyResult {
  return { ok: false, error: 'AuthenticationRequired', message };
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64urlnopad.decode(segment)));
}

// Decode a Multikey publicKeyMultibase (base58btc, multicodec-prefixed) into a curve +
// compressed public key. secp256k1-pub = multicodec 0xe7 (varint [0xe7,0x01]); p256-pub =
// 0x1200 (varint [0x80,0x24]). Both prefixes are 2 bytes, followed by the 33-byte key.
function decodeMultikey(multibase: string): { curve: 'k256' | 'p256'; key: Uint8Array } | null {
  if (!multibase.startsWith('z')) return null; // 'z' = base58btc multibase prefix
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(multibase.slice(1));
  } catch {
    return null;
  }
  if (bytes.length < 3) return null;
  if (bytes[0] === 0xe7 && bytes[1] === 0x01) return { curve: 'k256', key: bytes.slice(2) };
  if (bytes[0] === 0x80 && bytes[1] === 0x24) return { curve: 'p256', key: bytes.slice(2) };
  return null;
}

interface JwtPayload {
  iss?: string;
  aud?: string;
  exp?: number;
  lxm?: string;
}

/**
 * Verify an atproto service-auth JWT bound to a specific XRPC method (`lxm`). On success
 * returns the verified issuer DID. Every failure is non-fatal and returns a reason; the
 * caller surfaces it as an XRPC AuthenticationRequired error.
 */
export async function verifyServiceAuth(
  token: string,
  opts: { lxm: string; now?: number }
): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return fail('Malformed service-auth token.');

  let header: { alg?: string };
  let payload: JwtPayload;
  try {
    header = decodeJsonSegment(parts[0]) as { alg?: string };
    payload = decodeJsonSegment(parts[1]) as JwtPayload;
  } catch {
    return fail('Service-auth token is not a valid JWT.');
  }

  const alg = header?.alg;
  if (alg !== 'ES256K' && alg !== 'ES256') return fail(`Unsupported JWT alg: ${alg}.`);

  // Claim checks first (cheap) before resolving the key (a network fetch).
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload?.exp !== 'number' || now > payload.exp + CLOCK_SKEW_SEC) {
    return fail('Service-auth token has expired.');
  }
  if (payload.exp - now > MAX_LIFETIME_SEC + CLOCK_SKEW_SEC) {
    return fail('Service-auth token lifetime exceeds the allowed maximum.');
  }
  if (payload?.aud !== SKYREADER_APP_DID) {
    return fail('Service-auth token audience does not match Skyreader.');
  }
  if (payload?.lxm !== opts.lxm) {
    return fail(`Service-auth token is not scoped to this method (${opts.lxm}).`);
  }
  const iss = payload?.iss;
  if (typeof iss !== 'string' || !iss.startsWith('did:')) {
    return fail('Service-auth token has no valid issuer DID.');
  }

  const multibase = await resolveAtprotoSigningKey(iss);
  if (!multibase) return fail(`Could not resolve a signing key for ${iss}.`);
  const decoded = decodeMultikey(multibase);
  if (!decoded) return fail('Issuer signing key uses an unsupported type.');

  // The JWT alg must match the resolved key's curve (block curve-confusion).
  const algIsK256 = alg === 'ES256K';
  if (algIsK256 !== (decoded.curve === 'k256')) {
    return fail('JWT alg does not match the issuer signing key curve.');
  }

  let sig: Uint8Array;
  try {
    sig = base64urlnopad.decode(parts[2]);
  } catch {
    return fail('Service-auth token signature is not valid base64url.');
  }
  if (sig.length !== 64) return fail('Service-auth token signature has an unexpected length.');

  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', signingInput));
  const curve = decoded.curve === 'k256' ? secp256k1 : p256;

  let valid = false;
  try {
    valid = curve.verify(sig, hash, decoded.key, { prehash: false });
  } catch {
    valid = false;
  }
  if (!valid) return fail('Service-auth token signature is invalid.');

  return { ok: true, did: iss };
}
