/**
 * OpenAlex (https://openalex.org), the open index of scholarly works. Used for
 * a paper's citations: weekly checks on watched saves (save-watches.ts) and the
 * Cited by tab under a paper (paper-citations.ts).
 *
 * A single lookup (`/works/doi:<doi>`) is free; a list (`/works?filter=…`)
 * counts against the key's daily budget, so callers cache what lists return.
 * The key is the `OPENALEX_API_KEY` secret; without it the much smaller keyless
 * allowance applies.
 */

import type { Env } from '../types';

const OPENALEX = 'https://api.openalex.org';

export interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number;
  authorships?: { author?: { display_name?: string | null } | null }[] | null;
  primary_location?: { source?: { display_name?: string | null } | null } | null;
}

/** An OpenAlex URL with the key (when the environment has one). */
export function openAlexUrl(env: Env, path: string, params: Record<string, string>): string {
  const url = new URL(path, OPENALEX);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (env.OPENALEX_API_KEY) url.searchParams.set('api_key', env.OPENALEX_API_KEY);
  return url.toString();
}

/** GET an OpenAlex path: the body, null on 404, throws on anything else. */
export async function openAlex<T>(
  env: Env,
  path: string,
  params: Record<string, string>
): Promise<T | null> {
  const response = await fetch(openAlexUrl(env, path, params), {
    headers: { Accept: 'application/json', 'User-Agent': 'Skyreader (https://skyreader.app)' },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`OpenAlex ${response.status}`);
  return (await response.json()) as T;
}

/** The short id (`W123…`) of an OpenAlex work URL. */
export function openAlexShortId(id: string | undefined | null): string | null {
  return id?.split('/').pop() || null;
}
