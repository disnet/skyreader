import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveAtprotoSigningKey } from '../src/utils/did-resolver';

// A minimal DID document carrying an #atproto verification method.
function didDoc(multibase: string) {
  return {
    ok: true,
    json: async () => ({
      id: 'did:web:example.com',
      verificationMethod: [{ id: 'did:web:example.com#atproto', publicKeyMultibase: multibase }],
    }),
  } as Response;
}

afterEach(() => vi.restoreAllMocks());

describe('resolveAtprotoSigningKey did:web host validation (SSRF guard)', () => {
  // Hosts that must be rejected BEFORE any network fetch happens.
  const forbidden = [
    'did:web:localhost',
    'did:web:127.0.0.1',
    'did:web:169.254.169.254', // cloud metadata endpoint
    'did:web:10.0.0.1',
    'did:web:192.168.1.1',
    'did:web:example.com%3A8080', // percent-encoded port
    'did:web:db.internal',
    'did:web:host.local',
    'did:web:example.com:user:alice', // path-form did:web
    'did:web:nodot',
  ];

  for (const did of forbidden) {
    it(`rejects ${did} without fetching`, async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const key = await resolveAtprotoSigningKey(did);
      expect(key).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('resolves a bare public domain and fetches its well-known did.json', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(didDoc('zPublicKeyMultibase'));

    const key = await resolveAtprotoSigningKey('did:web:example.com');

    expect(key).toBe('zPublicKeyMultibase');
    // Must not follow redirects — the host was vetted, but a redirect could escape it.
    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/.well-known/did.json', {
      redirect: 'manual',
    });
  });

  it('does not follow a redirect to an internal address (SSRF guard)', async () => {
    // A vetted public host whose did.json 302s toward an internal target. With
    // redirect:'manual' the 3xx surfaces as a non-ok response, so resolution fails
    // rather than chasing the redirect.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 302,
      json: async () => ({}),
    } as Response);

    const key = await resolveAtprotoSigningKey('did:web:example.com');

    expect(key).toBeNull();
  });
});
