import type { Env } from '../types';
import type { ExtractedArticle } from './feed-proxy-client';
import { escapeHtml, htmlToText } from '../utils/html-text';
import { captureSnapshot } from './archive/snapshots';
import { exactDoi } from './export/identifiers';

// Whether an extracted body has anything to read: text, or media standing in for
// it. A page that builds its article with scripts extracts as an empty shell.
function hasReadableContent(html: string | null | undefined): html is string {
  if (!html) return false;
  if (/<(img|picture|video|audio|iframe|svg|math|canvas|object|embed)\b/i.test(html)) return true;
  return htmlToText(html).trim().length > 0;
}

/**
 * The body stored when an extraction found nothing to read, so a save never opens
 * to a blank page. Carries the same marker as the frontend's failedSaveBody
 * (frontend/src/lib/utils/saveAnywhere.ts): the reader counts no words for it,
 * and a later save that does get the text may replace it.
 */
export function emptyExtractionNote(url: string | undefined): string {
  let host: string | null = null;
  try {
    host = url ? new URL(url).hostname.replace(/^www\./, '') : null;
  } catch {
    // Leave the link out.
  }
  const lines = [
    `<p data-skyreader-note="fetch-failed">Skyreader couldn't find the article text on this page.</p>`,
  ];
  if (url && host) {
    lines.push(`<p><a href="${escapeHtml(url)}">Read it on ${escapeHtml(host)}</a></p>`);
  }
  lines.push(
    '<p>The browser extension can still save the full text. Open the article, then use ' +
      '<strong>Save this page</strong>; it replaces this note.</p>'
  );
  return lines.join('\n');
}

/**
 * Write an extracted article body + metadata onto a saved_articles row.
 *
 * Guarded on `content IS NULL` so it never clobbers a body another path already filled;
 * a non-null `content` marks the row as extracted so later backfill passes skip it. An
 * extraction with nothing to read stores emptyExtractionNote (linking `opts.url`) rather
 * than an empty body. Metadata is COALESCE-filled, preserving
 * anything the row already captured (e.g. a caller-supplied or foreign-record title).
 *
 * The row is selected either by primary `id` or by `(user_did, rkey)`. Pass
 * `setArticleType: true` to hard-set `content_type = 'article'` (backed enrichment, where
 * the stub had no real type); omit it to leave the row's existing type intact — a URL
 * save stays 'webpage'. An extraction that came from a PDF or EPUB sets `content_type`
 * to 'pdf'/'epub' either way: the body is the file's text, whatever the row was typed before.
 *
 * Stamps `updated_at` so a client that already cached the empty row picks up the
 * body through GET /api/saved/updates, and keeps the body it wrote as the save's
 * snapshot.
 */
export async function fillExtractedContent(
  env: Env,
  article: ExtractedArticle,
  where: { id: number } | { userDid: string; rkey: string },
  opts: { url?: string; setArticleType?: boolean } = {}
): Promise<void> {
  const hasBody = hasReadableContent(article.content);
  const contentType =
    article.contentType === 'pdf' || article.contentType === 'epub'
      ? article.contentType
      : opts.setArticleType
        ? 'article'
        : null;
  const contentTypeClause = contentType ? `,\n         content_type = '${contentType}'` : '';
  const whereClause = 'id' in where ? 'id = ?' : 'user_did = ? AND rkey = ?';
  const whereBinds = 'id' in where ? [where.id] : [where.userDid, where.rkey];

  const row = await env.DB.prepare(
    `UPDATE saved_articles SET
         content = ?,
         word_count = COALESCE(word_count, ?),
         title = COALESCE(title, ?),
         author = COALESCE(author, ?),
         description = COALESCE(description, ?),
         image = COALESCE(image, ?),
         domain = COALESCE(domain, ?),
         published_at = COALESCE(published_at, ?),
         doi = COALESCE(doi, ?),
         updated_at = ?${contentTypeClause}
       WHERE ${whereClause} AND content IS NULL
       RETURNING user_did, rkey, url`
  )
    .bind(
      // Non-null either way: marks the row as extracted so backfill passes skip it.
      hasBody ? article.content : emptyExtractionNote(opts.url),
      hasBody ? article.wordCount || null : null,
      article.title ?? null,
      article.author ?? null,
      article.description ?? null,
      article.image ?? null,
      article.domain ?? null,
      article.published ? new Date(article.published).getTime() : null,
      exactDoi(article.doi) ?? null,
      Date.now(),
      ...whereBinds
    )
    .first<{ user_did: string; rkey: string; url: string }>();

  // A body this fill wrote is the save's capture; a note is not.
  if (hasBody && row) {
    await captureSnapshot(env, {
      did: row.user_did,
      saveRkey: row.rkey,
      url: row.url,
      body: article.content,
      method: 'server',
    });
  }
}
