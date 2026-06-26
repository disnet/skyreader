import { describe, it, expect, vi, afterEach } from 'vitest';
import * as didResolver from '../src/utils/did-resolver';
import { verifyServiceAuth } from '../src/services/service-auth';
import { SKYREADER_APP_DID } from '../src/config/identity';
import { genKeypair, mintServiceJwt, corruptSignature } from './helpers/jwt';

const USER_DID = 'did:plc:serviceauthuser';
const LXM = 'app.skyreader.feed.save';
const NOW = 1_900_000_000; // fixed reference time (seconds)

function claims(over: Record<string, unknown> = {}) {
  return { iss: USER_DID, aud: SKYREADER_APP_DID, lxm: LXM, exp: NOW + 60, ...over };
}

afterEach(() => vi.restoreAllMocks());

describe('verifyServiceAuth', () => {
  it('accepts a valid ES256K (secp256k1) token and returns the issuer DID', async () => {
    const kp = genKeypair('k256');
    vi.spyOn(didResolver, 'resolveAtprotoSigningKey').mockResolvedValue(kp.multibase);
    const jwt = await mintServiceJwt({ curve: 'k256', privateKey: kp.sk, claims: claims() });

    const r = await verifyServiceAuth(jwt, { lxm: LXM, now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.did).toBe(USER_DID);
  });

  it('accepts a valid ES256 (P-256) token', async () => {
    const kp = genKeypair('p256');
    vi.spyOn(didResolver, 'resolveAtprotoSigningKey').mockResolvedValue(kp.multibase);
    const jwt = await mintServiceJwt({ curve: 'p256', privateKey: kp.sk, claims: claims() });

    const r = await verifyServiceAuth(jwt, { lxm: LXM, now: NOW });
    expect(r.ok).toBe(true);
  });

  it('rejects a token whose audience is not Skyreader', async () => {
    const kp = genKeypair();
    vi.spyOn(didResolver, 'resolveAtprotoSigningKey').mockResolvedValue(kp.multibase);
    const jwt = await mintServiceJwt({
      privateKey: kp.sk,
      claims: claims({ aud: 'did:plc:someoneelse' }),
    });

    const r = await verifyServiceAuth(jwt, { lxm: LXM, now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/audience/i);
  });

  it('rejects an expired token', async () => {
    const kp = genKeypair();
    vi.spyOn(didResolver, 'resolveAtprotoSigningKey').mockResolvedValue(kp.multibase);
    const jwt = await mintServiceJwt({ privateKey: kp.sk, claims: claims({ exp: NOW - 120 }) });

    const r = await verifyServiceAuth(jwt, { lxm: LXM, now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/expired/i);
  });

  it('rejects a token whose lifetime exceeds the allowed maximum', async () => {
    const kp = genKeypair();
    vi.spyOn(didResolver, 'resolveAtprotoSigningKey').mockResolvedValue(kp.multibase);
    // exp far in the future (1 hour out) — valid signature, but too long-lived.
    const jwt = await mintServiceJwt({ privateKey: kp.sk, claims: claims({ exp: NOW + 3600 }) });

    const r = await verifyServiceAuth(jwt, { lxm: LXM, now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/lifetime/i);
  });

  it('rejects a token minted for a different method (lxm)', async () => {
    const kp = genKeypair();
    vi.spyOn(didResolver, 'resolveAtprotoSigningKey').mockResolvedValue(kp.multibase);
    const jwt = await mintServiceJwt({ privateKey: kp.sk, claims: claims() }); // lxm = save

    const r = await verifyServiceAuth(jwt, { lxm: 'app.skyreader.linkblog.share', now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/method/i);
  });

  it('rejects a token with a corrupted signature', async () => {
    const kp = genKeypair();
    vi.spyOn(didResolver, 'resolveAtprotoSigningKey').mockResolvedValue(kp.multibase);
    const jwt = corruptSignature(await mintServiceJwt({ privateKey: kp.sk, claims: claims() }));

    const r = await verifyServiceAuth(jwt, { lxm: LXM, now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/signature/i);
  });

  it('rejects when the header alg does not match the signing key curve', async () => {
    const kp = genKeypair('k256');
    vi.spyOn(didResolver, 'resolveAtprotoSigningKey').mockResolvedValue(kp.multibase);
    // Signed with a secp256k1 key but the header claims ES256 (P-256).
    const jwt = await mintServiceJwt({
      curve: 'k256',
      privateKey: kp.sk,
      claims: claims(),
      alg: 'ES256',
    });

    const r = await verifyServiceAuth(jwt, { lxm: LXM, now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/curve/i);
  });

  it('rejects when the issuer signing key cannot be resolved', async () => {
    const kp = genKeypair();
    vi.spyOn(didResolver, 'resolveAtprotoSigningKey').mockResolvedValue(null);
    const jwt = await mintServiceJwt({ privateKey: kp.sk, claims: claims() });

    const r = await verifyServiceAuth(jwt, { lxm: LXM, now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/signing key/i);
  });
});
