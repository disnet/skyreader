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
import { SEMBLE_CONNECTION_SCOPES } from '../config/scopes';
import { listAllRecordsPublic } from '../services/backing/read';
import { resolvePdsUrl } from '../utils/did-resolver';

/**
 * The scope sets a request can be gated on. `semble-connections` is a *separate*
 * capability from `semble`, not a superset: the connection scope is newer than
 * every live session, so folding it into the Semble set would break card saves
 * for everyone until they re-authed (see config/scopes.ts).
 */
export type ScopeGate = 'semble' | 'margin' | 'semble-connections';

const SCOPE_SETS: Record<ScopeGate, string[]> = {
  semble: SEMBLE_SCOPES,
  margin: MARGIN_SCOPES,
  'semble-connections': SEMBLE_CONNECTION_SCOPES,
};

/**
 * Check if the session has the required scopes for a specific integration
 */
export function hasIntegrationScopes(session: Session, integration: ScopeGate): boolean {
  if (!session.grantedScopes) return false;
  const granted = new Set(session.grantedScopes.split(' '));
  return SCOPE_SETS[integration].every((scope) => granted.has(scope));
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
        // Reported separately so a surface can tell "offer the control" from
        // "the control will trip the re-login banner" and say so up front.
        sembleConnections: hasIntegrationScopes(session, 'semble-connections'),
      },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Check session has required scopes for an integration
 */
