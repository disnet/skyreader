import type { GrantSummary } from '@cloudflare/workers-oauth-provider';
import type { Env, Session } from '../types';
import { MCP_PATH, mcpOAuthApi, mcpUserId } from './mcp';

/**
 * The AI apps a reader has connected to Skyreader's MCP server (routes/mcp.ts),
 * for Settings.
 *
 *   GET    /api/mcp/connections      → { serverUrl, connections: [{ id, name, domain?, redirectHost?, connectedAt }] }
 *   DELETE /api/mcp/connections/:id  → { success: true }   disconnects: the grant and its tokens go
 *
 * `serverUrl` is what the reader pastes into the app, this environment's own.
 */

export const MCP_CONNECTIONS_PATH = '/api/mcp/connections';

// More than anyone connects; the provider pages at 1000.
const MAX_LISTED = 100;

interface GrantMetadata {
  clientName?: string;
  clientDomain?: string;
  redirectHost?: string;
}

function connection(grant: GrantSummary) {
  const meta = (grant.metadata ?? {}) as GrantMetadata;
  return {
    id: grant.id,
    name: meta.clientName || 'An app',
    ...(meta.clientDomain ? { domain: meta.clientDomain } : {}),
    ...(meta.redirectHost ? { redirectHost: meta.redirectHost } : {}),
    connectedAt: new Date(grant.createdAt * 1000).toISOString(),
  };
}

export async function handleMcpConnections(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  const url = new URL(request.url);
  const oauth = mcpOAuthApi(env, url.origin);
  const userId = mcpUserId(session.did);
  let id: string;
  try {
    id = decodeURIComponent(url.pathname.slice(MCP_CONNECTIONS_PATH.length).replace(/^\//, ''));
  } catch {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  if (id) {
    if (request.method !== 'DELETE')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    // Only the reader's own: revokeGrant is keyed by user, so another's id finds nothing.
    const grants = await oauth.listUserGrants(userId, { limit: MAX_LISTED });
    if (!grants.items.some((g) => g.id === id)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    await oauth.revokeGrant(id, userId);
    return Response.json({ success: true });
  }

  if (request.method !== 'GET')
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const grants = await oauth.listUserGrants(userId, { limit: MAX_LISTED });
  return Response.json({
    serverUrl: `${url.origin}${MCP_PATH}`,
    connections: grants.items
      .filter((g) => !g.expiresAt || g.expiresAt * 1000 > Date.now())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(connection),
  });
}
