import type { Env, Session } from '../types';
import {
  generateRandomString,
  generatePKCE,
  generateDPoPKeyPair,
  exportPrivateKey,
  importPrivateKey,
  createDPoPProof,
  resolveHandle,
  normalizeHandleInput,
  getPdsFromDid,
  invalidatePdsCache,
  fetchAuthServerMetadata,
  storeOAuthState,
  getOAuthState,
  deleteOAuthState,
  storeSession,
  getSession,
  deleteSession,
  getSessionFromRequest,
  getSessionIdFromRequest,
} from '../services/oauth';
import { getClientJWKS, createClientAssertion } from '../services/client-auth';
import { buildLocalhostClientId } from '../services/oauth';
import {
  GRANULAR_SCOPES,
  SEMBLE_SCOPES,
  MARGIN_SCOPES,
  LINKBLOG_SCOPES,
  PCKT_SCOPES,
  OFFPRINT_SCOPES,
  ALL_POSSIBLE_SCOPES,
  buildRequestedScopes,
  clientMetadataScopes,
  isScopeFeature,
  type ScopeFeature,
} from '../config/scopes';
import { grantsScopes, grantedFeatures } from '../services/scope-check';
import { getUserTier, getUserTierInfo } from '../services/user-tier';
import { writeUsageRecord } from '../services/at-intent-usage';
import { getLimitsForTier } from '../config/tier-limits';
import {
  buildSetCookieHeader,
  buildClearCookieHeader,
  getCookieDomain,
  isSecureContext,
  parseCookies,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE,
} from '../utils/cookies';

// Maximum number of users allowed during beta
const MAX_USERS = 2000;

// Curated set of provider hosts the server-first sign-up flow may target. Because
// the `pds` param is user-controlled and we fetch its well-known OAuth metadata,
// this doubles as an SSRF allowlist — only these known atproto entryways/PDSes are
// ever reachable. Keep in sync with the providers list in the frontend login page.
const SIGNUP_PDS_HOSTS = new Set(['bsky.social', 'eurosky.social', 'blacksky.app']);

// Normalize a user-supplied PDS/entryway host into a clean https origin and confirm
// it is on the allowlist. Drops any path/query and forces https so the sign-up flow
// only ever hits a known host's well-known OAuth metadata. Returns null if the host
// is malformed or not allowlisted.
function normalizePdsHost(input: string): string | null {
  let parsed: URL;
  try {
    const trimmed = input.trim();
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!SIGNUP_PDS_HOSTS.has(host)) return null;
  return `https://${host}`;
}

// Scope constants now live in config/scopes.ts (shared with the token-refresh
// path). Re-exported here so existing importers (integrations, linkblog, saved)
// keep working unchanged.
export {
  GRANULAR_SCOPES,
  SEMBLE_SCOPES,
  MARGIN_SCOPES,
  LINKBLOG_SCOPES,
  PCKT_SCOPES,
  OFFPRINT_SCOPES,
  ALL_POSSIBLE_SCOPES,
};

// Check if granted scopes satisfy the required scopes: always Skyreader's own
// base collections, plus any feature-specific ones. Matching is semantic (see
// services/scope-check.ts), so a permission-set grant satisfies the granular form.
export function hasRequiredScopes(
  grantedScopes: string | undefined,
  additionalScopes?: string[]
): boolean {
  // A session without scope tracking fails every check and is sent to re-grant.
  return grantsScopes(grantedScopes, [...GRANULAR_SCOPES.split(' '), ...(additionalScopes ?? [])]);
}