function checkIntegrationScopes(session: Session, integration: ScopeGate): Response | null {
  if (!hasIntegrationScopes(session, integration)) {
    // The body still names the *integration* the reader recognizes, not the
    // internal gate — the frontend keys its re-login banner off this shape.
    const name = integration === 'semble-connections' ? 'semble' : integration;
    return new Response(
      JSON.stringify({
        error: 'scope_upgrade_required',
        message: `Additional permissions are needed for ${name}. Please log in again.`,
        integration: name,
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
 * GET /api/integrations/semble/cards — list all URL cards in the user's PDS.
 *
 * This is intentionally read live rather than cached: cards may have been made
 * in Semble itself, and the connection picker must search that whole library,
 * not only articles the reader also saved in Skyreader.
 */
export async function handleListSembleCards(request: Request, env: Env): Promise<Response> {
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
    type?: string;
    url?: string;
    content?: { url?: string; metadata?: { title?: string; author?: string } };
    createdAt?: string;
  }>('network.cosmik.card');

  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cards = result.data.flatMap((record) => {
    if (record.value.type && record.value.type !== 'URL') return [];
    const url = record.value.content?.url ?? record.value.url;
    if (!url || !isHttpUrl(url)) return [];
    return [
      {
        uri: record.uri,
        cid: record.cid,
        url,
        title: record.value.content?.metadata?.title,
        author: record.value.content?.metadata?.author,
        createdAt: record.value.createdAt,
      },
    ];
  });

  return new Response(JSON.stringify({ cards, truncated: result.truncated ?? false }), {
    headers: { 'Content-Type': 'application/json' },
  });
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
 * Semble's connection types, exact casing. `RELATED` and `HELPFUL` are
 * non-directional; the rest read source → target.
 */
export const SEMBLE_CONNECTION_TYPES = [
  'SUPPORTS',
  'OPPOSES',
  'ADDRESSES',
  'HELPFUL',
  'LEADS_TO',
  'RELATED',
  'SUPPLEMENT',
  'EXPLAINER',
] as const;

/** Semble's lexicon caps the note at 1000 (atproto string maxLength = UTF-8 bytes). */
const MAX_NOTE_BYTES = 1000;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Build a `network.cosmik.connection` record. Kept as one function with the
 * foreign lexicon quoted below, because `network.cosmik.*` is Semble's namespace
 * — nothing here is validated by a schema we own, so the shape lives in one
 * place that can be diffed against theirs.
 *
 * From cosmik-network/semble, `.../lexicons/connection.json` (key: tid):
 *   source        required string  — URL or AT URI
 *   target        required string  — URL or AT URI
 *   connectionType         string  — one of SEMBLE_CONNECTION_TYPES
 *   note                   string  — maxLength 1000
 *   createdAt / updatedAt  datetime
 */
export function buildSembleConnectionRecord(
  input: { source: string; target: string; connectionType?: string; note?: string },
  now: string
) {
  return {
    $type: 'network.cosmik.connection',
    source: input.source,
    target: input.target,
    ...(input.connectionType ? { connectionType: input.connectionType } : {}),
    ...(input.note ? { note: input.note } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * POST /api/integrations/semble/connections — create a network.cosmik.connection
 * on the user's PDS: a typed, directional edge from one URL to another.
 *
 * Online-only by design (no offline queue): a connection is a deliberate act on
 * live context, and unlike a card save there is nothing to reconcile later.
 */
export async function handleCreateSembleConnection(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const checkResult = checkIntegrationScopes(session, 'semble-connections');
  if (checkResult) return checkResult;

  let body: {
    source?: string;
    target?: string;
    connectionType?: string;
    note?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const bad = (error: string) =>
    new Response(JSON.stringify({ error }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });

  const source = typeof body.source === 'string' ? body.source.trim() : '';
  const target = typeof body.target === 'string' ? body.target.trim() : '';
  if (!source || !target) return bad('source and target are required');
  if (!isHttpUrl(source) || !isHttpUrl(target))
    return bad('source and target must be http(s) URLs');
  if (source === target) return bad('source and target must differ');

  const connectionType = body.connectionType?.trim();
  if (connectionType && !(SEMBLE_CONNECTION_TYPES as readonly string[]).includes(connectionType)) {
    return bad('Unknown connectionType');
  }

  const note = body.note?.trim();
  if (note && new TextEncoder().encode(note).length > MAX_NOTE_BYTES) {
    return bad(`note must be ${MAX_NOTE_BYTES} bytes or fewer`);
  }

  const rkey = generateTid();
  const record = buildSembleConnectionRecord(
    { source, target, connectionType, note },
    new Date().toISOString()
  );

  const pdsClient = createPDSClient(session);
  const result = await pdsClient.putRecord('network.cosmik.connection', rkey, record);

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

// --- Margin highlight import (the READ direction) -------------------------
//
// Skyreader has always pushed highlights out as at.margin.note records; this is
// the only path that reads the user's own notes back, so the review deck can
// cover everything they've highlighted across the Atmosphere. The read itself is
// public XRPC against their own repo (same auth-free primitive the backed-saves
// snapshot uses), but it is still gated on the margin scopes: without them a
// note edit on an imported highlight would queue a PDS write the session can't
// perform, which is a worse state than not importing at all.
//
// at.margin.note is a third-party lexicon that has already changed shape once,
// so every field is parsed defensively — one malformed record is skipped, never
// thrown, so a single bad note can't lose the whole poll.

// How many URLs one lookup carries. Each is bound TWICE (url_normalized and the
// legacy url column), and D1 caps a statement at 100 bound parameters — so 40
// URLs is 81 params, comfortably under the cap.
export const MATCH_CHUNK = 40;

export interface MarginHighlightNote {
  uri: string;
  rkey: string;
  url: string;
  urlNormalized: string;
  title?: string;
  selector: { type: 'TextQuoteSelector'; exact: string; prefix?: string; suffix?: string };
  note?: string;
  createdAt?: string;
  /** The user's save this note's URL landed on, when there is one. */
  match: { itemGuid: string | null; uri: string | null } | null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Parse one at.margin.note into a highlight, or null when it isn't one we can
 * use: a bookmarking note (that's a save, not a highlight), a missing or
 * non-TextQuote selector, an empty quote, or a source that isn't an http(s) URL.
 */
export function parseMarginHighlightNote(
  uri: string,
  value: unknown
): Omit<MarginHighlightNote, 'match'> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.motivation !== 'highlighting') return null;

  const target = record.target;
  if (!target || typeof target !== 'object') return null;
  const targetRecord = target as Record<string, unknown>;

  const source = optionalString(targetRecord.source);
  if (!source) return null;
  const urlNormalized = normalizeArticleUrl(source);
  if (!urlNormalized) return null;

  const selector = targetRecord.selector;
  if (!selector || typeof selector !== 'object') return null;
  const selectorRecord = selector as Record<string, unknown>;
  if (selectorRecord.type !== 'TextQuoteSelector') return null;
  const exact = optionalString(selectorRecord.exact);
  if (!exact) return null;

  const rkey = uri.split('/').pop();
  if (!rkey) return null;

  // The note body is a W3C comment body ({ value, format }); older records may
  // carry a bare string.
  let note: string | undefined;
  const body = record.body;
  if (typeof body === 'string') note = optionalString(body);
  else if (body && typeof body === 'object') {
    note = optionalString((body as Record<string, unknown>).value);
  }

  return {
    uri,
    rkey,
    url: source,
    urlNormalized,
    title: optionalString(targetRecord.title),
    selector: {
      type: 'TextQuoteSelector',
      exact,
      prefix: optionalString(selectorRecord.prefix),
      suffix: optionalString(selectorRecord.suffix),
    },
    note,
    createdAt: optionalString(record.createdAt),
  };
}

/**
 * Join parsed notes onto the user's saves by normalized URL. Legacy saves
 * predate `url_normalized`, so their raw `url` is normalized in-process and
 * matched too. Returns a lookup keyed by normalized URL.
 */
async function matchNotesToSaves(
  env: Env,
  did: string,
  urls: string[]
): Promise<Map<string, { itemGuid: string | null; uri: string | null }>> {
  const matches = new Map<string, { itemGuid: string | null; uri: string | null }>();
  if (urls.length === 0) return matches;

  for (let i = 0; i < urls.length; i += MATCH_CHUNK) {
    const chunk = urls.slice(i, i + MATCH_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await env.DB.prepare(
      `SELECT url, url_normalized, item_guid, record_uri FROM saved_articles
       WHERE user_did = ? AND (url_normalized IN (${placeholders}) OR url IN (${placeholders}))`
    )
      .bind(did, ...chunk, ...chunk)
      .all<{
        url: string | null;
        url_normalized: string | null;
        item_guid: string | null;
        record_uri: string | null;
      }>();

    // Key by whichever candidate is actually one of the URLs we asked for — a
    // row matched on the legacy `url` column must not be filed under a
    // `url_normalized` the caller never looks up.
    const requested = new Set(chunk);
    for (const row of result.results || []) {
      const candidates = [
        row.url_normalized,
        row.url ? normalizeArticleUrl(row.url) : null,
        row.url,
      ];
      const key = candidates.find((value): value is string => !!value && requested.has(value));
      if (!key || matches.has(key)) continue;
      matches.set(key, { itemGuid: row.item_guid, uri: row.record_uri });
    }
  }
  return matches;
}

/**
 * GET /api/integrations/margin/highlights — the user's own at.margin.note
 * highlights, matched against their saves. The client turns these into normal
 * Skyreader highlights (see services/marginHighlightImport.ts).
 */
export async function handleListMarginHighlights(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const checkResult = checkIntegrationScopes(session, 'margin');
  if (checkResult) return checkResult;

  const pds = (await resolvePdsUrl(session.did)) || session.pdsUrl;
  if (!pds) {
    return new Response(JSON.stringify({ error: 'Could not resolve your PDS' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let records: { uri: string; value: unknown }[];
  let truncated = false;
  try {
    const listed = await listAllRecordsPublic(pds, session.did, 'at.margin.note');
    records = listed.records;
    truncated = listed.truncated;
  } catch (error) {
    console.error('Failed to list at.margin.note records:', error);
    return new Response(JSON.stringify({ error: 'Could not read your Margin highlights' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const parsed: Omit<MarginHighlightNote, 'match'>[] = [];
  for (const record of records) {
    const note = parseMarginHighlightNote(record.uri, record.value);
    if (note) parsed.push(note);
  }

  const matches = await matchNotesToSaves(env, session.did, [
    ...new Set(parsed.map((note) => note.urlNormalized)),
  ]);

  const notes: MarginHighlightNote[] = parsed.map((note) => ({
    ...note,
    match: matches.get(note.urlNormalized) ?? null,
  }));

  return new Response(JSON.stringify({ notes, truncated }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
