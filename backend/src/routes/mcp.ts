import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  getOAuthApi,
  type ConsentDescription,
  type OAuthHelpers,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import type { Env } from '../types';
import { MCP_AUTHORIZE_PATH } from '../config/mcp';
import { getSessionFromRequest } from '../services/oauth';
import { getUserTier } from '../services/user-tier';
import { getLimitsForTier } from '../config/tier-limits';
import { checkRateLimit } from '../services/rate-limit';
import { escapeHtml } from '../utils/html-text';
import { setContextDid } from '../utils/request-context';
import { handleMcpMessage, type McpReader } from '../services/mcp/server';

/**
 * Skyreader's MCP server: an LLM app (Claude, ChatGPT, Cursor…) reads a reader's
 * saves, highlights and search, with their permission. Read-only, and a
 * Supporter feature (`liveIntegrations`, like highlight sync and Zotero).
 *
 * Skyreader is the OAuth 2.1 authorization server for it, through
 * @cloudflare/workers-oauth-provider, which owns discovery, dynamic client
 * registration, Client ID Metadata Documents, the token endpoint and the token
 * records (in OAUTH_KV, hashed). This file owns the one interactive step,
 * /oauth/authorize: the reader is signed in with their usual Skyreader session
 * (the existing atproto login) and approves the app on a consent page.
 *
 * The tokens are the provider's, not Skyreader sessions: they're accepted only
 * at /mcp, so a leaked one reads, and can't act. A session id would carry the
 * whole API (`getSessionIdFromRequest` takes any Bearer value as one).
 *
 *   /mcp                                     the MCP endpoint (services/mcp/server.ts)
 *   /oauth/authorize                         sign-in + consent (here)
 *   /oauth/token, /oauth/register            the provider's
 *   /.well-known/oauth-authorization-server  the provider's (RFC 8414)
 *   /.well-known/oauth-protected-resource…   the provider's (RFC 9728)
 */

export const MCP_PATH = '/mcp';
const MCP_TOKEN_PATH = '/oauth/token';
const MCP_REGISTER_PATH = '/oauth/register';

/** The one scope: read what the reader has saved, highlighted and read. */
export const MCP_READ_SCOPE = 'mcp:read';

// Access tokens are short-lived; the refresh token keeps a connection alive for
// as long as the app is used, and lapses after a month idle.
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// Rate-limit key for client registration, counted per IP.
export const MCP_REGISTER_RATE_KEY = '/oauth/register';

/** What a grant carries to every /mcp request (`ctx.props`). */
export interface McpProps {
  did: string;
  handle: string;
}

/** Shown in Settings next to the grant. */
interface McpGrantMetadata {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
}

/** Whether a path is one this file answers. Checked before anything else in the Worker. */
export function isMcpPath(pathname: string): boolean {
  return (
    pathname === MCP_PATH ||
    pathname.startsWith(`${MCP_PATH}/`) ||
    pathname === MCP_AUTHORIZE_PATH ||
    pathname === MCP_TOKEN_PATH ||
    pathname === MCP_REGISTER_PATH ||
    pathname === '/.well-known/oauth-authorization-server' ||
    pathname === '/.well-known/oauth-protected-resource' ||
    pathname.startsWith('/.well-known/oauth-protected-resource/')
  );
}

/** The grant's user id: a DID has colons, which the provider's keys can't hold. */
export const mcpUserId = (did: string) => encodeURIComponent(did);

// The provider is configured from the request's origin, so staging and local
// dev name themselves. One per origin, built on first use.
const providers = new Map<string, OAuthProvider<Env>>();

