import type { Env } from '../types';

interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
}

// Rate limit configurations per endpoint
// Expensive operations that hit external APIs or run complex queries
const EXPENSIVE_LIMIT: RateLimitConfig = { limit: 30, windowMs: 60000 };
// Standard operations for user data
const STANDARD_LIMIT: RateLimitConfig = { limit: 100, windowMs: 60000 };
// Light operations that are cheap to serve
const LIGHT_LIMIT: RateLimitConfig = { limit: 300, windowMs: 60000 };

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // Expensive operations (external API calls, complex queries)
  '/api/social/feed': EXPENSIVE_LIMIT,
  '/api/social/sync-follows': EXPENSIVE_LIMIT,
  '/api/feeds/fetch': EXPENSIVE_LIMIT,
  '/api/feeds/article': EXPENSIVE_LIMIT,

  // Standard operations (user data reads/writes)
  '/api/records/sync': STANDARD_LIMIT,
  '/api/records/bulk-sync': STANDARD_LIMIT,
  '/api/records/list': STANDARD_LIMIT,
  '/api/reading/positions': STANDARD_LIMIT,
  '/api/reading/mark-read': STANDARD_LIMIT,
  '/api/reading/mark-read-bulk': STANDARD_LIMIT,
  '/api/reading/mark-unread': STANDARD_LIMIT,
  '/api/reading/toggle-star': STANDARD_LIMIT,
  '/api/shares/my': STANDARD_LIMIT,
  '/api/social/following': STANDARD_LIMIT,
  '/api/social/popular': STANDARD_LIMIT,

  // Light operations (cached data, simple queries)
  '/api/feeds/cached': LIGHT_LIMIT,
  '/api/feeds/discover': LIGHT_LIMIT,
  '/api/feeds/status': LIGHT_LIMIT,
  '/api/items': LIGHT_LIMIT,
  '/api/items/recent': LIGHT_LIMIT,
  '/api/items/get': LIGHT_LIMIT,
  '/api/items/by-feed': LIGHT_LIMIT,
  '/api/discover': LIGHT_LIMIT,
};

// Default limit for unspecified endpoints
const DEFAULT_LIMIT: RateLimitConfig = STANDARD_LIMIT;

/**
 * Check rate limit for a user and endpoint.
 * Uses fixed-window rate limiting with atomic SQL increments.
 */
export async function checkRateLimit(
  env: Env,
  did: string,
  pathname: string
): Promise<RateLimitResult> {
  const config = RATE_LIMITS[pathname] || DEFAULT_LIMIT;
  const now = Date.now();
  const windowStart = Math.floor(now / config.windowMs) * config.windowMs;

  // Normalize pathname for rate limiting (remove query params)
  const normalizedEndpoint = pathname.split('?')[0];

  try {
    // Atomically increment the counter and return the new count
    const result = await env.DB.prepare(`
      INSERT INTO rate_limits (did, endpoint, window_start, count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(did, endpoint, window_start) DO UPDATE SET
        count = count + 1
      RETURNING count
    `).bind(did, normalizedEndpoint, windowStart).first<{ count: number }>();

    const count = result?.count || 1;
    const remaining = Math.max(0, config.limit - count);

    if (count > config.limit) {
      // Calculate seconds until window resets
      const retryAfter = Math.ceil((windowStart + config.windowMs - now) / 1000);
      return { allowed: false, remaining: 0, retryAfter };
    }

    return { allowed: true, remaining };
  } catch (error) {
    // On database error, allow the request but log the error
    console.error('[RateLimit] Database error:', error);
    return { allowed: true, remaining: config.limit };
  }
}

/**
 * Clean up old rate limit records.
 * Should be called periodically (e.g., every minute via cron).
 */
export async function cleanupRateLimits(env: Env): Promise<number> {
  const twoMinutesAgo = Date.now() - 120000;

  try {
    const result = await env.DB.prepare(
      'DELETE FROM rate_limits WHERE window_start < ?'
    ).bind(twoMinutesAgo).run();

    return result.meta?.changes || 0;
  } catch (error) {
    console.error('[RateLimit] Cleanup error:', error);
    return 0;
  }
}

/**
 * Get rate limit configuration for an endpoint.
 * Useful for adding rate limit headers to responses.
 */
export function getRateLimitConfig(pathname: string): RateLimitConfig {
  return RATE_LIMITS[pathname] || DEFAULT_LIMIT;
}
