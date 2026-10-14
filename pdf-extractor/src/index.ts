import { extractPdf, MAX_PDF_BYTES, PdfPasswordError, PdfUnreadableError } from './extract';

// PDF → reader HTML, as a service for the feed proxy's /extract. The proxy
// fetches the PDF (it owns the crawler identity, robots, caching and request
// coalescing) and posts the bytes here; this Worker only parses.
//
// It runs here and not on the proxy because pdf.js is CPU-bound: an 18-page
// paper is ~1s of CPU, which the proxy's shared Fly vCPUs (~0.125 cores once
// burst credit is spent) stretch past its parse timeout, starving crawls while
// they do. A Worker gets its own CPU per request, and its own isolate, so a large
// PDF can't take the API Worker down with it.
//
//   POST /extract   body: the PDF's bytes; Authorization: Bearer <EXTRACT_SECRET>
//     200 PdfExtraction
//     422 { name: 'PdfPasswordError' | 'PdfUnreadableError', message }
//     401 / 413 / 500 { message }
//   GET /health     { status, version }

// The entry module may export only handlers (workerd rejects anything else), so
// constants live in extract.ts.
export interface Env {
  /** Shared with the proxy (its PDF_EXTRACTOR_SECRET). Unset = refuse every parse. */
  EXTRACT_SECRET?: string;
  GIT_COMMIT_SHA?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// Constant-time, so the secret can't be recovered a byte at a time from response timing.
async function secretMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/health' && request.method === 'GET') {
      return json({ status: 'ok', version: env.GIT_COMMIT_SHA ?? 'dev' });
    }
    if (pathname !== '/extract') return json({ message: 'Not found' }, 404);
    if (request.method !== 'POST') return json({ message: 'Method not allowed' }, 405);

    // Fail closed: without a secret this would be an open PDF-parsing service.
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!env.EXTRACT_SECRET || !token || !(await secretMatches(token, env.EXTRACT_SECRET))) {
      return json({ message: 'Unauthorized' }, 401);
    }

    const declared = Number(request.headers.get('Content-Length') ?? 0);
    if (declared > MAX_PDF_BYTES) return json({ message: 'PDF too large' }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_PDF_BYTES) return json({ message: 'PDF too large' }, 413);

    try {
      return json(await extractPdf(bytes, { ownsBytes: true }));
    } catch (err) {
      if (err instanceof PdfPasswordError || err instanceof PdfUnreadableError) {
        return json({ name: err.name, message: err.message }, 422);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[pdf-extractor] parse failed: ${message}`);
      return json({ message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
