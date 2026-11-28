import type { Env } from '../types';
import { citationDoi, getPaperCitations } from '../services/paper-citations';
import { checkRateLimit } from '../services/rate-limit';
import { log, serializeError } from '../utils/logger';

/**
 * The works citing a paper (services/paper-citations.ts), for the Cited by tab
 * in the discussion under it.
 *
 *   GET /api/papers/citations?doi=<doi> → PaperCitations
 *
 * 400 when `doi` isn't a DOI, 429 past a reader's day (300 papers), 502 when
 * OpenAlex fails and nothing is cached.
 * Signed-in only, so the OpenAlex budget is spent on readers.
 */
export async function handlePaperCitations(
  request: Request,
  env: Env,
  userDid: string
): Promise<Response> {
  if (request.method !== 'GET')
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const doi = citationDoi(new URL(request.url).searchParams.get('doi'));
  if (!doi) return Response.json({ error: 'Expected ?doi=<DOI>' }, { status: 400 });
  const day = await checkRateLimit(env, userDid, '/api/papers/citations:day');
  if (!day.allowed) {
    return Response.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': String(day.retryAfter ?? 3600) } }
    );
  }
  try {
    const citations = await getPaperCitations(env, doi);
    return Response.json(citations, {
      // Private: the cache is per paper, the response per reader.
      headers: { 'Cache-Control': 'private, max-age=3600' },
    });
  } catch (error) {
    log.warn('paper_citations_failed', { ...serializeError(error) });
    return Response.json({ error: 'Citations unavailable' }, { status: 502 });
  }
}
