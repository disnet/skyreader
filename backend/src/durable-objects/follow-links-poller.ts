// One per reader: refreshes their follows links when the minute cron hands them
// off (services/follow-links-background.ts). It holds no state; it exists so
// each refresh runs in its own invocation, with its own D1 and subrequest
// budget, instead of all of them sharing the cron's.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { getBackgroundSession } from '../services/oauth';
import { refreshFollowLinks } from '../services/follow-links-store';
import { FOLLOWS_LINKS_ACCESS_SCOPES } from '../config/scopes';
import { hasRequiredScopes } from '../routes/auth';

export type BackgroundRefreshOutcome =
  'refreshed' | 'failed' | 'gated' | 'locked' | 'no_session' | 'no_scope';

export class FollowLinksPoller extends DurableObject<Env> {
  async refresh(did: string): Promise<BackgroundRefreshOutcome> {
    // No usable session right now (signed out everywhere, no session with the
    // permission, mid-backoff, or a concurrent token refresh): the hand-off
    // stamp spaces out the next try.
    // A session without the timeline permission is passed over, not refreshed.
    const session = await getBackgroundSession(this.env, did, (scopes) =>
      hasRequiredScopes(scopes, FOLLOWS_LINKS_ACCESS_SCOPES)
    );
    if (!session) return 'no_session';
    const result = await refreshFollowLinks(this.env, session);
    if (!result.refreshed) return result.reason;
    return result.error ? 'failed' : 'refreshed';
  }
}
