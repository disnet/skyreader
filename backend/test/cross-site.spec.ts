import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { isCrossSiteWrite } from '../src/utils/cross-site';

const ALLOWED = ['https://skyreader.app', 'https://staging.skyreader.app'];

function req(method: string, headers: Record<string, string>) {
  return new Request('https://api.skyreader.app/api/saved/delete', { method, headers });
}

describe('isCrossSiteWrite', () => {
  const cookie = { Cookie: 'session_id=abc' };

  it('refuses a cookie-bearing write the browser marks cross-site', () => {
    expect(
      isCrossSiteWrite(req('POST', { ...cookie, 'Sec-Fetch-Site': 'cross-site' }), ALLOWED)
    ).toBe(true);
  });

  it('lets same-site, same-origin and user-initiated writes through', () => {
    for (const site of ['same-site', 'same-origin', 'none']) {
      expect(isCrossSiteWrite(req('POST', { ...cookie, 'Sec-Fetch-Site': site }), ALLOWED)).toBe(
        false
      );
    }
  });

  it('ignores reads and requests without a session cookie', () => {
    expect(
      isCrossSiteWrite(req('GET', { ...cookie, 'Sec-Fetch-Site': 'cross-site' }), ALLOWED)
    ).toBe(false);
    expect(isCrossSiteWrite(req('POST', { 'Sec-Fetch-Site': 'cross-site' }), ALLOWED)).toBe(false);
  });

  it("lets the save extension's writes through whatever their fetch site", () => {
    for (const origin of ['chrome-extension://abc', 'moz-extension://abc']) {
      expect(
        isCrossSiteWrite(
          req('POST', { ...cookie, Origin: origin, 'Sec-Fetch-Site': 'cross-site' }),
          ALLOWED
        )
      ).toBe(false);
    }
  });

  it('falls back to Origin when the browser sends no fetch metadata', () => {
    expect(
      isCrossSiteWrite(req('POST', { ...cookie, Origin: 'https://evil.example' }), ALLOWED)
    ).toBe(true);
    expect(
      isCrossSiteWrite(req('POST', { ...cookie, Origin: 'https://staging.skyreader.app' }), ALLOWED)
    ).toBe(false);
    expect(isCrossSiteWrite(req('POST', cookie), ALLOWED)).toBe(false);
    expect(isCrossSiteWrite(req('POST', { ...cookie, Origin: 'null' }), ALLOWED)).toBe(true);
  });
});

describe('the API refuses cross-site writes', () => {
  it('answers 403 before touching the session', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://api.skyreader.app/api/saved/delete', {
        method: 'POST',
        headers: { Cookie: 'session_id=abc', 'Sec-Fetch-Site': 'cross-site' },
        body: JSON.stringify({ ids: [] }),
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(403);
  });
});