// Create a 403 response for insufficient scopes. `feature` names the optional
// feature whose permission is missing, so the frontend can ask for exactly that
// (POST /api/auth/upgrade) instead of a full re-login. Omitted means the
// session's base permissions are outdated.
export function insufficientScopesResponse(feature?: ScopeFeature): Response {
  return new Response(
    JSON.stringify({
      error: 'scope_upgrade_required',
      message: feature
        ? "This needs a permission your sign-in didn't include."
        : 'Your session was created with outdated permissions. Please log in again.',
      ...(feature ? { feature } : {}),
    }),
    {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

// Get base URL for OAuth, normalizing localhost to 127.0.0.1 for redirect URIs
function getBaseUrl(url: URL): string {
  let host = url.host;
  let protocol = url.protocol;

  // Replace localhost with 127.0.0.1 for redirect URIs
  if (host.startsWith('localhost')) {
    host = host.replace('localhost', '127.0.0.1');
  }

  return `${protocol}//${host}`;
}

// Check if CLIENT_SIGNING_KEY is configured (confidential client mode)
function hasClientSigningKey(env: Env): boolean {
  return !!(env as Env & { CLIENT_SIGNING_KEY?: string }).CLIENT_SIGNING_KEY;
}

// Check if request is from localhost (for public client redirect URI validation)
function isLocalhostRequest(url: URL): boolean {
  const host = url.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// Determine client mode with security checks:
// - If CLIENT_SIGNING_KEY is set → confidential client (production)
// - If not set AND localhost request → public client (local dev)
// - If not set AND non-localhost → throw error (misconfiguration)
function getClientMode(env: Env, url: URL): 'confidential' | 'public' {
  if (hasClientSigningKey(env)) {
    return 'confidential';
  }
  if (isLocalhostRequest(url)) {
    return 'public';
  }
  throw new Error(
    'CLIENT_SIGNING_KEY is required for non-localhost deployments. ' +
      'Generate one with: npx tsx scripts/generate-client-key.ts'
  );
}

// Validate returnUrl to prevent open redirect attacks
function isValidReturnUrl(url: string, allowedOrigins: string[] = []): boolean {
  // Safe relative path (the common in-app case):
  //  - starts with /          (relative)
  //  - no //                  (blocks protocol-relative //evil.com)
  //  - no backslash           (blocks /\evil.com tricks)
  if (url.startsWith('/') && !url.includes('//') && !url.includes('\\')) return true;

  // Absolute URL to a trusted origin — e.g. the standalone linkblog site, which
  // lives on its own subdomain and can't be expressed as a relative path. Gated
  // by the same ALLOWED_ORIGINS list CORS uses, so it's not an open redirect.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

// Get the list of allowed frontend origins
function getAllowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [env.FRONTEND_URL];
}

// Validate and get the frontend URL from the request origin
function getValidatedFrontendUrl(request: Request, env: Env): string {
  const origin = request.headers.get('Origin');
  const allowedOrigins = getAllowedOrigins(env);

  if (origin && allowedOrigins.includes(origin)) {
    return origin;
  }

  // Fall back to default FRONTEND_URL if origin not provided or not in allowed list
  return env.FRONTEND_URL;
}

// Client metadata endpoint - only needed for production (confidential client)
// For localhost development, AT Protocol uses virtual metadata from the client_id URL
export async function handleClientMetadata(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const baseUrl = getBaseUrl(url);

  const metadata = {
    client_id: `${baseUrl}/.well-known/client-metadata`,
    application_type: 'web',
    client_name: 'Skyreader',
    client_uri: baseUrl,
    redirect_uris: [`${baseUrl}/api/auth/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // The ceiling: sign-in asks for a subset (base + the reader's features).
    scope: clientMetadataScopes(env),
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'ES256',
    jwks: await getClientJWKS(env),
    dpop_bound_access_tokens: true,
  };

  return new Response(JSON.stringify(metadata), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

// Parse a `features` list (comma or space separated). Returns null if any entry
// isn't a known feature, so a typo is a 400 rather than a silently narrower grant.
function parseFeatures(raw: string | null | undefined | string[]): ScopeFeature[] | null {
  const items = Array.isArray(raw) ? raw : (raw ?? '').split(/[\s,]+/);
  const features: ScopeFeature[] = [];
  for (const item of items) {
    if (typeof item !== 'string') return null;
    if (!item) continue;
    if (!isScopeFeature(item)) return null;
    features.push(item);
  }
  return features;
}

// The optional features this account has granted before: the preference recorded
// at its last sign-in, plus whatever its live sessions hold. The second half
// carries readers whose sessions predate progressive scopes (every one of them
// was granted everything) through their first sign-in without losing anything.
async function rememberedFeatures(env: Env, did: string): Promise<Set<ScopeFeature>> {
  const features = new Set<ScopeFeature>();
  const user = await env.DB.prepare('SELECT oauth_features FROM users WHERE did = ?')
    .bind(did)
    .first<{ oauth_features: string | null }>();
  for (const feature of parseFeatures(user?.oauth_features) ?? []) features.add(feature);

  const sessions = await env.DB.prepare(
    'SELECT DISTINCT granted_scopes FROM sessions WHERE did = ? AND granted_scopes IS NOT NULL'
  )
    .bind(did)
    .all<{ granted_scopes: string }>();
  for (const row of sessions.results ?? []) {
    for (const feature of grantedFeatures(row.granted_scopes)) features.add(feature);
  }
  return features;
}

interface AuthorizationParams {
  // Empty in server-first sign-up: the account doesn't exist yet.
  did: string;
  handle: string;
  loginHint?: string;
  pdsUrl: string;
  authMeta: Awaited<ReturnType<typeof fetchAuthServerMetadata>>;
  // Optional features to ask for on top of the base scopes.
  features: Iterable<ScopeFeature>;
  returnUrl: string;
  frontendUrl: string;
  cliPort?: number;
  replaceSessionId?: string;
}

type ParResult = { ok: true; requestUri: string } | { ok: false; errorText: string };

// Start an authorization: PKCE + state, then a PAR (confidential client) or a
// direct authorization URL (localhost public client). Shared by sign-in and by
// permission upgrades, which differ only in the scope they ask for and whether
// the callback retires an existing session.
async function buildAuthorizationUrl(
  env: Env,
  url: URL,
  params: AuthorizationParams
): Promise<string> {
  const {
    did,
    handle,
    loginHint,
    pdsUrl,
    authMeta,
    features,
    returnUrl,
    frontendUrl,
    cliPort,
    replaceSessionId,
  } = params;

  const featureList = [...features];
  let requestedScopes = buildRequestedScopes(env, featureList);

  // Generate PKCE
  const { codeVerifier, codeChallenge } = await generatePKCE();

  // Generate state
  const state = generateRandomString(32);

  const baseUrl = getBaseUrl(url);
  const redirectUri = `${baseUrl}/api/auth/callback`;
  const clientMode = getClientMode(env, url);
  const isPublicClient = clientMode === 'public';

  // For public client (localhost): use AT Protocol's localhost exception
  // For confidential client (production): use metadata URL
  const clientId = isPublicClient
    ? buildLocalhostClientId(redirectUri, clientMetadataScopes(env))
    : `${baseUrl}/.well-known/client-metadata`;

  // Build authorization URL
  let authUrl: string;

  const parEndpoint = authMeta.pushed_authorization_request_endpoint;
  if (parEndpoint && !isPublicClient) {
    // Use PAR (Pushed Authorization Request) - only for confidential clients
    const pushAuthorizationRequest = async (scope: string): Promise<ParResult> => {
      const post = async () =>
        fetch(parEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            ...(loginHint ? { login_hint: loginHint } : {}),
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            // Create client assertion for confidential client authentication
            client_assertion: await createClientAssertion(env, authMeta.issuer, clientId),
          }),
        });

      let response = await post();
      // Retry once for transient invalid_client_metadata errors
      // (auth server intermittently fails to fetch our client metadata)
      if (!response.ok) {
        const errorText = await response.text();
        if (!errorText.includes('invalid_client_metadata')) return { ok: false, errorText };
        console.warn('PAR got invalid_client_metadata, retrying once...');
        await new Promise((r) => setTimeout(r, 1000));
        response = await post();
        if (!response.ok) return { ok: false, errorText: await response.text() };
      }
      const data = (await response.json()) as { request_uri: string };
      return { ok: true, requestUri: data.request_uri };
    };

    let par = await pushAuthorizationRequest(requestedScopes);

    // A PDS answers invalid_scope when it can't resolve an included permission
    // set (the app's lexicon hosting is down, or the set was unpublished) and it
    // has no earlier copy cached. Remembered features are re-requested at every
    // sign-in, so without this one app's outage would lock its users out of
    // Skyreader. The granular form asks for the same access without any set.
    const granularScopes = buildRequestedScopes({ OAUTH_PERMISSION_SETS: 'false' }, featureList);
    if (!par.ok && par.errorText.includes('invalid_scope') && granularScopes !== requestedScopes) {
      console.warn('PAR rejected the permission sets, asking for granular scopes:', par.errorText);
      requestedScopes = granularScopes;
      par = await pushAuthorizationRequest(requestedScopes);
    }

    if (!par.ok) throw new Error(`PAR request failed: ${par.errorText}`);
    authUrl = `${authMeta.authorization_endpoint}?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(par.requestUri)}`;
  } else {
    // Direct authorization request (used for localhost public clients and fallback)
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: requestedScopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(loginHint ? { login_hint: loginHint } : {}),
    });
    authUrl = `${authMeta.authorization_endpoint}?${params}`;
  }

  // Stored once the scope is settled: the callback falls back to it when the
  // token response carries no scope. Handle is updated from the profile there.
  await storeOAuthState(env, state, {
    codeVerifier,
    did,
    handle,
    pdsUrl,
    authServer: authMeta.issuer,
    returnUrl,
    frontendUrl,
    cliPort,
    scope: requestedScopes,
    replaceSessionId,
  });

  return authUrl;
}

export async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const handle = url.searchParams.get('handle');
  // Server-first sign-up: start the OAuth flow against a PDS/entryway host with no
  // account yet. The auth server offers account creation, then redirects back via
  // our redirect_uri (the "link-back"). See docs.bsky.app/blog/account-management.
  const pdsParam = url.searchParams.get('pds');
  const rawReturnUrl = url.searchParams.get('returnUrl') || '/';

  // Validate returnUrl to prevent open redirect attacks
  const returnUrl = isValidReturnUrl(rawReturnUrl, getAllowedOrigins(env)) ? rawReturnUrl : '/';

  // Capture the frontend URL from the request origin for redirect after OAuth
  const frontendUrl = getValidatedFrontendUrl(request, env);

  // CLI mode: capture the local callback port
  const cliPortParam = url.searchParams.get('cli_port');
  const cliPort = cliPortParam ? parseInt(cliPortParam, 10) : undefined;

  const requestedFeatures = parseFeatures(url.searchParams.get('features'));
  if (!requestedFeatures) {
    return new Response(JSON.stringify({ error: 'Unknown feature' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!handle && !pdsParam) {
    return new Response(JSON.stringify({ error: 'Missing handle or pds parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Sign-up mode carries no account identifier; login_hint is the handle otherwise.
  const isSignup = !handle && !!pdsParam;
  const normalizedHandle = handle ? normalizeHandleInput(handle) : '';

  try {
    // In sign-up mode we have no account yet: the DID is learned in the callback,
    // and the PDS host comes straight from the chosen provider.
    let did = '';
    let pdsUrl: string;

    let authMeta;
    if (isSignup) {
      const normalized = normalizePdsHost(pdsParam!);
      if (!normalized) {
        return new Response(JSON.stringify({ error: 'Unsupported sign-up provider' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      pdsUrl = normalized;
      authMeta = await fetchAuthServerMetadata(pdsUrl);
    } else {
      // Resolve handle to DID
      did = await resolveHandle(normalizedHandle);

      // Get PDS URL from DID (may be served from cache)
      let fromCache: boolean;
      ({ pdsUrl, fromCache } = await getPdsFromDid(did, env));

      // Fetch authorization server metadata. If the PDS came from cache and the
      // endpoint no longer accepts us (e.g., user migrated their PDS), evict
      // and re-resolve once.
      try {
        authMeta = await fetchAuthServerMetadata(pdsUrl);
      } catch (err) {
        if (!fromCache) throw err;
        console.warn(
          `Auth metadata failed for cached PDS ${pdsUrl} (DID ${did}); evicting and retrying`,
          err
        );
        await invalidatePdsCache(did, env);
        ({ pdsUrl, fromCache } = await getPdsFromDid(did, env));
        authMeta = await fetchAuthServerMetadata(pdsUrl);
      }
    }

    // Progressive scopes: the base set, plus the optional features the caller
    // asks for and the ones this account already granted (so signing in again on
    // a new device doesn't quietly drop an integration the reader turned on).
    const features = new Set(requestedFeatures);
    if (did) {
      for (const feature of await rememberedFeatures(env, did)) features.add(feature);
    }
    // login_hint pre-fills the account on the auth screen; omitted when signing up.
    const loginHint = isSignup ? undefined : normalizedHandle;

    const authUrl = await buildAuthorizationUrl(env, url, {
      did,
      handle: normalizedHandle,
      loginHint,
      pdsUrl,
      authMeta,
      features,
      returnUrl,
      frontendUrl,
      cliPort,
    });

    return new Response(JSON.stringify({ authUrl }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Login error:', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Login failed',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * POST /api/auth/upgrade — body { features: ScopeFeature[], returnUrl? }.
 *
 * Progressive scopes: asks the reader's PDS for the permissions an optional
 * feature needs, on top of what the current session already holds, without
 * signing them out. Returns { authUrl }; the callback stores the upgraded session
 * and retires this one. `features: []` just re-requests the base permissions
 * (for a session whose base scopes are outdated).
 */
export async function handleAuthUpgrade(request: Request, env: Env): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const sessionId = getSessionIdFromRequest(request);
  const session = await getSessionFromRequest(request, env);
  if (!session || !sessionId) return json({ error: 'Unauthorized' }, 401);

  let body: { features?: unknown; returnUrl?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const requested = parseFeatures(
    Array.isArray(body?.features) ? (body.features as string[]) : undefined
  );
  if (!requested) return json({ error: 'Unknown feature' }, 400);

  const rawReturnUrl = typeof body.returnUrl === 'string' ? body.returnUrl : '/';
  const returnUrl = isValidReturnUrl(rawReturnUrl, getAllowedOrigins(env)) ? rawReturnUrl : '/';

  try {
    // Keep everything this session and account already have; add the new asks.
    const features = new Set<ScopeFeature>([
      ...requested,
      ...grantedFeatures(session.grantedScopes),
      ...(await rememberedFeatures(env, session.did)),
    ]);

    let { pdsUrl, fromCache } = await getPdsFromDid(session.did, env);
    let authMeta;
    try {
      authMeta = await fetchAuthServerMetadata(pdsUrl);
    } catch (err) {
      if (!fromCache) throw err;
      await invalidatePdsCache(session.did, env);
      ({ pdsUrl, fromCache } = await getPdsFromDid(session.did, env));
      authMeta = await fetchAuthServerMetadata(pdsUrl);
    }

    const authUrl = await buildAuthorizationUrl(env, new URL(request.url), {
      did: session.did,
      handle: session.handle,
      // The DID pins the consent screen to this account even if the handle moved.
      loginHint: session.did,
      pdsUrl,
      authMeta,
      features,
      returnUrl,
      frontendUrl: getValidatedFrontendUrl(request, env),
      replaceSessionId: sessionId,
    });
    return json({ authUrl });
  } catch (error) {
    console.error('Scope upgrade error:', error);
    return json({ error: error instanceof Error ? error.message : 'Upgrade failed' }, 500);
  }
}

export async function handleAuthCallback(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    const errorDescription = url.searchParams.get('error_description') || error;
    // The OAuth handshake failed at the auth server. If the user migrated their
    // PDS, our cached endpoint is the most likely culprit — evict so the next
    // login attempt re-resolves the DID fresh.
    if (state) {
      const oauthState = await getOAuthState(env, state).catch(() => null);
      // Declining a permission upgrade isn't a failed sign-in: the reader's
      // session is untouched, so send them back to where they asked from.
      if (oauthState?.replaceSessionId && error === 'access_denied') {
        await deleteOAuthState(env, state).catch(() => {});
        const rawReturnUrl = oauthState.returnUrl || '/';
        const returnUrl = isValidReturnUrl(rawReturnUrl, getAllowedOrigins(env))
          ? rawReturnUrl
          : '/';
        return Response.redirect(`${oauthState.frontendUrl}${returnUrl}`);
      }
      if (oauthState?.did) {
        await invalidatePdsCache(oauthState.did, env);
      }
    }
    return Response.redirect(
      `${env.FRONTEND_URL}/auth/error?error=${encodeURIComponent(errorDescription)}`
    );
  }

  if (!code || !state) {
    return Response.redirect(`${env.FRONTEND_URL}/auth/error?error=Missing+code+or+state`);
  }

  try {
    // Get stored state
    const oauthState = await getOAuthState(env, state);
    if (!oauthState) {
      return Response.redirect(`${env.FRONTEND_URL}/auth/error?error=Invalid+or+expired+state`);
    }

    // Delete state to prevent replay
    await deleteOAuthState(env, state);

    // Server-first sign-up has no DID/handle yet; both are learned from the token
    // response and the freshly created account below.
    const isSignup = !oauthState.did;

    // Fetch auth server metadata again
    const authMeta = await fetchAuthServerMetadata(oauthState.pdsUrl);

    // Generate DPoP key pair
    const keyPair = await generateDPoPKeyPair();
    const privateKeyJwk = await exportPrivateKey(keyPair.privateKey);
    const publicKeyJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;

    const baseUrl = getBaseUrl(url);
    const redirectUri = `${baseUrl}/api/auth/callback`;
    const clientMode = getClientMode(env, url);
    const isPublicClient = clientMode === 'public';

    // For public client (localhost): use AT Protocol's localhost exception
    // For confidential client (production): use metadata URL
    // The localhost client_id embeds the metadata scope, so it must match login's.
    const clientId = isPublicClient
      ? buildLocalhostClientId(redirectUri, clientMetadataScopes(env))
      : `${baseUrl}/.well-known/client-metadata`;

    // Build token request body - only include client assertion for confidential clients
    const tokenRequestBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: oauthState.codeVerifier,
    });

    // Add client assertion for confidential clients (production)
    if (!isPublicClient) {
      const clientAssertion = await createClientAssertion(env, authMeta.issuer, clientId);
      tokenRequestBody.set(
        'client_assertion_type',
        'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
      );
      tokenRequestBody.set('client_assertion', clientAssertion);
    }

    // First attempt - may fail with use_dpop_nonce error
    let dpopProof = await createDPoPProof(
      keyPair.privateKey,
      publicKeyJwk,
      'POST',
      authMeta.token_endpoint
    );

    let tokenResponse = await fetch(authMeta.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: dpopProof,
      },
      body: tokenRequestBody,
    });

    // Handle DPoP nonce requirement
    if (!tokenResponse.ok) {
      const errorData = (await tokenResponse.json().catch(() => null)) as {
        error?: string;
      } | null;
      const dpopNonce = tokenResponse.headers.get('DPoP-Nonce');

      if (errorData?.error === 'use_dpop_nonce' && dpopNonce) {
        // Retry with nonce
        dpopProof = await createDPoPProof(
          keyPair.privateKey,
          publicKeyJwk,
          'POST',
          authMeta.token_endpoint,
          dpopNonce
        );

        const retryBody = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: oauthState.codeVerifier,
        });

        // Add client assertion for confidential clients (production)
        if (!isPublicClient) {
          // Create new client assertion (must not reuse - each assertion needs unique jti)
          const newClientAssertion = await createClientAssertion(env, authMeta.issuer, clientId);
          retryBody.set(
            'client_assertion_type',
            'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
          );
          retryBody.set('client_assertion', newClientAssertion);
        }

        tokenResponse = await fetch(authMeta.token_endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            DPoP: dpopProof,
          },
          body: retryBody,
        });
      }
    }

    // Retry once for transient invalid_client_metadata errors
    // (auth server intermittently fails to fetch our client metadata)
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      let retried = false;

      if (errorText.includes('invalid_client_metadata')) {
        console.warn('Token exchange got invalid_client_metadata, retrying once...');
        // Wait briefly for auth server's metadata fetch to succeed
        await new Promise((r) => setTimeout(r, 1000));

        dpopProof = await createDPoPProof(
          keyPair.privateKey,
          publicKeyJwk,
          'POST',
          authMeta.token_endpoint
        );

        const retryBody = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: oauthState.codeVerifier,
        });

        if (!isPublicClient) {
          const retryAssertion = await createClientAssertion(env, authMeta.issuer, clientId);
          retryBody.set(
            'client_assertion_type',
            'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
          );
          retryBody.set('client_assertion', retryAssertion);
        }

        tokenResponse = await fetch(authMeta.token_endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            DPoP: dpopProof,
          },
          body: retryBody,
        });
        retried = true;
      }

      if (!tokenResponse.ok) {
        const finalErrorText = retried ? await tokenResponse.text() : errorText;
        console.error('Token exchange failed:', finalErrorText);
        // Token exchange against the cached PDS failed — could be a stale
        // cache after a PDS migration. Evict so the next attempt re-resolves.
        if (oauthState.did) await invalidatePdsCache(oauthState.did, env);
        return Response.redirect(
          `${oauthState.frontendUrl}/auth/error?error=Token+exchange+failed`
        );
      }
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      sub: string;
      scope?: string;
    };

    // In sign-up mode the account is whatever the user just created, so the token
    // `sub` IS the DID. In login mode it must match the DID we resolved up front.
    let did = oauthState.did;
    let pdsUrl = oauthState.pdsUrl;
    if (isSignup) {
      did = tokenData.sub;
      // The chosen host may be an entryway (e.g. bsky.social); resolve the new
      // account's actual PDS so authenticated calls hit the right resource server.
      pdsUrl = (await getPdsFromDid(did, env)).pdsUrl;
    } else if (tokenData.sub !== oauthState.did) {
      console.error('DID mismatch:', tokenData.sub, oauthState.did);
      return Response.redirect(
        `${oauthState.frontendUrl}/auth/error?error=DID+verification+failed`
      );
    }

    let displayName: string | undefined;
    let avatarUrl: string | undefined;
    let handle = oauthState.handle;

    // A brand-new account may not be indexed by the AppView yet, so take the
    // canonical handle straight from its PDS first.
    if (isSignup) {
      try {
        const descRes = await fetch(
          `${pdsUrl}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`
        );
        if (descRes.ok) {
          handle = ((await descRes.json()) as { handle?: string }).handle || handle;
        }
      } catch (err) {
        console.warn('describeRepo handle lookup failed during sign-up:', err);
      }
    }

    // Fetch user profile from public API (no auth needed for public profile data)
    const profileUrl = `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${did}`;
    const profileResponse = await fetch(profileUrl);

    if (profileResponse.ok) {
      const profile = (await profileResponse.json()) as {
        handle: string;
        displayName?: string;
        avatar?: string;
      };
      if (profile.handle) handle = profile.handle;
      displayName = profile.displayName;
      avatarUrl = profile.avatar;
    } else if (!isSignup) {
      console.error(
        'Profile fetch failed:',
        profileResponse.status,
        await profileResponse.text().catch(() => 'no body')
      );
    }

    // Create session
    // Use scope from token response if provided, otherwise use what we requested.
    // The response carries permission sets already expanded to granular scopes.
    const grantedScopes = tokenData.scope || oauthState.scope || clientMetadataScopes(env);

    const sessionId = generateRandomString(32);
    const session: Session = {
      did,
      handle,
      displayName,
      avatarUrl,
      pdsUrl,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      dpopPrivateKey: JSON.stringify(privateKeyJwk),
      expiresAt: Date.now() + tokenData.expires_in * 1000,
      grantedScopes,
    };

    // Check if user has logged in before (registered_at is NULL for users added via Jetstream/follow sync)
    const existingUser = await env.DB.prepare('SELECT did, registered_at FROM users WHERE did = ?')
      .bind(did)
      .first<{ did: string; registered_at: number | null }>();

    // Check user cap for new users
    const isNewUser = !existingUser || !existingUser.registered_at;
    if (isNewUser) {
      const userCountResult = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM users WHERE registered_at IS NOT NULL`
      ).first<{ count: number }>();

      if ((userCountResult?.count || 0) >= MAX_USERS) {
        console.log(`User cap reached, rejecting new user: ${handle || did}`);
        return Response.redirect(`${oauthState.frontendUrl}/auth/error?error=user_cap_reached`);
      }
    }

    // Store/update user in D1 BEFORE storing session (sessions table has FK to users)
    await env.DB.prepare(
      `
      INSERT INTO users (did, handle, display_name, avatar_url, pds_url, updated_at, registered_at, oauth_features)
      VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch(), ?)
      ON CONFLICT(did) DO UPDATE SET
        handle = excluded.handle,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        pds_url = excluded.pds_url,
        updated_at = unixepoch(),
        registered_at = COALESCE(users.registered_at, unixepoch()),
        oauth_features = excluded.oauth_features
    `
    )
      .bind(
        did,
        handle,
        displayName || null,
        avatarUrl || null,
        pdsUrl,
        // What the reader actually granted (they can untick scopes on the consent
        // screen), so the next sign-in asks for the same set.
        grantedFeatures(grantedScopes).join(' ')
      )
      .run();

    // Now store session (after user exists in DB due to FK constraint)
    await storeSession(env, sessionId, session);

    // A permission upgrade replaces the session it started from. Only ever retire
    // a session of the same account, so a mismatched callback can't sign anyone out.
    if (oauthState.replaceSessionId && oauthState.replaceSessionId !== sessionId) {
      const previous = await getSession(env, oauthState.replaceSessionId);
      if (previous?.did === did) {
        await deleteSession(env, oauthState.replaceSessionId);
      }
    }

    // Write the AT Intents discovery footprint into the user's repo (best-effort,
    // skipped if the usage scope wasn't granted). Never block the login redirect on it.
    ctx.waitUntil(writeUsageRecord(session));

    // Build the session cookie to set during redirect
    const cookieDomain = getCookieDomain(env, request);
    const isSecure = isSecureContext(request);

    const cookieHeader = buildSetCookieHeader(SESSION_COOKIE_NAME, sessionId, {
      maxAge: SESSION_COOKIE_MAX_AGE,
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
      domain: cookieDomain,
      path: '/',
    });

    // CLI mode: redirect to local CLI server instead of frontend
    if (oauthState.cliPort) {
      const cliRedirectUrl = `http://127.0.0.1:${oauthState.cliPort}/callback?session_id=${encodeURIComponent(sessionId)}`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: cliRedirectUrl,
        },
      });
    }

    // Redirect to frontend with cookie set (no exchange code needed)
    // Validate returnUrl again in case stored state was tampered with
    const rawReturnUrl = oauthState.returnUrl || '/';
    const returnUrl = isValidReturnUrl(rawReturnUrl, getAllowedOrigins(env)) ? rawReturnUrl : '/';
    const redirectUrl = `${oauthState.frontendUrl}/auth/callback?returnUrl=${encodeURIComponent(returnUrl)}`;

    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl,
        'Set-Cookie': cookieHeader,
      },
    });
  } catch (error) {
    console.error('Callback error:', error);
    return Response.redirect(
      `${env.FRONTEND_URL}/auth/error?error=${encodeURIComponent(error instanceof Error ? error.message : 'Authentication failed')}`
    );
  }
}

