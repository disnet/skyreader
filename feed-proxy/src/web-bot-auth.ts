// Web Bot Auth: the crawler's cryptographic identity.
//
// Every honest-UA upstream fetch carries an RFC 9421 HTTP Message Signature
// (Ed25519) over the request's authority plus a `Signature-Agent` header that
// points at where our public key lives. A site behind Cloudflare (or any other
// verifier of the draft) can then confirm the request really is Skyreader's
// crawler instead of guessing from the User-Agent string — which is what lets a
// bot-managed site allow us on its own terms. The UA-shape gating that makes
// HONEST_UA get 403'd (see the HONEST_UA comment in app.ts) is exactly the
// guesswork this replaces.
//
// Pieces:
//   - loadWebBotAuth: import the private JWK (a Fly secret) once at boot.
//   - signRequestHeaders: the three headers to add to an outbound request.
//   - signedDirectory: the key directory served at
//     `<signatureAgent>/.well-known/http-message-signatures-directory`. The
//     spec requires the directory response ITSELF to be signed with the key it
//     publishes (so a verifier knows the directory wasn't swapped), and that
//     signature carries a short expiry — so it must be signed per request, not
//     served as a static file. api.skyreader.app is a static-adapter frontend +
//     a Worker; the Worker proxies the well-known path to this endpoint so the
//     private key only ever lives here.
//   - generateWebBotAuthKey: one-off keygen (scripts/generate-web-bot-auth-key.ts).
//
// Spec: draft-meunier-webbotauth-httpsig-protocol (IETF WebBotAuth WG) and its
// directory companion. Cloudflare's verifier is documented at
// https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/
// — the examples there are what the header shapes below are pinned to.
import { sign, generateNonce, type WebBotSigner } from 'web-bot-auth';
import { signerFromJWK } from 'web-bot-auth/crypto';
import { createSignature, component } from 'http-message-sig';

export const HTTP_MESSAGE_SIGNATURES_DIRECTORY_PATH =
  '/.well-known/http-message-signatures-directory';
export const DIRECTORY_CONTENT_TYPE = 'application/http-message-signatures-directory+json';
// Tag the directory response's signature must carry (distinct from the
// request tag `web-bot-auth`, which the library sets for us).
const DIRECTORY_SIGNATURE_TAG = 'http-message-signatures-directory';

// Validity window of a request signature. Generous enough to survive clock
// skew between us and a verifier; short enough that a captured signature is
// worthless quickly (it is also nonce'd, and bound to the target authority).
const REQUEST_SIGNATURE_TTL_MS = 5 * 60 * 1000;
// Validity window of the directory response's self-signature. The response is
// signed fresh per request, so this only needs to cover the hop through the
// Worker plus the verifier's own clock skew.
const DIRECTORY_SIGNATURE_TTL_MS = 5 * 60 * 1000;
// How long a verifier may cache the directory (mirrors Cloudflare's example).
// Independent of the signature TTL: a verifier that honours max-age has already
// verified the signature it cached.
const DIRECTORY_CACHE_MAX_AGE_SECONDS = 86_400;

export interface Ed25519PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
}

export interface WebBotAuth {
  /** Origin the Signature-Agent header points at, e.g. `https://api.skyreader.app`. */
  readonly signatureAgent: string;
  /** JWK SHA-256 thumbprint of the public key (the `keyid` in every signature). */
  readonly keyid: string;
  readonly publicJwk: Ed25519PublicJwk;
  readonly signer: WebBotSigner;
}

/** Headers to merge into an outbound request. All three are required by the spec. */
export type WebBotAuthHeaders = {
  'Signature-Agent': string;
  'Signature-Input': string;
  Signature: string;
};

function assertHttpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `WEB_BOT_AUTH_SIGNATURE_AGENT must be an https origin, got ${JSON.stringify(raw)}`
    );
  }
  if (url.protocol !== 'https:') {
    throw new Error(`WEB_BOT_AUTH_SIGNATURE_AGENT must use https, got ${JSON.stringify(raw)}`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      `WEB_BOT_AUTH_SIGNATURE_AGENT must be a bare origin (no path/query), got ${JSON.stringify(raw)}`
    );
  }
  return url.origin;
}

// The Signature-Agent header value. Cloudflare's documented verifier expects
// the original "structured string" form — a single sf-string holding the
// origin — so that is what we send. (The library's README shows the newer
// dictionary form `sig1="…";type=directory`; the library signs either, and it
// covers the header under the bare `signature-agent` component when given the
// string form, matching Cloudflare's `("@authority" "signature-agent")` example.)
function signatureAgentHeader(origin: string): string {
  return `"${origin}"`;
}

