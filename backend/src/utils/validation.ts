/**
 * Validation utilities for AT Protocol data types
 */

/**
 * Record key format regex.
 *
 * Deliberately looser than the TID syntax utils/tid.ts now generates: rkeys
 * written before that (base36 millis + a random suffix, 18 chars) are already in
 * D1 and on users' PDSes, and every PATCH/DELETE addresses a record by its rkey.
 * Tightening this to strict TID would 400 every mutation of an existing record.
 * This is a sanity gate on untrusted input, not a statement about what we mint.
 */
export const TID_REGEX = /^[a-z0-9]{13,}$/;

/**
 * Validate that a string is a valid AT Protocol TID (record key)
 */
export function isValidRkey(rkey: string): boolean {
  return typeof rkey === 'string' && TID_REGEX.test(rkey);
}

/**
 * Validate and sanitize an rkey, returning null if invalid
 */
export function sanitizeRkey(rkey: string | undefined | null): string | null {
  if (!rkey || typeof rkey !== 'string') {
    return null;
  }
  return isValidRkey(rkey) ? rkey : null;
}

/**
 * Response for invalid rkey
 */
export function invalidRkeyResponse(): Response {
  return new Response(
    JSON.stringify({
      error: 'Invalid rkey format',
      message: 'Record key must be a valid TID (lowercase alphanumeric, at least 13 characters)',
    }),
    {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
