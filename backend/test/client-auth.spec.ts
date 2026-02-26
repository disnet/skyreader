import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  getClientKeyPair,
  getClientJWKS,
  createClientAssertion,
  clearKeyPairCache,
} from '../src/services/client-auth';
import type { Env } from '../src/types';

// Generate a test ES256 key pair for testing
async function generateTestKey(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);

  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

  // Generate kid
  const thumbprintInput = JSON.stringify({
    crv: publicKeyJwk.crv,
    kty: publicKeyJwk.kty,
    x: publicKeyJwk.x,
    y: publicKeyJwk.y,
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(thumbprintInput));
  const kid = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return JSON.stringify({ ...privateKeyJwk, kid });
}

// Helper to create a mock Env with the test key
function createMockEnv(clientSigningKey: string): Env {
  return {
    CLIENT_SIGNING_KEY: clientSigningKey,
    // Minimal mock for other required properties
    FRONTEND_URL: 'http://localhost:5173',
    DB: {} as D1Database,
    REALTIME_HUB: {} as DurableObjectNamespace,
    JETSTREAM_POLLER: {} as DurableObjectNamespace,
    FEED_REFRESHER: {} as DurableObjectNamespace,
  } as Env;
}

// Helper to decode base64url
function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

describe('client-auth service', () => {
  let testKeyJson: string;

  beforeAll(async () => {
    testKeyJson = await generateTestKey();
  });

  // Clear the key pair cache before each test to ensure isolation
  beforeEach(() => {
    clearKeyPairCache();
  });

  describe('getClientKeyPair', () => {
    it('imports ES256 private key from secret', async () => {
      const env = createMockEnv(testKeyJson);
      const keyPair = await getClientKeyPair(env);

      expect(keyPair.privateKey).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.kid).toBeDefined();
      expect(typeof keyPair.kid).toBe('string');
      expect(keyPair.kid.length).toBeGreaterThan(0);
    });

    it('throws error when CLIENT_SIGNING_KEY is not configured', async () => {
      const env = createMockEnv('');
      (env as Env & { CLIENT_SIGNING_KEY?: string }).CLIENT_SIGNING_KEY = undefined;

      await expect(getClientKeyPair(env)).rejects.toThrow(
        'CLIENT_SIGNING_KEY secret is not configured'
      );
    });

    it('throws error for invalid JSON', async () => {
      const env = createMockEnv('not-valid-json');

      await expect(getClientKeyPair(env)).rejects.toThrow('CLIENT_SIGNING_KEY is not valid JSON');
    });

    it('throws error for non-ES256 key', async () => {
      const env = createMockEnv(JSON.stringify({ kty: 'RSA', n: 'test', e: 'AQAB' }));

      await expect(getClientKeyPair(env)).rejects.toThrow(
        'CLIENT_SIGNING_KEY must be an ES256 (P-256) private key'
      );
    });
  });

  describe('getClientJWKS', () => {
    it('returns JWKS with public key', async () => {
      const env = createMockEnv(testKeyJson);
      const jwks = await getClientJWKS(env);

      expect(jwks.keys).toBeDefined();
      expect(Array.isArray(jwks.keys)).toBe(true);
      expect(jwks.keys.length).toBe(1);

      const publicKey = jwks.keys[0];
      expect(publicKey.kty).toBe('EC');
      expect(publicKey.crv).toBe('P-256');
      expect(publicKey.use).toBe('sig');
      expect(publicKey.alg).toBe('ES256');
      expect(publicKey.kid).toBeDefined();
      expect(publicKey.x).toBeDefined();
      expect(publicKey.y).toBeDefined();
      // Private key component should not be included
      expect(publicKey.d).toBeUndefined();
    });
  });

  describe('createClientAssertion', () => {
    it('creates a valid JWT structure', async () => {
      const env = createMockEnv(testKeyJson);
      const audience = 'https://bsky.social';
      const clientId = 'https://api.skyreader.app/.well-known/client-metadata';

      const assertion = await createClientAssertion(env, audience, clientId);

      // JWT should have 3 parts
      const parts = assertion.split('.');
      expect(parts.length).toBe(3);

      // Decode and verify header
      const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
      expect(header.typ).toBe('JWT');
      expect(header.alg).toBe('ES256');
      expect(header.kid).toBeDefined();

      // Decode and verify payload
      const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
      expect(payload.iss).toBe(clientId);
      expect(payload.sub).toBe(clientId);
      expect(payload.aud).toBe(audience);
      expect(payload.jti).toBeDefined();
      expect(typeof payload.jti).toBe('string');
      expect(payload.iat).toBeDefined();
      expect(typeof payload.iat).toBe('number');
      expect(payload.exp).toBeDefined();
      expect(typeof payload.exp).toBe('number');

      // Verify expiry is ~60 seconds in the future
      expect(payload.exp - payload.iat).toBe(60);
    });

    it('creates unique jti for each assertion', async () => {
      const env = createMockEnv(testKeyJson);
      const audience = 'https://bsky.social';
      const clientId = 'https://api.skyreader.app/.well-known/client-metadata';

      const assertion1 = await createClientAssertion(env, audience, clientId);
      const assertion2 = await createClientAssertion(env, audience, clientId);

      const parts1 = assertion1.split('.');
      const parts2 = assertion2.split('.');

      const payload1 = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts1[1])));
      const payload2 = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts2[1])));

      expect(payload1.jti).not.toBe(payload2.jti);
    });

    it('creates verifiable signature', async () => {
      const env = createMockEnv(testKeyJson);
      const audience = 'https://bsky.social';
      const clientId = 'https://api.skyreader.app/.well-known/client-metadata';

      const assertion = await createClientAssertion(env, audience, clientId);
      const parts = assertion.split('.');

      // Get the public key for verification
      const { publicKey } = await getClientKeyPair(env);

      // Verify the signature
      const signingInput = `${parts[0]}.${parts[1]}`;
      const signature = base64UrlDecode(parts[2]);

      const isValid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        signature,
        new TextEncoder().encode(signingInput)
      );

      expect(isValid).toBe(true);
    });
  });
});
