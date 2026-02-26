import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('API routes', () => {
  describe('client metadata', () => {
    it('returns valid OAuth client metadata', async () => {
      const response = await SELF.fetch('http://localhost/.well-known/client-metadata');
      expect(response.status).toBe(200);

      const metadata = (await response.json()) as Record<string, unknown>;
      expect(metadata.client_id).toContain('/.well-known/client-metadata');
      expect(metadata.client_name).toBe('Skyreader');
      expect(metadata.grant_types).toContain('authorization_code');
      expect(metadata.dpop_bound_access_tokens).toBe(true);
      expect(Array.isArray(metadata.redirect_uris)).toBe(true);

      // Verify confidential client configuration
      expect(metadata.token_endpoint_auth_method).toBe('private_key_jwt');
      expect(metadata.token_endpoint_auth_signing_alg).toBe('ES256');
      expect(metadata.jwks).toBeDefined();
      const jwks = metadata.jwks as {
        keys: Array<{ kty: string; crv: string; use: string; alg: string }>;
      };
      expect(jwks.keys).toBeDefined();
      expect(jwks.keys.length).toBeGreaterThan(0);
      expect(jwks.keys[0].kty).toBe('EC');
      expect(jwks.keys[0].crv).toBe('P-256');
      expect(jwks.keys[0].use).toBe('sig');
      expect(jwks.keys[0].alg).toBe('ES256');
    });

    it('returns Cache-Control header', async () => {
      const response = await SELF.fetch('http://localhost/.well-known/client-metadata');
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    });
  });

  describe('auth endpoints', () => {
    it('GET /api/auth/me returns 401 without authorization', async () => {
      const response = await SELF.fetch('http://localhost/api/auth/me');
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    });

    it('GET /api/auth/me returns 401 with invalid token', async () => {
      const response = await SELF.fetch('http://localhost/api/auth/me', {
        headers: { Authorization: 'Bearer invalid-token' },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    });

    it('GET /api/auth/login returns 400 without handle', async () => {
      const response = await SELF.fetch('http://localhost/api/auth/login');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Missing handle parameter' });
    });
  });

  describe('CORS', () => {
    it('OPTIONS requests return CORS headers', async () => {
      const request = new IncomingRequest('http://localhost/api/auth/me', {
        method: 'OPTIONS',
        headers: { Origin: env.FRONTEND_URL },
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    });
  });

  describe('404 handling', () => {
    it('returns 404 JSON for unknown routes', async () => {
      const response = await SELF.fetch('http://localhost/api/unknown/route');
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not found' });
    });
  });
});
