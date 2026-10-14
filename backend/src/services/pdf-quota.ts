import type { Env } from '../types';
import { getUserTierLimits } from './user-tier';

// A reader's daily allowance of PDF parses. Parsing runs on the pdf-extractor
// Worker and is the one extraction we pay for per CPU-second, so it gets a
// sanity cap that every path into /extract shares: a URL save, an XRPC save,
// backing-sync fill-in, a reading room. Generous for a person, a wall for a loop.
//
// Only a parse counts: the proxy reports one with X-Pdf-Parsed, and a PDF served
// from its cache (or its failure cache) costs nothing. Checking and charging are
// two statements, so a burst of concurrent saves can overshoot by a few; that's
// fine for a cap whose job is bounding cost.
//
// Counted in rate_limits under its own endpoint key, one row per reader per UTC
// day. cleanupRateLimits sweeps it by this window, like any long rate limit.
export const PDF_PARSES_PER_DAY = 100;
export const PDF_QUOTA_ENDPOINT = 'pdf-parse:day';
export const PDF_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

export const pdfQuotaDay = (now: number) =>
  Math.floor(now / PDF_QUOTA_WINDOW_MS) * PDF_QUOTA_WINDOW_MS;

/** Whether the reader may have another PDF parsed today. Fails open, like the rate limiter. */
export async function hasPdfAllowance(env: Env, did: string, now = Date.now()): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      'SELECT count FROM rate_limits WHERE did = ? AND endpoint = ? AND window_start = ?'
    )
      .bind(did, PDF_QUOTA_ENDPOINT, pdfQuotaDay(now))
      .first<{ count: number }>();
    return (row?.count ?? 0) < PDF_PARSES_PER_DAY;
  } catch (error) {
    console.error('[PdfQuota] read failed:', error);
    return true;
  }
}

/** Charge one parse to the reader's day. */
export async function chargePdfParse(env: Env, did: string, now = Date.now()): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO rate_limits (did, endpoint, window_start, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(did, endpoint, window_start) DO UPDATE SET count = count + 1`
    )
      .bind(did, PDF_QUOTA_ENDPOINT, pdfQuotaDay(now))
      .run();
  } catch (error) {
    console.error('[PdfQuota] charge failed:', error);
  }
}

/**
 * Whether a parse may run for this reader: PDFs are a Supporter feature
 * (TierLimits.pdfSaves), and a Supporter still has the daily cap above.
 * Like the allowance, the plan lookup fails open: a D1 hiccup shouldn't turn
 * a Supporter's save into an upsell.
 */
export type PdfAccess = 'ok' | 'not_supporter' | 'quota';

export const PDF_SUPPORTER_MESSAGE = 'Reading PDFs in Skyreader is a Supporter feature.';
export const PDF_QUOTA_MESSAGE = "You've saved a lot of PDFs today. Try again tomorrow.";

export async function pdfAccess(env: Env, did: string, now = Date.now()): Promise<PdfAccess> {
  let entitled = true;
  try {
    entitled = (await getUserTierLimits(env, did)).pdfSaves;
  } catch (error) {
    console.error('[PdfQuota] plan lookup failed:', error);
  }
  if (!entitled) return 'not_supporter';
  return (await hasPdfAllowance(env, did, now)) ? 'ok' : 'quota';
}