// The signing library accepts an Ed25519 JWK's `alg` only as "EdDSA", while
// WebCrypto's own `exportKey('jwk')` labels the same key "Ed25519" on newer
// runtimes (and omits `alg` entirely on older ones) — so a key exported on one
// Bun can be rejected on another. Reduce every key to the same minimal field
// set before signing with it. The RFC 7638 thumbprint covers only kty/crv/x, so
// the keyid is unaffected by the normalization.
function normalizeEd25519Jwk(jwk: JsonWebKey): JsonWebKey {
  return { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', x: jwk.x, d: jwk.d };
}

/**
 * Load the crawler identity from its private JWK. `key` is the JSON text of an
 * Ed25519 private JWK (`kty: OKP, crv: Ed25519, d, x`) as produced by
 * generateWebBotAuthKey. Throws on any malformed input — a half-configured
 * identity is a boot error, not something to limp along without.
 */
export async function loadWebBotAuth(opts: {
  key: string;
  signatureAgent: string;
}): Promise<WebBotAuth> {
  const signatureAgent = assertHttpsOrigin(opts.signatureAgent);
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(opts.key) as JsonWebKey;
  } catch {
    throw new Error('WEB_BOT_AUTH_KEY must be the JSON text of an Ed25519 private JWK');
  }
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('WEB_BOT_AUTH_KEY must be an Ed25519 JWK (kty=OKP, crv=Ed25519, x)');
  }
  if (typeof jwk.d !== 'string') {
    throw new Error('WEB_BOT_AUTH_KEY must be a PRIVATE JWK (missing "d")');
  }
  const signer = await signerFromJWK(normalizeEd25519Jwk(jwk));
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  return Object.freeze({ signatureAgent, keyid: signer.keyid, publicJwk, signer });
}

/**
 * Sign an outbound request. Covers `@authority` (the host we are talking to,
 * so the signature can't be replayed against another site) and the
 * Signature-Agent header (so a verifier knows where to find our key). Nothing
 * else is covered — deliberately: the caller may still vary User-Agent,
 * conditional-request headers, etc. without invalidating the signature.
 */
export async function signRequestHeaders(
  auth: WebBotAuth,
  url: string,
  opts: { method?: string; now?: Date } = {}
): Promise<WebBotAuthHeaders> {
  const now = opts.now ?? new Date();
  const agent = signatureAgentHeader(auth.signatureAgent);
  const fields = await sign(
    {
      kind: 'request',
      method: opts.method ?? 'GET',
      targetUri: url,
      fields: [{ name: 'signature-agent', value: agent }],
    },
    {
      signer: auth.signer,
      created: now,
      expires: new Date(now.getTime() + REQUEST_SIGNATURE_TTL_MS),
      nonce: generateNonce(),
    }
  );
  return {
    'Signature-Agent': agent,
    'Signature-Input': fields.signatureInput,
    Signature: fields.signature,
  };
}

export type SignedDirectory = {
  body: string;
  headers: {
    'Content-Type': string;
    'Cache-Control': string;
    'Signature-Input': string;
    Signature: string;
  };
};

/**
 * The key directory response, signed for the authority it is published under
 * (`auth.signatureAgent`'s host — NOT this process's own hostname, since the
 * Worker fronting api.skyreader.app is what a verifier actually asks). Signed
 * per call because the signature carries created/expires.
 */
export async function signedDirectory(
  auth: WebBotAuth,
  opts: { now?: Date } = {}
): Promise<SignedDirectory> {
  const now = opts.now ?? new Date();
  const created = Math.floor(now.getTime() / 1000);
  const expires = created + Math.floor(DIRECTORY_SIGNATURE_TTL_MS / 1000);
  const body = JSON.stringify({ keys: [auth.publicJwk] });
  const fields = await createSignature(
    {
      kind: 'response',
      status: 200,
      fields: [{ name: 'content-type', value: DIRECTORY_CONTENT_TYPE }],
      request: {
        kind: 'request',
        method: 'GET',
        targetUri: `${auth.signatureAgent}${HTTP_MESSAGE_SIGNATURES_DIRECTORY_PATH}`,
        fields: [],
      },
    },
    {
      label: 'sig1',
      components: [component('@authority', { req: true })],
      parameters: {
        alg: auth.signer.algorithm,
        keyid: auth.keyid,
        nonce: generateNonce(),
        tag: DIRECTORY_SIGNATURE_TAG,
        created,
        expires,
      },
      signer: auth.signer,
    }
  );
  return {
    body,
    headers: {
      'Content-Type': DIRECTORY_CONTENT_TYPE,
      'Cache-Control': `max-age=${DIRECTORY_CACHE_MAX_AGE_SECONDS}`,
      'Signature-Input': fields.signatureInput,
      Signature: fields.signature,
    },
  };
}

/**
 * Mint a fresh Ed25519 keypair as a private JWK, ready to be stored as the
 * WEB_BOT_AUTH_KEY secret. The public half is what signedDirectory publishes;
 * `kid` is the thumbprint verifiers will see as `keyid`.
 */
export async function generateWebBotAuthKey(): Promise<JsonWebKey & { kid: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (exported.kty !== 'OKP' || exported.crv !== 'Ed25519' || !exported.d || !exported.x) {
    throw new Error('Ed25519 key export produced an unexpected JWK');
  }
  // Normalize first, then derive: WebCrypto's raw export carries ext/key_ops
  // and a runtime-dependent `alg` the signer refuses (see normalizeEd25519Jwk).
  const jwk = normalizeEd25519Jwk(exported);
  const signer = await signerFromJWK(jwk);
  return { ...jwk, kid: signer.keyid };
}
