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
 * rkey is ignored — by the cache's (user_did, source_type, feed_url) unique index
 * for atproto sources, and by an explicit check for everything else, because
 * legacy RSS rows carry a NULL source_type and SQLite treats NULLs in a unique
 * index as distinct, so the index never constrained them.
 *
 * UPDATE first, INSERT only when the row is genuinely new. A blanket
 * `INSERT OR REPLACE` would silently reset every column the PDS record doesn't
 * carry: `site_url` (for a linkblog connected to an existing publication, the only
 * durable "this is a linkblog" tell — the rkey is arbitrary),
 * `atmosphere_previous_feed_url` (a pending follow-graph migration that
 * reconcileAtmosphereSubscriptions still has to act on), `active`/`user_parked`
 * (a parked feed would come back reactivated) and `atmosphere_synced`.
 *
 * `pds_dirty` is cleared, not preserved: this statement has just made the row
 * equal to the record on the PDS, whether the commit was our own push landing or
 * an edit made elsewhere, so there is no longer a local change owed upward.
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
           site_url = COALESCE(?, site_url), pds_dirty = 0
       WHERE record_uri = ?`
    )
    .bind(...values, recordUri)
    .run();

  if (updated.meta.changes === 0) {
    // No row under this rkey. Before materializing one, make sure the user isn't
    // already holding this feed under a different rkey — which happens whenever a
    // commit lands on a record D1 tracks under another key, most notably when
    // subscription sync repairs an unpaid edit onto the rkey the PDS actually
    // uses. For an atproto source the unique index below swallows that; for
    // everything else nothing does, so ask.
    //
    // Keyed exactly as subscriptionKey() in subscription-sync.ts, so the mirror
    // and the sync agree on what "the same subscription" means. An empty feedUrl
    // is not a usable key, so it falls through and inserts as before.
    const isAtProto = !!record.sourceType?.startsWith('atproto.') && !!record.subjectDid;
    if (!isAtProto && record.feedUrl) {
      const heldElsewhere = await db
        .prepare(
          `SELECT 1 FROM subscriptions_cache
           WHERE user_did = ? AND feed_url = ?
             AND (source_type IS NULL OR source_type NOT LIKE 'atproto.%')
           LIMIT 1`
        )
        .bind(did, record.feedUrl)
        .first<{ 1: number }>();
      // Ignoring, not adopting: the row already here carries local state this
      // record doesn't (active/user_parked, site_url), and a second row for one
      // feed is the duplicate every other path goes out of its way to avoid.
      if (heldElsewhere) return;
    }

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
