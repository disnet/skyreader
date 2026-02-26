/**
 * Validation utilities for AT Protocol data types
 */

/**
 * TID (Timestamp Identifier) format regex
 * TIDs are base32-sortable identifiers used as record keys in AT Protocol
 * Format: lowercase alphanumeric, at least 13 characters
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
