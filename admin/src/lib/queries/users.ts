import type { UserRow, SubscriptionRow, PaginatedResult } from '$lib/types';

export async function listUsers(
  db: D1Database,
  opts: {
    search?: string;
    sort?: string;
    order?: 'asc' | 'desc';
    page?: number;
    perPage?: number;
  } = {}
): Promise<PaginatedResult<UserRow>> {
  const { search, sort = 'registered_at', order = 'desc', page = 1, perPage = 50 } = opts;
  const offset = (page - 1) * perPage;

  const allowedSorts = ['handle', 'registered_at', 'last_active_at', 'created_at', 'tier'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'registered_at';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';

  let where = 'WHERE u.registered_at IS NOT NULL';
  const params: unknown[] = [];

  if (search) {
    where += ' AND (u.handle LIKE ? OR u.display_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const countResult = await db
    .prepare(`SELECT COUNT(*) as count FROM users u ${where}`)
    .bind(...params)
    .first<{ count: number }>();

  const rows = await db
    .prepare(
      `SELECT u.did, u.handle, u.display_name, u.avatar_url, u.pds_url,
				u.last_active_at, u.registered_at, u.created_at, u.tier,
				(SELECT COUNT(*) FROM subscriptions_cache sc WHERE sc.user_did = u.did) as subscription_count
			FROM users u
			${where}
			ORDER BY ${sortCol} ${sortDir}
			LIMIT ? OFFSET ?`
    )
    .bind(...params, perPage, offset)
    .all<UserRow>();

  return {
    rows: rows.results,
    total: countResult?.count ?? 0,
    page,
    perPage,
  };
}

export async function getUser(db: D1Database, did: string): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT did, handle, display_name, avatar_url, pds_url,
				last_active_at, registered_at, created_at, tier, tier_source, granted_tier
			FROM users WHERE did = ?`
    )
    .bind(did)
    .first<UserRow>();
}

const VALID_TIERS = ['free', 'supporter'];

export async function updateUserTier(db: D1Database, did: string, tier: string): Promise<void> {
  if (!VALID_TIERS.includes(tier)) {
    throw new Error(`Invalid tier: ${tier}`);
  }
  // tier_source 'admin' shields the row from Polar webhook downgrades (a real
  // payment still upgrades it unconditionally) — see backend migration 0073.
  //
  // granted_tier records the same grant as an entitlement the user keeps for
  // free (migration 0075): if they later start paying through Polar and then
  // cancel, the webhook downgrade lands them back here instead of on free.
  // Setting someone to 'free' is a revocation, so it clears the grant.
  const grantedTier = tier === 'free' ? null : tier;
  await db
    .prepare("UPDATE users SET tier = ?, tier_source = 'admin', granted_tier = ? WHERE did = ?")
    .bind(tier, grantedTier, did)
    .run();
}

export async function getUserSubscriptions(
  db: D1Database,
  did: string
): Promise<SubscriptionRow[]> {
  const result = await db
    .prepare(
      `SELECT feed_url, title, source, created_at
			FROM subscriptions_cache
			WHERE user_did = ?
			ORDER BY created_at DESC`
    )
    .bind(did)
    .all<SubscriptionRow>();
  return result.results;
}
