export interface FirehoseSubscriptionRecord {
  feedUrl?: string;
  title?: string;
  createdAt?: string;
  sourceType?: string;
  subjectDid?: string;
  customTitle?: string;
  customIconUrl?: string;
  category?: string;
  siteUrl?: string;
}

/**
 * Mirror PDS-owned subscription fields without replacing Skyreader's local state.
 * A genuinely new record is active by default; a duplicate feed under another
 * rkey is ignored by the cache's (user_did, source_type, feed_url) unique index.
 *
 * UPDATE first, INSERT only when the row is genuinely new. A blanket
 * `INSERT OR REPLACE` would silently reset every column the PDS record doesn't
 * carry: `site_url` (for a linkblog connected to an existing publication, the only
 * durable "this is a linkblog" tell — the rkey is arbitrary),
 * `atmosphere_previous_feed_url` (a pending follow-graph migration that
 * reconcileAtmosphereSubscriptions still has to act on), `active`/`user_parked`
 * (a parked feed would come back reactivated) and `atmosphere_synced`.
 */
export async function upsertSubscriptionFromFirehose(
  db: D1Database,
  did: string,
  rkey: string,
  record: FirehoseSubscriptionRecord
): Promise<void> {
  const recordUri = `at://${did}/app.skyreader.feed.subscription/${rkey}`;
  const createdAt = record.createdAt
    ? Math.floor(new Date(record.createdAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000);
  // Absent means "the record doesn't carry one", not "clear it" — a follower's
  // site_url is back-filled server-side by the linkblog follower migration and
  // must survive a mirror of a record written before that column existed.
  const siteUrl = record.siteUrl || null;
  const values = [
    record.feedUrl || '',
    record.title || null,
    createdAt,
    record.sourceType || null,
    record.subjectDid || null,
    record.customTitle || null,
    record.customIconUrl || null,
    record.category || null,
    siteUrl,
  ] as const;

  const updated = await db
    .prepare(
      `UPDATE subscriptions_cache
       SET feed_url = ?, title = ?, created_at = ?, source_type = ?, subject_did = ?,
           custom_title = ?, custom_icon_url = ?, category = ?,
           site_url = COALESCE(?, site_url)
       WHERE record_uri = ?`
    )
    .bind(...values, recordUri)
    .run();

  if (updated.meta.changes === 0) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO subscriptions_cache
         (user_did, record_uri, feed_url, title, created_at, source_type, subject_did,
          custom_title, custom_icon_url, category, site_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(did, recordUri, ...values)
      .run();
  }
}
