// Generate a TID (Timestamp Identifier) for AT Protocol record keys.
//
// This is the real thing, not a lookalike: 13 characters of base32-sortable
// encoding a 64-bit integer whose top bit is 0, then 53 bits of microseconds
// since the UNIX epoch, then a 10-bit random clock identifier. Lexicographic
// order therefore equals creation order, and the string decodes back to a
// timestamp.
//
// It has to be exact because lexicons declare `"key": "tid"` and consumers act
// on that — Leaflet's `site.standard.document` is one, and the Semble/Margin
// collections the backing engines write into are others. A rkey that merely
// looks TID-shaped (the old base36-millis + random suffix) is 18 characters,
// decodes to nothing, and sorts by an alphabet that isn't the one readers use.
const S32 = '234567abcdefghijklmnopqrstuvwxyz';

// The clock id disambiguates records created in the same microsecond by
// different clients; per spec it's chosen once at startup and kept.
const CLOCK_ID = BigInt(Math.floor(Math.random() * 1024));

// Date.now() only has millisecond resolution, so several calls can land in the
// same microsecond value. Bumping past the last one keeps rkeys unique and
// monotonic within a session without inventing false precision.
let lastMicros = 0n;

export function generateTid(): string {
  let micros = BigInt(Date.now()) * 1000n;
  if (micros <= lastMicros) micros = lastMicros + 1n;
  lastMicros = micros;

  const value = (micros << 10n) | CLOCK_ID;
  let tid = '';
  for (let shift = 60n; shift >= 0n; shift -= 5n) {
    tid += S32[Number((value >> shift) & 31n)];
  }
  return tid;
}
