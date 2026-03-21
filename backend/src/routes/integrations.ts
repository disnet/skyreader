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

  const rkey = generateTID();
  const record = {
    $type: 'network.cosmik.card',
    type: 'URL',
    content: {
      url: body.url,
      title: body.title || undefined,
      description: body.description || undefined,
      author: body.author || undefined,
      publicationDate: body.publishedAt || undefined,
    },
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

  // If a collection was specified, add the card to it via collectionLink
  if (body.collectionUri && body.collectionCid) {
    const linkRkey = generateTID();
    const collectionLink = {
      $type: 'network.cosmik.collectionLink',
      collection: { uri: body.collectionUri, cid: body.collectionCid },
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
    if (!linkResult.success) {
      // Card was created but collection link failed — return success with warning
      return new Response(
        JSON.stringify({
          uri: result.data.uri,
          cid: result.data.cid,
          collectionError: linkResult.error,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  return new Response(JSON.stringify({ uri: result.data.uri, cid: result.data.cid }), {
    status: 201,
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
 * POST /api/integrations/margin/bookmarks — create an at.margin.bookmark on PDS
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

  const rkey = generateTID();
  const record = {
    $type: 'at.margin.bookmark',
    source: body.url,
    title: body.title || undefined,
    description: body.description || undefined,
    tags: [],
    createdAt: new Date().toISOString(),
  };

  const pdsClient = createPDSClient(session);
  const result = await pdsClient.putRecord('at.margin.bookmark', rkey, record);

  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // If a collection was specified, add the bookmark to it
  if (body.collectionUri) {
    const itemRkey = generateTID();
    const collectionItem = {
      $type: 'at.margin.collectionItem',
      collection: body.collectionUri,
      annotation: result.data.uri,
      createdAt: new Date().toISOString(),
    };
    const itemResult = await pdsClient.putRecord(
      'at.margin.collectionItem',
      itemRkey,
      collectionItem
    );
    if (!itemResult.success) {
      return new Response(
        JSON.stringify({
          uri: result.data.uri,
          cid: result.data.cid,
          collectionError: itemResult.error,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  return new Response(JSON.stringify({ uri: result.data.uri, cid: result.data.cid }), {
    status: 201,
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
