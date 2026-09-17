import { describe, expect, it } from 'bun:test';
import { verify } from 'web-bot-auth';
import { verifierFromJWK } from 'web-bot-auth/crypto';
import { verifySignature, component } from 'http-message-sig';
import {
  generateWebBotAuthKey,
  loadWebBotAuth,
  signRequestHeaders,
  signedDirectory,
  HTTP_MESSAGE_SIGNATURES_DIRECTORY_PATH,
  DIRECTORY_CONTENT_TYPE,
} from './web-bot-auth';

const AGENT = 'https://api.skyreader.app';

async function freshAuth() {
  const jwk = await generateWebBotAuthKey();
  const auth = await loadWebBotAuth({ key: JSON.stringify(jwk), signatureAgent: AGENT });
  const verifier = await verifierFromJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x } as JsonWebKey);
  return { jwk, auth, verifier };
}

describe('loadWebBotAuth', () => {
  it('derives the keyid from the JWK thumbprint and keeps only the public half', async () => {
    const { jwk, auth } = await freshAuth();
    expect(auth.keyid).toBe(jwk.kid);
    expect(auth.publicJwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: jwk.x! });
    expect(JSON.stringify(auth.publicJwk)).not.toContain(jwk.d!);
    expect(auth.signatureAgent).toBe(AGENT);
  });

  it('rejects a public-only key, a non-Ed25519 key, garbage, and a bad agent origin', async () => {
    const jwk = await generateWebBotAuthKey();
    const { d: _d, ...pub } = jwk;
    await expect(
      loadWebBotAuth({ key: JSON.stringify(pub), signatureAgent: AGENT })
    ).rejects.toThrow(/PRIVATE/);
    await expect(
      loadWebBotAuth({ key: JSON.stringify({ ...jwk, crv: 'P-256' }), signatureAgent: AGENT })
    ).rejects.toThrow(/Ed25519/);
    await expect(loadWebBotAuth({ key: 'not json', signatureAgent: AGENT })).rejects.toThrow(
      /JSON/
    );
    for (const bad of ['http://api.skyreader.app', 'https://api.skyreader.app/dir', 'nope']) {
      await expect(
        loadWebBotAuth({ key: JSON.stringify(jwk), signatureAgent: bad })
      ).rejects.toThrow(/WEB_BOT_AUTH_SIGNATURE_AGENT/);
    }
  });

  // WebCrypto's exportKey('jwk') labels an Ed25519 key `alg: "Ed25519"` on newer
  // runtimes and omits `alg` on older ones, while the signing library accepts
  // only "EdDSA". A key minted on one Bun has to load on another, so every
  // spelling is normalized before it reaches the signer.
  it('accepts an Ed25519 JWK however its alg is spelled', async () => {
    const jwk = await generateWebBotAuthKey();
    expect(jwk.alg).toBe('EdDSA');
    const { alg: _alg, kid: _kid, ...bare } = jwk;
    for (const variant of [bare, { ...bare, alg: 'Ed25519' }, { ...bare, alg: 'EdDSA' }]) {
      const auth = await loadWebBotAuth({
        key: JSON.stringify(variant),
        signatureAgent: AGENT,
      });
      expect(auth.keyid).toBe(jwk.kid);
    }
  });

  it('normalizes a trailing slash off the agent origin', async () => {
    const jwk = await generateWebBotAuthKey();
    const auth = await loadWebBotAuth({ key: JSON.stringify(jwk), signatureAgent: `${AGENT}/` });
    expect(auth.signatureAgent).toBe(AGENT);
  });
});

