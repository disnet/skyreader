import type { Env } from '../types';
import { resolveHandle } from './oauth';

/**
 * An optional allowlist of the accounts that may sign in, for staging: set the
 * `SIGNIN_ALLOWLIST` secret (`wrangler secret put SIGNIN_ALLOWLIST --env staging`)
 * to a comma- or whitespace-separated list of handles and/or DIDs, and every other
 * account is turned away. Unset or empty (local dev, tests) means anyone may sign
 * in, and production ignores it outright, so a `secret put` that forgot
 * `--env staging` can't lock readers out.
 *
 * Entries are compared by DID. A handle entry is resolved to its DID at check
 * time rather than matched against the handle the callback learned, since that
 * one can come straight from the account's own PDS (describeRepo at sign-up) and
 * a PDS can claim any handle it likes.
 */
export const SIGNIN_RESTRICTED_MESSAGE = 'This Skyreader server is limited to test accounts.';

export function parseSignInAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return (
    raw
      .split(/[\s,]+/)
      .map((entry) => entry.replace(/^@/, '').toLowerCase())
      // A DID or a full handle. A bare name would otherwise resolve as
      // `<name>.bsky.social` and admit whoever holds that.
      .filter((entry) => entry.startsWith('did:') || entry.includes('.'))
  );
}

/** Whether sign-in is limited to an allowlist at all in this environment. */
export function isSignInRestricted(env: Env): boolean {
  return (
    env.SENTRY_ENVIRONMENT !== 'production' && parseSignInAllowlist(env.SIGNIN_ALLOWLIST).length > 0
  );
}

export async function isSignInAllowed(env: Env, did: string): Promise<boolean> {
  if (!isSignInRestricted(env)) return true;
  const entries = parseSignInAllowlist(env.SIGNIN_ALLOWLIST);
  if (entries.includes(did.toLowerCase())) return true;
  const resolved = await Promise.all(
    entries
      .filter((entry) => !entry.startsWith('did:'))
      // An entry that doesn't resolve right now admits no one.
      .map((entry) => resolveHandle(entry).catch(() => null))
  );
  return resolved.some((resolvedDid) => resolvedDid?.toLowerCase() === did.toLowerCase());
}
