// Generate a TID (Timestamp Identifier) for AT Protocol record keys.
//
// rkeys are validated against /^[a-z0-9]{13,}$/ (see ./validation.ts), so the
// result must always be lowercase alphanumeric and at least 13 characters. A
// base36 millisecond timestamp (8 chars for any modern date) gives rough
// sortability; a fixed-length random suffix guarantees the minimum length and
// reduces the chance of collisions for records created within the same
// millisecond.
const RANDOM_CHARS = 10;

export function generateTid(): string {
  const timestamp = Date.now().toString(36);
  let random = '';
  for (let i = 0; i < RANDOM_CHARS; i++) {
    // Each iteration appends exactly one base36 char (0-9, a-z), so the suffix
    // length is deterministic — unlike Math.random().toString(36) slicing,
    // which can yield fewer chars when the expansion terminates early.
    random += Math.floor(Math.random() * 36).toString(36);
  }
  return timestamp + random;
}
