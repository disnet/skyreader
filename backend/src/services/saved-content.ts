import type { Env } from '../types';
import type { ExtractedArticle } from './feed-proxy-client';

/**
 * Write an extracted article body + metadata onto a saved_articles row.
 *
 * Guarded on `content IS NULL` so it never clobbers a body another path already filled;
 * a non-null `content` (empty string when extraction yielded nothing) marks the row as
 * extracted so later backfill passes skip it. Metadata is COALESCE-filled, preserving
 * anything the row already captured (e.g. a caller-supplied or foreign-record title).
 *
 * The row is selected either by primary `id` or by `(user_did, rkey)`. Pass
 * `setArticleType: true` to hard-set `content_type = 'article'` (backed enrichment, where
 * the stub had no real type); omit it to leave the row's existing type intact — a URL
 * save stays 'webpage'.
 */
export async function fillExtractedContent(
  env: Env,
  article: ExtractedArticle,
  where: { id: number } | { userDid: string; rkey: string },
  opts: { setArticleType?: boolean } = {}
): Promise<void> {
  const contentTypeClause = opts.setArticleType ? `,\n         content_type = 'article'` : '';
  const whereClause = 'id' in where ? 'id = ?' : 'user_did = ? AND rkey = ?';
  const whereBinds = 'id' in where ? [where.id] : [where.userDid, where.rkey];

  await env.DB.prepare(
    `UPDATE saved_articles SET
         content = ?,
         word_count = COALESCE(word_count, ?),
         title = COALESCE(title, ?),
         author = COALESCE(author, ?),
         description = COALESCE(description, ?),
         image = COALESCE(image, ?),
         domain = COALESCE(domain, ?),
         published_at = COALESCE(published_at, ?)${contentTypeClause}
       WHERE ${whereClause} AND content IS NULL`
  )
    .bind(
      article.content ?? '', // non-null marks the row as extracted so backfill passes skip it
      article.wordCount || null,
      article.title ?? null,
      article.author ?? null,
      article.description ?? null,
      article.image ?? null,
      article.domain ?? null,
      article.published ? new Date(article.published).getTime() : null,
      ...whereBinds
    )
    .run();
}
