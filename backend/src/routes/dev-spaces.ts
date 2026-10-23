/**
 * Dev-only read-back for the atproto Spaces saves spike.
 *
 * `GET /api/dev/spaces/saved-diff` lists the caller's `app.skyreader.feed.saved`
 * records out of their personal space and diffs them against D1. It is the
 * spike's truth meter: best-effort mirroring guarantees drift, and this is what
 * makes the drift visible rather than theoretical.
 *
 * `POST /api/dev/spaces/app-access` and `GET /api/dev/spaces/credential-read`
 * are spike 1 of the follow-ups ("a true second client"): the first switches the
 * space between `#open` and an `#allowList` pinned to Skyreader's client_id, the
 * second reads the saves back the way another app would have to — a space
 * credential plus record MACs — so the allowList's effect on Skyreader itself is
 * visible next to `experiments/spaces-saves/second-client.mjs`, which plays the
 * other app.
 *
 * The routes are mounted only when `SPACES_SAVES_ENABLED === 'true'`, a var that
 * exists in `.dev.vars` and nowhere in `wrangler.toml` — so in production the
 * path doesn't resolve at all.
 */

import type { Env, Session } from '../types';
import { diffSavedRecords } from '../services/spaces/record';
import { SAVED_COLLECTION } from '../services/spaces/refs';
import {
  PERSONAL_SPACE_APP_ACCESS,
  SpacesClient,
  type SpaceAppAccess,
} from '../services/spaces/client';
import { mintSpaceCredential } from '../services/spaces/credential';
import { credentialCall } from '../services/spaces/transport';
import { createClientAttestation } from '../services/client-auth';
import { resolveClientIdentity } from '../services/oauth';
import { resolveAtprotoKemKey } from '../utils/did-resolver';
import {
  readSavedRowsForSpace,
  resolveSavedSpace,
  spacesClientForSession,
  spacesSavesEnabled,
} from '../services/spaces/mirror';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleSpacesSavedDiff(env: Env, session: Session): Promise<Response> {
  if (!spacesSavesEnabled(env)) {
    return json({ error: 'Not found' }, 404);
  }

  // A GET only reads: probe for the space, never create it.
  const client = spacesClientForSession(session);
  const { space, status } = await resolveSavedSpace(session, client, { create: false });
  if (!space) {
    // The honest answer for every production PDS today, and the one a developer
    // pointed at bsky.social should see rather than an empty diff that looks fine.
    // A failed probe says nothing about the space, so it isn't reported as absent.
    const message: Record<Exclude<typeof status, 'available'>, string> = {
      missing: 'No Skyreader saved-space exists yet — save an article first.',
      unsupported: "This session's PDS does not support atproto Spaces.",
      denied: "This session isn't authorized for the saved-space (missing space scope?).",
      rejected: 'The PDS rejected the space probe (a Spaces alpha wire-format change?).',
      failed: 'The space probe failed (network or PDS error); try again.',
    };
    return json(
      {
        error: status === 'failed' ? 'space_probe_failed' : 'spaces_unavailable',
        status,
        message: message[status as Exclude<typeof status, 'available'>],
      },
      status === 'failed' ? 502 : 503
    );
  }

  const rows = await readSavedRowsForSpace(env, session.did);

  let listing;
  try {
    listing = await client.listAllRecords({
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

function errorReport(step: string, error: unknown): Record<string, unknown> {
  const e = error as { code?: unknown; status?: unknown; message?: unknown };
  return {
    ok: false,
    step,
    code: typeof e?.code === 'string' ? e.code : undefined,
    status: typeof e?.status === 'number' ? e.status : undefined,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * `POST /api/dev/spaces/app-access` with `{"mode": "open" | "allowList"}`.
 * `allowList` pins the space to this deployment's OAuth client_id. App access is
 * checked only when a credential is issued, so this changes who can *sync* the
 * space, not what an app the reader granted a `space:` scope can read through
 * their session.
 */
export async function handleSpacesAppAccess(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (!spacesSavesEnabled(env)) return json({ error: 'Not found' }, 404);

  const body = (await request.json().catch(() => ({}))) as { mode?: unknown };
  if (body.mode !== 'open' && body.mode !== 'allowList') {
    return json({ error: 'mode must be "open" or "allowList"' }, 400);
  }

  const identity = resolveClientIdentity(env, new URL(request.url));
  const appAccess: SpaceAppAccess =
    body.mode === 'open'
      ? PERSONAL_SPACE_APP_ACCESS
      : { $type: 'com.atproto.simplespace.defs#allowList', allowed: [identity.clientId] };

  const client = spacesClientForSession(session);
  const { space, status } = await resolveSavedSpace(session, client, { create: false });
  if (!space) return json({ error: 'spaces_unavailable', status }, 503);

  try {
    await client.updateSpace({ space, appAccess });
    const view = await client.getSpace(space);
    return json({
      space,
      appAccess: view.appAccess,
      clientId: identity.clientId,
      // A public (localhost) client can't sign an attestation, so pinning the
      // space to it locks every credential out, Skyreader's included.
      publicClient: identity.isPublicClient,
    });
  } catch (error) {
    return json(errorReport('updateSpace', error), 502);
  }
}

/**
 * `GET /api/dev/spaces/credential-read`: Skyreader reading its own saves back
 * the way any other app has to — delegation token, a credential (attested as
 * Skyreader when this is a confidential client), the reader's `#atproto_kem` key
 * out of their DID doc, then listRecords and a MAC-verified getRecord.
 */
export async function handleSpacesCredentialRead(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (!spacesSavesEnabled(env)) return json({ error: 'Not found' }, 404);

  const client = spacesClientForSession(session);
  const { space, status } = await resolveSavedSpace(session, client, { create: false });
  if (!space) return json({ error: 'spaces_unavailable', status }, 503);

  const identity = resolveClientIdentity(env, new URL(request.url));
  const attested = !identity.isPublicClient;
  const report: Record<string, unknown> = { space, clientId: identity.clientId, attested };

  let credential;
  try {
    credential = await mintSpaceCredential({
      space,
      authorityPdsUrl: session.pdsUrl,
      getDelegationToken: async (target) => (await client.getDelegationToken(target)).token,
      getClientAttestation: attested
        ? () => createClientAttestation(env, session.did, identity.clientId)
        : undefined,
    });
  } catch (error) {
    return json({ ...report, ...errorReport('credential', error) });
  }

  const kemKey = await resolveAtprotoKemKey(session.did);
  report.kemKey = kemKey;
  if (!kemKey) {
    return json({ ...report, ok: false, step: 'kemKey', message: 'DID doc has no #atproto_kem' });
  }

  const reader = new SpacesClient(
    credentialCall(session.pdsUrl, credential, session.did, { authorKemKey: kemKey })
  );
  try {
    const listing = await reader.listAllRecords({
      space,
      repo: session.did,
      collection: SAVED_COLLECTION,
    });
    report.listed = listing.records.length;
    report.truncated = listing.truncated;
    const first = listing.records[0];
    if (first) {
      const record = await reader.getRecord({
        space,
        repo: session.did,
        collection: SAVED_COLLECTION,
        rkey: first.rkey,
      });
      report.verifiedRecord = { rkey: first.rkey, url: record.value?.url };
    }
  } catch (error) {
    return json({ ...report, ...errorReport('read', error) });
  }
  return json({ ...report, ok: true });
}
