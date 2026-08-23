/**
 * Dev-only read-back for the atproto Spaces saves spike.
 *
 * `GET /api/dev/spaces/saved-diff` lists the caller's `app.skyreader.feed.saved`
 * records out of their personal space and diffs them against D1. It is the
 * spike's truth meter: best-effort mirroring guarantees drift, and this is what
 * makes the drift visible rather than theoretical.
 *
 * The route is mounted only when `SPACES_SAVES_ENABLED === 'true'`, a var that
 * exists in `.dev.vars` and nowhere in `wrangler.toml` — so in production the
 * path doesn't resolve at all.
 */

import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { diffSavedRecords } from '../services/spaces/record';
import { SAVED_COLLECTION } from '../services/spaces/refs';
import {
  ensureSavedSpace,
  readSavedRowsForSpace,
  spacesClientForSession,
  spacesSavesEnabled,
} from '../services/spaces/mirror';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleSpacesSavedDiff(request: Request, env: Env): Promise<Response> {
  if (!spacesSavesEnabled(env)) {
    return json({ error: 'Not found' }, 404);
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const space = await ensureSavedSpace(session);
  if (!space) {
    // The honest answer for every production PDS today, and the one a developer
    // pointed at bsky.social should see rather than an empty diff that looks fine.
    return json(
      {
        error: 'spaces_unavailable',
        message: "This session's PDS does not host a Skyreader saved-space.",
      },
      503
    );
  }

  const rows = await readSavedRowsForSpace(env, session.did);

  let listing;
  try {
    listing = await spacesClientForSession(session).listAllRecords({
      space,
      repo: session.did,
      collection: SAVED_COLLECTION,
    });
  } catch (error) {
    return json(
      {
        error: 'space_read_failed',
        message: error instanceof Error ? error.message : String(error),
        space,
      },
      502
    );
  }

  const diff = diffSavedRecords(
    rows,
    listing.records.map((r) => ({ rkey: r.rkey, value: r.value ?? {} }))
  );

  return json({
    space,
    collection: SAVED_COLLECTION,
    counts: { d1: rows.length, space: listing.records.length },
    truncated: listing.truncated,
    ...diff,
    inSync:
      !listing.truncated &&
      diff.onlyInD1.length === 0 &&
      diff.onlyInSpace.length === 0 &&
      diff.mismatched.length === 0,
  });
}
