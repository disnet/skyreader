/**
 * HTTP message signatures for atproto Spaces credentials.
 *
 * The alpha used DPoP here until `0.0.0-spaces-alpha-20261001173819` (atproto PR
 * #5569), which replaced it with an RFC 9421-style signature under the label
 * `atproto-space`. The key is a P-256 `did:key`; there is no `htu`/`htm`/`ath`,
 * no nonce, and nothing about the request URL is signed — only the
 * `authorization` header and, when presenting a credential, the audience DID:
 *
 *   obtaining a credential  Signature-Input: atproto-space=("authorization");keyid="did:key:…"
 *                           (the PDS copies `keyid` into the credential's `cnf.kid`)
 *   presenting one          Signature-Input: atproto-space=("authorization" "atproto-space-audience")
 *                           (no keyid — the verifier takes the key from `cnf.kid`)
 *
 * The signature base is the covered headers, one `"name": value` line each, then
 * `"@signature-params": <inner list>`. The signature is the 64-byte compact r||s
 * that WebCrypto's ECDSA already produces, base64 in a structured-field byte
 * sequence.
 *
 * This is NOT the OAuth path's DPoP (`services/oauth.ts` `createDPoPProof`), and
 * is kept separate on purpose — folding the two would make the OAuth proof's
 * behaviour depend on a spike flag.
 *
 * Shapes verified against `@atproto/space@0.0.0-spaces-alpha-20261001173819`
 * (`dist/http-signature.js`, `createSpaceSig` / `verifySpaceSignature`).
 *
 * WebCrypto + fetch only, so it runs unchanged on Workers and on Node.
 */

export const SPACE_SIGNATURE_LABEL = 'atproto-space';

export interface SpaceSigningKey {
  privateKey: CryptoKey;
  /** `did:key:z…` of the public half — the `keyid` that ends up in `cnf.kid`. */
  did: string;
}

/** Fresh ES256 key. The private half never leaves the isolate — see credential.ts. */
export async function generateSpaceSigningKey(): Promise<SpaceSigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  return { privateKey: pair.privateKey, did: p256DidKey(raw) };
}

// multicodec `p256-pub` (0x1200) as an unsigned varint.
const P256_PUB_MULTICODEC = [0x80, 0x24];

/** `did:key` for an uncompressed (0x04‖x‖y) P-256 public key. */
export function p256DidKey(uncompressed: Uint8Array): string {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error('expected an uncompressed P-256 public key');
  }
  const compressed = new Uint8Array(33);
  compressed[0] = 0x02 | (uncompressed[64] & 1);
  compressed.set(uncompressed.subarray(1, 33), 1);
  return `did:key:z${base58btc(new Uint8Array([...P256_PUB_MULTICODEC, ...compressed]))}`;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btc(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

export interface SpaceSignatureOptions {
  /** The full `Authorization` header value being signed. */
  authorization: string;
  /**
   * The DID the request is addressed to — set when presenting a credential, never
   * when obtaining one. For record reads it is the repo DID being read; for
   * space-host methods (listRepos, registerNotify, …) the space authority.
   */
  audience?: string;
}

/** Build the authorization, audience and signature headers for one space request. */
export async function createSpaceSignatureHeaders(
  key: SpaceSigningKey,
  opts: SpaceSignatureOptions
): Promise<Record<string, string>> {
  const signatureInput =
    opts.audience === undefined
      ? `("authorization");keyid="${key.did}"`
      : '("authorization" "atproto-space-audience")';

  const lines = [`"authorization": ${opts.authorization.trim()}`];
  if (opts.audience !== undefined) {
    lines.push(`"atproto-space-audience": ${opts.audience.trim()}`);
  }
  lines.push(`"@signature-params": ${signatureInput}`);

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key.privateKey,
      new TextEncoder().encode(lines.join('\n'))
    )
  );

  return {
    authorization: opts.authorization,
    ...(opts.audience !== undefined ? { 'atproto-space-audience': opts.audience } : {}),
    'signature-input': `${SPACE_SIGNATURE_LABEL}=${signatureInput}`,
    signature: `${SPACE_SIGNATURE_LABEL}=:${base64(signature)}:`,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
