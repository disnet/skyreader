import { resolveHandle } from './oauth';

/**
 * An optional allowlist of the accounts that may sign in, for staging: set the
 * `SIGNIN_ALLOWLIST` secret (`wrangler secret put SIGNIN_ALLOWLIST --env staging`)
 * to a comma- or whitespace-separated list of handles and/or DIDs, and every other
 * account is turned away at the OAuth callback. Unset or empty (production, local
 * dev, tests) means anyone may sign in.
 *
 * Entries are compared by DID. A handle entry is resolved to its DID at check
 * time rather than matched against the handle the callback learned, since that
 * one can come straight from the account's own PDS (describeRepo at sign-up) and
 * a PDS can claim any handle it likes.
 */
export function parseSignInAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
}

export async function isSignInAllowed(env: Env, did: string): Promise<boolean> {
  const entries = parseSignInAllowlist(env.SIGNIN_ALLOWLIST);
  if (entries.length === 0) return true;
  if (entries.includes(did.toLowerCase())) return true;
  for (const entry of entries) {
    if (entry.startsWith('did:')) continue;
    try {
      if ((await resolveHandle(entry)) === did) return true;
    } catch {
      // An entry that doesn't resolve right now admits no one.
    }
  }
  return false;
}
