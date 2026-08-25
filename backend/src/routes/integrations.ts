import type { Env, Session } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { createPDSClient } from '../services/pds-client';
import { generateTid } from '../utils/tid';
import { normalizeArticleUrl } from '../utils/url-normalize';
import {
  findMemberships,
  editMemberships,
  MembershipEditError,
  type IntegrationProvider,
} from '../services/integration-membership';
import { SEMBLE_SCOPES, MARGIN_SCOPES } from './auth';

/**
 * Check if the session has the required scopes for a specific integration
 */
export function hasIntegrationScopes(session: Session, integration: 'semble' | 'margin'): boolean {
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

// rkeys come from utils/tid's generateTid — the real spec TID (monotonic within a
// session, decodes back to a timestamp), shared with the backing write path.

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

  const rkey = generateTid();
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
    const linkRkey = generateTid();
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

/** `/api/integrations/<provider>/memberships` — the provider segment of the path. */
function providerFromPath(request: Request): IntegrationProvider | null {
  const parts = new URL(request.url).pathname.split('/');
  const provider = parts[3];
  return provider === 'semble' || provider === 'margin' ? provider : null;
}

/**
 * GET /api/integrations/:provider/memberships?url=… — which collections this URL is
 * already saved to. Read straight from the PDS: the picker opens on live state, not
 * on a Skyreader-side memory of what it once wrote.
 */
export async function handleGetIntegrationMemberships(
  request: Request,
  env: Env
): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const provider = providerFromPath(request);
  if (!provider) {
    return new Response(JSON.stringify({ error: 'Unknown integration' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const checkResult = checkIntegrationScopes(session, provider);
  if (checkResult) return checkResult;

  const url = new URL(request.url).searchParams.get('url');
  if (!url) {
    return new Response(JSON.stringify({ error: 'url is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const pdsClient = createPDSClient(session);
  const result = await findMemberships(pdsClient, provider, url);
  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(result.data), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * POST /api/integrations/:provider/memberships — apply a membership diff for one URL.
 *
 * Body: `{ url, add: [{ uri, cid? }], remove: [linkUri], title?, description?, … }`.
 * Removals only ever delete membership records (validated to this provider's lexicon
 * and the caller's own repo); the card/note itself is never deleted. The metadata
 * fields are used only when the URL has no item yet and one has to be created.
 */
export async function handleEditIntegrationMemberships(
  request: Request,
  env: Env
): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const provider = providerFromPath(request);
  if (!provider) {
    return new Response(JSON.stringify({ error: 'Unknown integration' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const checkResult = checkIntegrationScopes(session, provider);
  if (checkResult) return checkResult;

  let body: {
    url?: string;
    add?: { uri: string; cid?: string }[];
    remove?: string[];
    title?: string;
    description?: string;
    author?: string;
    publishedAt?: string;
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

  const add = (body.add ?? []).filter((c) => c && typeof c.uri === 'string');
  const remove = (body.remove ?? []).filter((uri) => typeof uri === 'string');

  const pdsClient = createPDSClient(session);
  try {
    const result = await editMemberships(pdsClient, session.did, provider, {
      url: body.url,
      add,
      remove,
      title: body.title,
      description: body.description,
      author: body.author,
      publishedAt: body.publishedAt,
    });
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof MembershipEditError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: err.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw err;
  }
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

  const rkey = generateTid();
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
    const itemRkey = generateTid();
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
export function buildMarginNoteRecord(body: MarginNoteBody, createdAt: string) {
  const note = body.note?.trim();
  const source = normalizeArticleUrl(body.source) ?? body.source.trim();
  return {
    $type: 'at.margin.note',
    motivation: 'highlighting',
    target: {
      source,
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

  const rkey = generateTid();
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
