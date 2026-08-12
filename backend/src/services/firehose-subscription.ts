export interface FirehoseSubscriptionRecord {
  feedUrl?: string;
  title?: string;
  createdAt?: string;
  sourceType?: string;
  subjectDid?: string;
  customTitle?: string;
  customIconUrl?: string;
  category?: string;
}

/**
 * Mirror PDS-owned subscription fields without replacing Skyreader's local state.
 * A genuinely new record is active by default; a duplicate feed under another
 * rkey is ignored by the cache's (user_did, source_type, feed_url) unique index.
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
  const values = [
    record.feedUrl || '',
    record.title || null,
    createdAt,
    record.sourceType || null,
    record.subjectDid || null,
    record.customTitle || null,
    record.customIconUrl || null,
    record.category || null,
  ] as const;

  const updated = await db
    .prepare(
      `UPDATE subscriptions_cache
       SET feed_url = ?, title = ?, created_at = ?, source_type = ?, subject_did = ?,
           custom_title = ?, custom_icon_url = ?, category = ?
       WHERE record_uri = ?`
    )
    .bind(...values, recordUri)
    .run();

  if (updated.meta.changes === 0) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO subscriptions_cache
         (user_did, record_uri, feed_url, title, created_at, source_type, subject_did,
          custom_title, custom_icon_url, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(did, recordUri, ...values)
      .run();
  }
}