export async function handleAuthMe(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);

  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // tierSource/grantedTier let the client tell a paid plan from a hand-granted
  // one: only a paid supporter has a Polar customer to send to the billing
  // portal, and only a granted one is told their access is a keep-it thank-you.
  const { tier, tierSource, grantedTier } = await getUserTierInfo(env, session.did);
  const limits = getLimitsForTier(tier);

  return new Response(
    JSON.stringify({
      did: session.did,
      handle: session.handle,
      displayName: session.displayName,
      avatarUrl: session.avatarUrl,
      pdsUrl: session.pdsUrl,
      tier,
      tierSource,
      grantedTier,
      limits,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

export async function handleAuthLogout(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get session ID from cookie or Authorization header
  const cookieHeader = request.headers.get('Cookie');
  const cookies = parseCookies(cookieHeader);
  let sessionId = cookies.get(SESSION_COOKIE_NAME);

  // Fall back to Authorization header
  if (!sessionId) {
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      sessionId = authHeader.substring(7);
    }
  }

  // Build response headers (always clear cookie on logout)
  const cookieDomain = getCookieDomain(env, request);
  const clearCookieHeader = buildClearCookieHeader(SESSION_COOKIE_NAME, cookieDomain);
  const responseHeaders: HeadersInit = {
    'Content-Type': 'application/json',
    'Set-Cookie': clearCookieHeader,
  };

  if (!sessionId) {
    return new Response(JSON.stringify({ success: true }), {
      headers: responseHeaders,
    });
  }

  const session = await getSession(env, sessionId);

  if (session) {
    // Try to revoke tokens (best effort)
    try {
      const authMeta = await fetchAuthServerMetadata(session.pdsUrl);
      if (authMeta.revocation_endpoint) {
        const privateKeyJwk = JSON.parse(session.dpopPrivateKey);
        const privateKey = await importPrivateKey(privateKeyJwk);
        const publicKeyJwk = { ...privateKeyJwk };
        delete publicKeyJwk.d;

        // Get client ID
        const url = new URL(request.url);
        const baseUrl = getBaseUrl(url);
        const clientMode = getClientMode(env, url);
        const isPublicClient = clientMode === 'public';
        const redirectUri = `${baseUrl}/api/auth/callback`;

        // For public client (localhost): use AT Protocol's localhost exception
        // For confidential client (production): use metadata URL
        // The localhost client_id embeds the metadata scope, same as at sign-in.
        const clientId = isPublicClient
          ? buildLocalhostClientId(redirectUri, clientMetadataScopes(env))
          : `${baseUrl}/.well-known/client-metadata`;

        let dpopProof = await createDPoPProof(
          privateKey,
          publicKeyJwk,
          'POST',
          authMeta.revocation_endpoint,
          undefined,
          session.accessToken
        );

        // Build revoke request body
        const revokeBody = new URLSearchParams({
          token: session.refreshToken,
          client_id: clientId,
        });

        // Add client assertion for confidential clients (production)
        if (!isPublicClient) {
          const clientAssertion = await createClientAssertion(env, authMeta.issuer, clientId);
          revokeBody.set(
            'client_assertion_type',
            'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
          );
          revokeBody.set('client_assertion', clientAssertion);
        }

        let revokeResponse = await fetch(authMeta.revocation_endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            DPoP: dpopProof,
          },
          body: revokeBody,
        });

        // Handle DPoP nonce requirement
        if (!revokeResponse.ok && revokeResponse.status === 401) {
          const revokeErrorData = (await revokeResponse.json().catch(() => null)) as {
            error?: string;
          } | null;
          const revokeDpopNonce = revokeResponse.headers.get('DPoP-Nonce');

          if (revokeErrorData?.error === 'use_dpop_nonce' && revokeDpopNonce) {
            dpopProof = await createDPoPProof(
              privateKey,
              publicKeyJwk,
              'POST',
              authMeta.revocation_endpoint,
              revokeDpopNonce,
              session.accessToken
            );

            const retryRevokeBody = new URLSearchParams({
              token: session.refreshToken,
              client_id: clientId,
            });

            // Add client assertion for confidential clients (production)
            if (!isPublicClient) {
              const newClientAssertion = await createClientAssertion(
                env,
                authMeta.issuer,
                clientId
              );
              retryRevokeBody.set(
                'client_assertion_type',
                'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
              );
              retryRevokeBody.set('client_assertion', newClientAssertion);
            }

            revokeResponse = await fetch(authMeta.revocation_endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                DPoP: dpopProof,
              },
              body: retryRevokeBody,
            });
          }
        }
      }
    } catch (error) {
      console.error('Token revocation error:', error);
    }

    await deleteSession(env, sessionId);
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: responseHeaders,
  });
}