function providerOptions(origin: string) {
  return {
    apiRoute: MCP_PATH,
    apiHandler: { fetch: handleMcpApi } as ExportedHandler<Env> & {
      fetch: NonNullable<ExportedHandler<Env>['fetch']>;
    },
    defaultHandler: { fetch: handleAuthorize } as ExportedHandler<Env>,
    authorizeEndpoint: MCP_AUTHORIZE_PATH,
    tokenEndpoint: MCP_TOKEN_PATH,
    clientRegistrationEndpoint: MCP_REGISTER_PATH,
    scopesSupported: [MCP_READ_SCOPE],
    requiredScopes: [MCP_READ_SCOPE],
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    refreshTokenIdleTTL: REFRESH_TOKEN_TTL_SECONDS,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${origin}${MCP_PATH}`,
      resource_name: 'Skyreader',
    },
  };
}

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>(providerOptions(origin));
    providers.set(origin, provider);
  }
  return provider;
}

/** The provider's helpers outside a request it routed: Settings lists and revokes grants. */
export function mcpOAuthApi(env: Env, origin: string): OAuthHelpers {
  return getOAuthApi<Env>(providerOptions(origin), env);
}

/**
 * Every MCP and OAuth path. Answered before the API's own CORS, cross-site and
 * session handling: these are called by apps, not by Skyreader's pages, and the
 * provider sets its own CORS headers and checks its own credentials.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // Registration writes a client to KV with no credential at all, so it's
  // capped per IP, loosely: hosted AI apps register every reader who connects
  // from a few shared addresses. Token exchange isn't: it's the same apps'
  // hourly refreshes, and a code or refresh token is too long to guess.
  if (url.pathname === MCP_REGISTER_PATH && request.method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limit = await checkRateLimit(env, `ip:${ip}`, MCP_REGISTER_RATE_KEY);
    if (!limit.allowed) {
      return Response.json(
        { error: 'slow_down', error_description: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter ?? 60) } }
      );
    }
  }

  return providerFor(url.origin).fetch(request, env, ctx);
}

// ─── /mcp ───────────────────────────────────────────────────────────────────

async function handleMcpApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { props, auth } = ctx as OAuthResourceContext<McpProps>;
  if (!auth.scope.includes(MCP_READ_SCOPE)) {
    return Response.json({ error: 'insufficient_scope' }, { status: 403 });
  }
  setContextDid(props.did);
  const reader: McpReader = { did: props.did, handle: props.handle };
  return handleMcpMessage(request, env, ctx, reader);
}

// ─── /oauth/authorize ───────────────────────────────────────────────────────

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== MCP_AUTHORIZE_PATH) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  const oauth = (env as Env & { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;

  try {
    if (request.method === 'POST') return await submitConsent(request, env, oauth);
    if (request.method !== 'GET') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    // Parsed before sign-in, so a bad request is answered here rather than
    // after a round trip through the login.
    const authRequest = await oauth.parseAuthRequest(request);

    const session = await getSessionFromRequest(request, env);
    if (!session) {
      // The usual sign-in, which comes back to this exact URL.
      const login = new URL('/auth/login', env.FRONTEND_URL);
      login.searchParams.set('returnUrl', url.toString());
      return Response.redirect(login.toString(), 302);
    }

    if (!getLimitsForTier(await getUserTier(env, session.did)).liveIntegrations) {
      return page(upgradePage(env, session.handle), 403);
    }

    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return page(
      consentPage(details, consent.handle, session.handle, session.did),
      200,
      consent.headers
    );
  } catch (error) {
    return authorizeError(error);
  }
}

async function submitConsent(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return page(
      messagePage('You’ve been signed out', 'Sign in to Skyreader and try again from the app.'),
      401
    );
  }
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  // The account the page named: one signed in since then in this browser starts over.
  if (form.get('reader') !== session.did) {
    return page(messagePage('You switched accounts', 'Start connecting again from the app.'), 409);
  }

  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  // Checked again: the plan may have lapsed while the page was open.
  if (!getLimitsForTier(await getUserTier(env, session.did)).liveIntegrations) {
    return page(upgradePage(env, session.handle), 403);
  }

  const approved = await oauth.approveConsent(request, handle, { scope: [MCP_READ_SCOPE] });
  const details = await oauth.describeConsent(approved.request);
  const metadata: McpGrantMetadata = {
    clientName: details.clientName,
    ...(details.clientDomain ? { clientDomain: details.clientDomain } : {}),
    redirectHost: details.redirectHost,
  };
  const props: McpProps = { did: session.did, handle: session.handle };
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: mcpUserId(session.did),
    metadata,
    scope: [MCP_READ_SCOPE],
    props,
  });
  approved.headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

function authorizeError(error: unknown): Response {
  // Shown here, never redirected to the app: anyone can register a client with
  // any redirect URI, and a redirect on a bad request would make this page, and
  // so the sign-in that returns to it, an open redirect (RFC 9700 §4.11.2).
  if (error instanceof AuthorizationError) {
    return page(messagePage('This sign-in link didn’t work', error.description), 400);
  }
  if (error instanceof CimdFetchError) {
    return page(
      messagePage(
        'This app couldn’t be verified',
        'Its details couldn’t be fetched. Try again in a moment.'
      ),
      400
    );
  }
  throw error;
}

// ─── Pages ──────────────────────────────────────────────────────────────────

function page(body: string, status: number, headers = new Headers()): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  // beginConsent's headers already forbid framing; every page here does too.
  headers.set('X-Frame-Options', 'DENY');
  headers.set(
    'Content-Security-Policy',
    // No form-action: it would also govern the redirect to the app after Allow,
    // and an app's redirect URI can be any loopback address.
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
  );
  return new Response(shell(body), { status, headers });
}

function shell(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Skyreader</title>
<style>
  :root { color-scheme: light dark; --ink: #333333; --quiet: #666666; --rule: #e0e0e0; --bg: #ffffff; --blue: #0066cc; --warn-bg: #fff7e6; --warn-ink: #7a4b00; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e0e0e0; --quiet: #999999; --rule: #404040; --bg: #1a1a1a; --blue: #4da6ff; --warn-bg: #2b2210; --warn-ink: #f0c060; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 28rem; margin: 12vh auto 0; padding: 0 16px; }
  .brand { font-weight: 600; color: var(--quiet); font-size: 14px; margin: 0 0 24px; }
  h1 { font-size: 22px; line-height: 1.3; margin: 0 0 12px; font-weight: 600; }
  p { margin: 0 0 12px; }
  .quiet { color: var(--quiet); font-size: 14px; }
  ul { margin: 0 0 16px; padding-left: 20px; }
  .warn { background: var(--warn-bg); color: var(--warn-ink); padding: 10px 12px; border-radius: 6px; font-size: 14px; }
  .actions { display: flex; gap: 12px; margin-top: 24px; }
  button, .button { font: inherit; padding: 8px 18px; border-radius: 6px; border: 1px solid var(--rule); background: transparent; color: var(--ink); cursor: pointer; text-decoration: none; }
  button.primary, .button.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
  a { color: var(--blue); }
</style>
</head>
<body><main><p class="brand">Skyreader</p>${body}</main></body>
</html>`;
}

function consentPage(
  details: ConsentDescription,
  handle: string,
  readerHandle: string,
  readerDid: string
): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `<p class="quiet">Published by <strong>${escapeHtml(details.clientDomain)}</strong>.</p>`
    : '<p class="quiet">This app named itself; Skyreader can’t verify the name.</p>';
  const loopback = details.redirectIsLoopback
    ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>'
    : '';
  return `<h1>Let ${name} read your Skyreader?</h1>
${origin}
<p>It will be able to:</p>
<ul>
  <li>Search what you’ve read, saved and highlighted</li>
  <li>Read your saved articles, highlights and notes</li>
  <li>See your Shelf collections</li>
</ul>
<p class="quiet">It can’t change anything. Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>, for @${escapeHtml(readerHandle)}. You can disconnect it any time in Settings.</p>
${loopback}
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <input type="hidden" name="reader" value="${escapeHtml(readerDid)}">
  <div class="actions">
    <button class="primary" name="decision" value="approve">Allow</button>
    <button name="decision" value="deny">Cancel</button>
  </div>
</form>`;
}

function upgradePage(env: Env, readerHandle: string): string {
  const supporter = new URL('/supporter', env.FRONTEND_URL).toString();
  return `<h1>Connecting AI apps is a Supporter feature</h1>
<p>With Supporter, apps like Claude can search and read what you’ve saved and highlighted in Skyreader.</p>
<p class="quiet">Signed in as @${escapeHtml(readerHandle)}.</p>
<div class="actions"><a class="button primary" href="${escapeHtml(supporter)}">See Supporter</a></div>`;
}

function messagePage(title: string, detail: string): string {
  return `<h1>${escapeHtml(title)}</h1><p class="quiet">${escapeHtml(detail)}</p>`;
}