describe('signRequestHeaders', () => {
  it('produces headers Cloudflare-shaped signatures a verifier accepts', async () => {
    const { auth, verifier } = await freshAuth();
    const headers = await signRequestHeaders(auth, 'https://example.com/feed.xml');

    // Pinned to the shape in Cloudflare's Web Bot Auth reference: the string
    // form of Signature-Agent, and a signature over @authority + signature-agent
    // tagged web-bot-auth.
    expect(headers['Signature-Agent']).toBe('"https://api.skyreader.app"');
    expect(headers['Signature-Input']).toMatch(/^sig1=\("@authority" "signature-agent"\);/);
    expect(headers['Signature-Input']).toContain('tag="web-bot-auth"');
    expect(headers['Signature-Input']).toContain(`keyid="${auth.keyid}"`);
    expect(headers['Signature-Input']).toMatch(/;alg="ed25519"/);
    expect(headers['Signature-Input']).toMatch(/;created=\d+/);
    expect(headers['Signature-Input']).toMatch(/;expires=\d+/);
    expect(headers['Signature-Input']).toMatch(/;nonce="[^"]+"/);

    const request = new Request('https://example.com/feed.xml', { headers });
    const verified = await verify(request, { resolver: () => verifier, validate: () => {} });
    expect(verified.signatureAgent?.uri).toBe(AGENT);
  });

  it('binds the signature to the target authority', async () => {
    const { auth, verifier } = await freshAuth();
    const headers = await signRequestHeaders(auth, 'https://example.com/feed.xml');
    const replayed = new Request('https://other.example/feed.xml', { headers });
    await expect(
      verify(replayed, { resolver: () => verifier, validate: () => {} })
    ).rejects.toThrow();
  });

  it('uses a fresh nonce per request', async () => {
    const { auth } = await freshAuth();
    const a = await signRequestHeaders(auth, 'https://example.com/a');
    const b = await signRequestHeaders(auth, 'https://example.com/a');
    expect(a.Signature).not.toBe(b.Signature);
  });
});

describe('signedDirectory', () => {
  it('publishes the public JWK with a self-signature over the published authority', async () => {
    const { auth, verifier, jwk } = await freshAuth();
    const dir = await signedDirectory(auth);

    expect(JSON.parse(dir.body)).toEqual({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: jwk.x }] });
    expect(dir.body).not.toContain(jwk.d!);
    expect(dir.headers['Content-Type']).toBe(DIRECTORY_CONTENT_TYPE);
    expect(dir.headers['Cache-Control']).toBe('max-age=86400');
    expect(dir.headers['Signature-Input']).toMatch(/^sig1=\("@authority";req\);/);
    expect(dir.headers['Signature-Input']).toContain('tag="http-message-signatures-directory"');

    // Verify the way a client fetching api.skyreader.app would.
    const verified = await verifySignature(
      {
        kind: 'response',
        status: 200,
        fields: [
          { name: 'content-type', value: dir.headers['Content-Type'] },
          { name: 'signature', value: dir.headers.Signature },
          { name: 'signature-input', value: dir.headers['Signature-Input'] },
        ],
        request: {
          kind: 'request',
          method: 'GET',
          targetUri: `${AGENT}${HTTP_MESSAGE_SIGNATURES_DIRECTORY_PATH}`,
          fields: [],
        },
      },
      {
        policy: {
          algorithms: ['ed25519'],
          requiredComponents: [component('@authority', { req: true })],
          requiredParameters: ['created', 'expires', 'keyid', 'tag', 'nonce'],
        },
        resolveVerifier: (candidate) => {
          expect(candidate.parameters.keyid).toBe(auth.keyid);
          return verifier;
        },
      }
    );
    expect(verified.parameters.tag).toBe('http-message-signatures-directory');

    // And NOT for a directory served under some other host (e.g. the Fly hostname).
    await expect(
      verifySignature(
        {
          kind: 'response',
          status: 200,
          fields: [
            { name: 'signature', value: dir.headers.Signature },
            { name: 'signature-input', value: dir.headers['Signature-Input'] },
          ],
          request: {
            kind: 'request',
            method: 'GET',
            targetUri: `https://skyreader-feed-proxy.fly.dev${HTTP_MESSAGE_SIGNATURES_DIRECTORY_PATH}`,
            fields: [],
          },
        },
        {
          policy: {
            algorithms: ['ed25519'],
            requiredComponents: [component('@authority', { req: true })],
            requiredParameters: ['created', 'expires', 'keyid', 'tag'],
          },
          resolveVerifier: () => verifier,
        }
      )
    ).rejects.toThrow();
  });
});
