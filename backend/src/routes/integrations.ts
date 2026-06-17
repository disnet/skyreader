import type { Env, Session } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { createPDSClient } from '../services/pds-client';
import { SEMBLE_SCOPES, MARGIN_SCOPES } from './auth';

/**
 * Check if the session has the required scopes for a specific integration
 */
function hasIntegrationScopes(session: Session, integration: 'semble' | 'margin'): boolean {
  if (!session.grantedScopes) return false;
  const granted = new Set(session.grantedScopes.split(' '));
  const required = integration === 'semble' ? SEMBLE_SCOPES : MARGIN_SCOPES;
  return required.every((scope) => granted.has(scope));
}

/**
 * GET /api/integrations/status — return scope status for integrations
 */
export async function handleIntegrationStatus(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({
      scopeStatus: {
        semble: hasIntegrationScopes(session, 'semble'),
        margin: hasIntegrationScopes(session, 'margin'),
      },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Check session has required scopes for an integration
 */
function checkIntegrationScopes(
  session: Session,
  integration: 'semble' | 'margin'
): Response | null {
  if (!hasIntegrationScopes(session, integration)) {
    return new Response(
      JSON.stringify({
        error: 'scope_upgrade_required',
        message: `Additional permissions are needed for ${integration}. Please log in again.`,
        integration,
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return null;
}

// Generate a TID-compatible rkey (AT Protocol timestamp ID)
function generateTID(): string {
  // TID format: base32-sortable encoding of microsecond timestamp + clock ID
  // For simplicity, use a random string that matches the pattern
  const now = BigInt(Date.now()) * 1000n; // microseconds
  const clockId = BigInt(Math.floor(Math.random() * 1024));
  const tid = (now << 10n) | clockId;
  // Encode as base32-sortable (charset: 234567abcdefghijklmnopqrstuvwxyz)
  const charset = '234567abcdefghijklmnopqrstuvwxyz';
  let result = '';
  let val = tid;
  for (let i = 0; i < 13; i++) {
    result = charset[Number(val & 31n)] + result;
    val >>= 5n;
  }
  return result;
}

/**
 * POST /api/integrations/semble/cards — create a network.cosmik.card on PDS
 */
export async function handleCreateSembleCard(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const checkResult = checkIntegrationScopes(session, 'semble');
  if (checkResult) return checkResult;

  let body: {
    url: string;
    title?: string;
    description?: string;
    author?: string;
    publishedAt?: string;
    collections?: { uri: string; cid: string }[];
    // Legacy single-collection fields — still accepted from in-flight queued entries
    collectionUri?: string;
    collectionCid?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.url) {
    return new Response(JSON.stringify({ error: 'url is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const collections: { uri: string; cid: string }[] =
    body.collections && body.collections.length > 0
      ? body.collections
      : body.collectionUri && body.collectionCid
        ? [{ uri: body.collectionUri, cid: body.collectionCid }]
        : [];

  const rkey = generateTID();
  const metadata: Record<string, string> = {};
  if (body.title) metadata.title = body.title;
  if (body.description) metadata.description = body.description;
  if (body.author) metadata.author = body.author;
  if (body.publishedAt) metadata.publishedDate = body.publishedAt;
  const record = {
    $type: 'network.cosmik.card',
    type: 'URL',
    content: {
      url: body.url,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
    url: body.url,
    createdAt: new Date().toISOString(),
  };

  const pdsClient = createPDSClient(session);
  const result = await pdsClient.putRecord('network.cosmik.card', rkey, record);

  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // For each selected collection, create a collectionLink record.
  const collectionResults: { uri: string; error?: string }[] = [];
  for (const col of collections) {
    const linkRkey = generateTID();
    const collectionLink = {
      $type: 'network.cosmik.collectionLink',
      collection: { uri: col.uri, cid: col.cid },
      card: { uri: result.data.uri, cid: result.data.cid },
      addedBy: session.did,
      addedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    const linkResult = await pdsClient.putRecord(
      'network.cosmik.collectionLink',
      linkRkey,
      collectionLink
    );
    collectionResults.push(
      linkResult.success ? { uri: col.uri } : { uri: col.uri, error: linkResult.error }
    );
  }

  return new Response(
    JSON.stringify({
      uri: result.data.uri,
      cid: result.data.cid,
      ...(collectionResults.length > 0 ? { collectionResults } : {}),
    }),
    { status: 201, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * GET /api/integrations/semble/collections — list user's network.cosmik.collection records
 */
export async function handleListSembleCollections(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const checkResult = checkIntegrationScopes(session, 'semble');
  if (checkResult) return checkResult;

  const pdsClient = createPDSClient(session);
  const result = await pdsClient.listAllRecords<{
    name?: string;
    description?: string;
    createdAt?: string;
  }>('network.cosmik.collection', { maxPages: 5 });

  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const collections = result.data.map((r) => ({
    uri: r.uri,
    cid: r.cid,
    name: r.value.name,
    description: r.value.description,
    createdAt: r.value.createdAt,
  }));

  return new Response(JSON.stringify({ collections }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * POST /api/integrations/margin/bookmarks — save a page to Margin.
 *
 * Margin no longer has a distinct bookmark record; bookmarks are an
 * at.margin.note with `motivation: 'bookmarking'` (no selector, since the whole
 * page is the target) and the description carried in `body.value`.
 */
export async function handleCreateMarginBookmark(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const checkResult = checkIntegrationScopes(session, 'margin');
  if (checkResult) return checkResult;

  let body: {
    url: string;
    title?: string;
    description?: string;
    collectionUris?: string[];
    // Legacy single-collection field — still accepted from in-flight queued entries
    collectionUri?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.url) {
    return new Response(JSON.stringify({ error: 'url is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const collectionUris: string[] =
    body.collectionUris && body.collectionUris.length > 0
      ? body.collectionUris
      : body.collectionUri
        ? [body.collectionUri]
        : [];

  const rkey = generateTID();
  const description = body.description?.trim();
  const record = {
    $type: 'at.margin.note',
    motivation: 'bookmarking',
    target: {
      source: body.url,
      ...(body.title ? { title: body.title } : {}),
    },
    ...(description ? { body: { value: description, format: 'text/plain' } } : {}),
    tags: [],
    generator: { name: 'Skyreader', homepage: 'https://skyreader.app' },
    createdAt: new Date().toISOString(),
  };

  const pdsClient = createPDSClient(session);
  const result = await pdsClient.putRecord('at.margin.note', rkey, record);

  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // For each selected collection, create a collectionItem record.
  const collectionResults: { uri: string; error?: string }[] = [];
  for (const uri of collectionUris) {
    const itemRkey = generateTID();
    const collectionItem = {
      $type: 'at.margin.collectionItem',
      collection: uri,
      annotation: result.data.uri,
      createdAt: new Date().toISOString(),
    };
    const itemResult = await pdsClient.putRecord(
      'at.margin.collectionItem',
      itemRkey,
      collectionItem
    );
    collectionResults.push(itemResult.success ? { uri } : { uri, error: itemResult.error });
  }

  return new Response(
    JSON.stringify({
      uri: result.data.uri,
      cid: result.data.cid,
      ...(collectionResults.length > 0 ? { collectionResults } : {}),
    }),
    { status: 201, headers: { 'Content-Type': 'application/json' } }
  );
}

interface MarginNoteBody {
  source: string;
  title?: string;
  exact: string;
  prefix?: string;
  suffix?: string;
  note?: string;
}

/**
 * Build an at.margin.note record. When a `note` is present it's carried as the
 * annotation's comment body — Margin expects a `{ value, format }` shape — so
 * the note stays portable across the Atmosphere.
 */
function buildMarginNoteRecord(body: MarginNoteBody, createdAt: string) {
  const note = body.note?.trim();
  return {
    $type: 'at.margin.note',
    motivation: 'highlighting',
    target: {
      source: body.source,
      ...(body.title ? { title: body.title } : {}),
      selector: {
        type: 'TextQuoteSelector',
        exact: body.exact,
        ...(body.prefix ? { prefix: body.prefix } : {}),
        ...(body.suffix ? { suffix: body.suffix } : {}),
      },
    },
    ...(note ? { body: { value: note, format: 'text/plain' } } : {}),
    generator: { name: 'Skyreader', homepage: 'https://skyreader.app' },
    createdAt,
  };
}

/**
 * POST /api/integrations/margin/notes — create an at.margin.note (highlight) on PDS
 */
export async function handleCreateMarginNote(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const checkResult = checkIntegrationScopes(session, 'margin');
  if (checkResult) return checkResult;

  let body: MarginNoteBody;
  try {
    body = (await request.json()) as MarginNoteBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.source || !body.exact) {
    return new Response(JSON.stringify({ error: 'source and exact are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rkey = generateTID();
  const record = buildMarginNoteRecord(body, new Date().toISOString());

  const pdsClient = createPDSClient(session);
  const result = await pdsClient.putRecord('at.margin.note', rkey, record);

  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ uri: result.data.uri, cid: result.data.cid, rkey }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * PUT /api/integrations/margin/notes/:rkey — update an existing at.margin.note
 * (e.g. to add/edit/clear its note body), reusing the same rkey.
 */
export async function handleUpdateMarginNote(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const checkResult = checkIntegrationScopes(session, 'margin');
  if (checkResult) return checkResult;

  const rkey = new URL(request.url).pathname.split('/').pop();
  if (!rkey) {
    return new Response(JSON.stringify({ error: 'rkey is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: MarginNoteBody;
  try {
    body = (await request.json()) as MarginNoteBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.source || !body.exact) {
    return new Response(JSON.stringify({ error: 'source and exact are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const pdsClient = createPDSClient(session);

  // Preserve the record's original creation time — a note edit reuses the rkey
  // and must not rewrite when the highlight was first made. Fall back to now if
  // the existing record is missing or carries no createdAt.
  const existing = await pdsClient.getRecord<{ createdAt?: string }>('at.margin.note', rkey);
  const createdAt = (existing.success && existing.data.value.createdAt) || new Date().toISOString();
  const record = buildMarginNoteRecord(body, createdAt);

  const result = await pdsClient.putRecord('at.margin.note', rkey, record);

  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ uri: result.data.uri, cid: result.data.cid, rkey }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * DELETE /api/integrations/margin/notes/:rkey — delete an at.margin.note from PDS
 */
export async function handleDeleteMarginNote(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const checkResult = checkIntegrationScopes(session, 'margin');
  if (checkResult) return checkResult;

  const rkey = new URL(request.url).pathname.split('/').pop();
  if (!rkey) {
    return new Response(JSON.stringify({ error: 'rkey is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const pdsClient = createPDSClient(session);
  const result = await pdsClient.deleteRecord('at.margin.note', rkey);

  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * GET /api/integrations/margin/collections — list user's at.margin.collection records
 */
export async function handleListMarginCollections(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const checkResult = checkIntegrationScopes(session, 'margin');
  if (checkResult) return checkResult;

  const pdsClient = createPDSClient(session);
  const result = await pdsClient.listAllRecords<{
    name?: string;
    description?: string;
    createdAt?: string;
  }>('at.margin.collection', { maxPages: 5 });

  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const collections = result.data.map((r) => ({
    uri: r.uri,
    cid: r.cid,
    name: r.value.name,
    description: r.value.description,
    createdAt: r.value.createdAt,
  }));

  return new Response(JSON.stringify({ collections }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
