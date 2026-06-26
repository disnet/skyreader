import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p256 } from '@noble/curves/nist.js';
import { base58, base64urlnopad } from '@scure/base';

// Test helpers for minting real atproto service-auth JWTs and the matching Multikey,
// so service-auth verification is exercised against genuine signatures (not mocks).

type CurveName = 'k256' | 'p256';

function curveFor(name: CurveName) {
  return name === 'k256' ? secp256k1 : p256;
}

function b64urlJson(obj: unknown): string {
  return base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(obj)));
}

// Encode a compressed public key as a did:key/Multikey publicKeyMultibase string.
export function multikeyFor(curve: CurveName, pubCompressed: Uint8Array): string {
  const prefix = curve === 'k256' ? new Uint8Array([0xe7, 0x01]) : new Uint8Array([0x80, 0x24]);
  const bytes = new Uint8Array(prefix.length + pubCompressed.length);
  bytes.set(prefix);
  bytes.set(pubCompressed, prefix.length);
  return 'z' + base58.encode(bytes);
}

export function genKeypair(curve: CurveName = 'k256') {
  const c = curveFor(curve);
  const sk = c.utils.randomSecretKey();
  const pub = c.getPublicKey(sk, true);
  return { curve, sk, pub, multibase: multikeyFor(curve, pub) };
}

export async function mintServiceJwt(opts: {
  curve?: CurveName;
  privateKey: Uint8Array;
  claims: Record<string, unknown>;
  alg?: string; // override the header alg (to test alg/curve mismatch)
}): Promise<string> {
  const curve = opts.curve ?? 'k256';
  const c = curveFor(curve);
  const alg = opts.alg ?? (curve === 'k256' ? 'ES256K' : 'ES256');
  const header = b64urlJson({ typ: 'JWT', alg });
  const payload = b64urlJson(opts.claims);
  const signingInput = `${header}.${payload}`;
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signingInput))
  );
  const sig = c.sign(hash, opts.privateKey, { prehash: false, format: 'compact' });
  return `${signingInput}.${base64urlnopad.encode(sig)}`;
}

// Corrupt the signature segment of a JWT (flip a byte) without changing its length, to
// produce a structurally valid but cryptographically invalid token.
export function corruptSignature(jwt: string): string {
  const [h, p, s] = jwt.split('.');
  const sig = base64urlnopad.decode(s);
  sig[sig.length - 1] ^= 0xff;
  return `${h}.${p}.${base64urlnopad.encode(sig)}`;
}
