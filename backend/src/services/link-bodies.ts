/**
 * The articles behind follows links, read once per URL for saved searches
 * (docs/plans/SAVED_SEARCH_CHANNELS.md, "Every source kind").
 *
 * A share holds only the sharer's words and the link card, so matching a
 * follows link on its body means reading the article. That happens through the
 * feed proxy's `/extract`, once per normalized URL however many readers' follows
 * shared it, and the text is kept in R2 under a hash of that URL for as long as
 * shares are (7 days). The Percolator decides which links are worth reading and
 * keeps the bookkeeping; this is just the read and the store.
 */

import type { Env } from '../types';
import { FeedProxyClient, FeedProxyError } from './feed-proxy-client';
import { htmlToText, stripControlChars } from '../utils/html-text';
import { sha256Hex } from '../utils/sha256';
import { log, serializeError } from '../utils/logger';

const KEY_PREFIX = 'link_bodies/v1/';

export async function linkBodyKey(urlNormalized: string): Promise<string> {
  return `${KEY_PREFIX}${await sha256Hex(new TextEncoder().encode(urlNormalized))}`;
}

/** The stored text of a link's article, or null when none is stored (or R2 failed). */
export async function readLinkBody(env: Env, urlNormalized: string): Promise<string | null> {
  if (!env.ITEM_BODIES) return null;
  try {
    const object = await env.ITEM_BODIES.get(await linkBodyKey(urlNormalized));
    return object ? await object.text() : null;
  } catch (error) {
    log.warn('link_body_read_failed', serializeError(error));
    return null;
  }
}

export type LinkExtractResult =
  | { ok: true; text: string }
  /** `retry`: worth one more try (a timeout, the proxy down), not a refusal. */
  | { ok: false; retry: boolean; error: string };

/**
 * Read the article at `url` and store its text under `urlNormalized`. Web pages
 * only: a PDF or EPUB link is left to its card.
 */
export async function extractLinkBody(
  env: Env,
  url: string,
  urlNormalized: string,
  maxChars: number
): Promise<LinkExtractResult> {
  if (!env.ITEM_BODIES) return { ok: false, retry: false, error: 'no bucket' };
  let text: string;
  try {
    const article = await new FeedProxyClient(env).extract(url, { articleOnly: true });
    text = stripControlChars(htmlToText(article.content ?? '', maxChars));
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    return { ok: false, retry: worthRetrying(error, message), error: message };
  }
  // An empty article is an answer, not a failure: it's stored so it isn't asked for again.
  try {
    await env.ITEM_BODIES.put(await linkBodyKey(urlNormalized), text, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });
  } catch (error) {
    return { ok: false, retry: true, error: String((error as Error)?.message ?? error) };
  }
  return { ok: true, text };
}

/**
 * Only a failure to get an answer is worth another try: the proxy unreachable,
 * an edge error, a timeout. Anything the proxy determined (the site refused,
 * not found, too large, a PDF) would only be said again.
 */
function worthRetrying(error: unknown, message: string): boolean {
  if (!(error instanceof FeedProxyError)) return true;
  if (error.blocked || error.pdf) return false;
  return message.startsWith('Failed to extract article') || message.startsWith('That article took');
}

/** Drop stored articles whose shares have aged out. */
export async function deleteLinkBodies(env: Env, urlsNormalized: string[]): Promise<void> {
  if (!env.ITEM_BODIES || urlsNormalized.length === 0) return;
  const keys = await Promise.all(urlsNormalized.map(linkBodyKey));
  for (let i = 0; i < keys.length; i += 1000) {
    await env.ITEM_BODIES.delete(keys.slice(i, i + 1000));
  }
}
