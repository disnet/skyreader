import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedProxyClient } from '../src/services/feed-proxy-client';
import {
  PDF_PARSES_PER_DAY,
  PDF_QUOTA_ENDPOINT,
  chargePdfParse,
  hasPdfAllowance,
  pdfQuotaDay,
} from '../src/services/pdf-quota';
import { cleanupRateLimits } from '../src/services/rate-limit';
import type { Env } from '../src/types';

const DID = 'did:plc:pdfreader';
const PARSED = { title: 'A Paper', content: '<p>Text.</p>', contentType: 'pdf' };

async function spent(did = DID): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT count FROM rate_limits WHERE did = ? AND endpoint = ? AND window_start = ?'
  )
    .bind(did, PDF_QUOTA_ENDPOINT, pdfQuotaDay(Date.now()))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function setSpent(count: number, windowStart = pdfQuotaDay(Date.now())) {
  await env.DB.prepare(
    'INSERT INTO rate_limits (did, endpoint, window_start, count) VALUES (?, ?, ?, ?)'
  )
    .bind(DID, PDF_QUOTA_ENDPOINT, windowStart, count)
    .run();
}

const client = () =>
  new FeedProxyClient({
    ...(env as unknown as Env),
    FEED_PROXY_URL: 'https://proxy.example',
    FEED_PROXY_SECRET: 'test-secret',
  });

describe('PDF allowance', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM rate_limits').run();
  });

  it('allows parses until the day is spent', async () => {
    expect(await hasPdfAllowance(env as unknown as Env, DID)).toBe(true);
    await setSpent(PDF_PARSES_PER_DAY - 1);
    expect(await hasPdfAllowance(env as unknown as Env, DID)).toBe(true);
    await chargePdfParse(env as unknown as Env, DID);
    expect(await spent()).toBe(PDF_PARSES_PER_DAY);
    expect(await hasPdfAllowance(env as unknown as Env, DID)).toBe(false);
  });

  it('starts each UTC day fresh, and survives the per-minute sweep', async () => {
    // Midday, so the sweep's grace minute after midnight can't blur the boundary.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(pdfQuotaDay(Date.now()) + 12 * 60 * 60 * 1000);
      await setSpent(PDF_PARSES_PER_DAY, pdfQuotaDay(Date.now()) - 24 * 60 * 60 * 1000);
      await chargePdfParse(env as unknown as Env, DID);

      await cleanupRateLimits(env as unknown as Env);

      // Yesterday's row is gone; today's is kept, though older than two minutes.
      const rows = await env.DB.prepare('SELECT window_start, count FROM rate_limits WHERE did = ?')
        .bind(DID)
        .all<{ window_start: number; count: number }>();
      expect(rows.results).toEqual([{ window_start: pdfQuotaDay(Date.now()), count: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FeedProxyClient.extract() and the PDF allowance', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await env.DB.prepare('DELETE FROM rate_limits').run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function proxyAnswers(body: unknown, headers: Record<string, string> = {}) {
    const mock = vi.fn().mockResolvedValue(Response.json(body, { headers }));
    globalThis.fetch = mock;
    return mock;
  }

  const sentBody = (mock: ReturnType<typeof vi.fn>) =>
    JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string);

  it('charges the reader for a parse the proxy reports', async () => {
    const mock = proxyAnswers(PARSED, { 'X-Pdf-Parsed': '1' });
    await client().extract('https://example.com/a.pdf', { userDid: DID });
    expect(sentBody(mock)).toEqual({ url: 'https://example.com/a.pdf' });
    expect(await spent()).toBe(1);
  });

  it('charges a parse that failed too', async () => {
    proxyAnswers(
      { error: 'This PDF took too long to read', blocked: false, pdf: true },
      { 'X-Pdf-Parsed': '1' }
    );
    await expect(client().extract('https://example.com/a.pdf', { userDid: DID })).rejects.toThrow(
      'This PDF took too long to read'
    );
    expect(await spent()).toBe(1);
  });

  it('charges nothing for a cached PDF or a web page', async () => {
    proxyAnswers(PARSED, { 'X-Cache': 'HIT' });
    await client().extract('https://example.com/a.pdf', { userDid: DID });
    expect(await spent()).toBe(0);
  });

  it('tells the proxy not to parse PDFs once the day is spent', async () => {
    await setSpent(PDF_PARSES_PER_DAY);
    const mock = proxyAnswers(PARSED);
    await client().extract('https://example.com/a', { userDid: DID });
    expect(sentBody(mock)).toEqual({ url: 'https://example.com/a', allowPdf: false });
  });

  it('leaves an extraction for no particular reader unmetered', async () => {
    const mock = proxyAnswers(PARSED, { 'X-Pdf-Parsed': '1' });
    await client().extract('https://example.com/a.pdf');
    expect(sentBody(mock)).toEqual({ url: 'https://example.com/a.pdf' });
    expect(await spent()).toBe(0);
  });
});
