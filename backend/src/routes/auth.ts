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
} from '../services/oauth';
import { getClientJWKS, createClientAssertion } from '../services/client-auth';
import { getUserTier } from '../services/user-tier';
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
const MAX_USERS = 650;

// Granular scopes for Skyreader's custom lexicons
// Requests write access only to app.skyreader.* record collections
export const GRANULAR_SCOPES = [
  'atproto',
  'repo:app.skyreader.feed.subscription',
  'repo:app.skyreader.social.follow',
  'repo:app.skyreader.feed.saved',
].join(' ');

// Integration-specific scopes (written to external app lexicons on user's PDS)
export const SEMBLE_SCOPES = [
  'repo:network.cosmik.card',
  'repo:network.cosmik.collection',
  'repo:network.cosmik.collectionLink',
];
export const MARGIN_SCOPES = [
  'repo:at.margin.bookmark',
  'repo:at.margin.collection',
  'repo:at.margin.collectionItem',
];

// Linkblog scopes — sharing writes standard.site records to the user's PDS.
export const LINKBLOG_SCOPES = ['repo:site.standard.publication', 'repo:site.standard.document'];

// All possible scopes (base + all integrations) — used in client metadata
export const ALL_POSSIBLE_SCOPES = [
  GRANULAR_SCOPES,
  ...SEMBLE_SCOPES,
  ...MARGIN_SCOPES,
  ...LINKBLOG_SCOPES,
].join(' ');

// Check if granted scopes satisfy the required scopes
export function hasRequiredScopes(
  grantedScopes: string | undefined,
  additionalScopes?: string[]
): boolean {
  if (!grantedScopes) {
    // Session without scope tracking - require re-auth
    return false;
  }

  const granted = new Set(grantedScopes.split(' '));

  // Check if all required granular scopes are present
  const required = GRANULAR_SCOPES.split(' ');
  if (additionalScopes) {
    required.push(...additionalScopes);
  }
  return required.every((scope) => granted.has(scope));
}

// Create a 403 response for insufficient scopes
export function insufficientScopesResponse(): Response {
  return new Response(
    JSON.stringify({
      error: 'scope_upgrade_required',
      message: 'Your session was created with outdated permissions. Please log in again.',
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

// Build client_id for localhost development using AT Protocol's localhost exception
// See: https://atproto.com/specs/oauth#localhost-client-development
function buildLocalhostClientId(redirectUri: string, scope: string): string {
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    scope: scope,
  });
  return `http://localhost?${params.toString()}`;
}

// Validate returnUrl to prevent open redirect attacks
function isValidReturnUrl(url: string): boolean {
  // Must start with / (relative path)
  if (!url.startsWith('/')) return false;
  // Must not contain // (prevents protocol-relative URLs like //evil.com)
  if (url.includes('//')) return false;
  // Must not contain backslash (prevents backslash tricks like /\evil.com)
  if (url.includes('\\')) return false;
  return true;
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
    scope: ALL_POSSIBLE_SCOPES,
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

export async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const handle = url.searchParams.get('handle');
  const rawReturnUrl = url.searchParams.get('returnUrl') || '/';

  // Validate returnUrl to prevent open redirect attacks
  const returnUrl = isValidReturnUrl(rawReturnUrl) ? rawReturnUrl : '/';

  // Capture the frontend URL from the request origin for redirect after OAuth
  const frontendUrl = getValidatedFrontendUrl(request, env);

  // CLI mode: capture the local callback port
  const cliPortParam = url.searchParams.get('cli_port');
  const cliPort = cliPortParam ? parseInt(cliPortParam, 10) : undefined;

  if (!handle) {
    return new Response(JSON.stringify({ error: 'Missing handle parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Normalize handle (strip @, lowercase, add .bsky.social if needed)
  const normalizedHandle = normalizeHandleInput(handle);

  try {
    // Resolve handle to DID
    const did = await resolveHandle(normalizedHandle);

    // Get PDS URL from DID (may be served from cache)
    let { pdsUrl, fromCache } = await getPdsFromDid(did, env);

    // Always request all scopes (base + integrations)
    const requestedScopes = ALL_POSSIBLE_SCOPES;

    // Fetch authorization server metadata. If the PDS came from cache and the
    // endpoint no longer accepts us (e.g., user migrated their PDS), evict
    // and re-resolve once.
    let authMeta;
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

    // Generate PKCE
    const { codeVerifier, codeChallenge } = await generatePKCE();

    // Generate state
    const state = generateRandomString(32);

    // Store state in KV (handle will be updated from profile in callback)
    await storeOAuthState(env, state, {
      codeVerifier,
      did,
      handle: normalizedHandle,
      pdsUrl,
      authServer: authMeta.issuer,
      returnUrl,
      frontendUrl,
      cliPort,
    });

    const baseUrl = getBaseUrl(url);
    const redirectUri = `${baseUrl}/api/auth/callback`;
    const clientMode = getClientMode(env, url);
    const isPublicClient = clientMode === 'public';

    // For public client (localhost): use AT Protocol's localhost exception
    // For confidential client (production): use metadata URL
    const clientId = isPublicClient
      ? buildLocalhostClientId(redirectUri, requestedScopes)
      : `${baseUrl}/.well-known/client-metadata`;

    // Build authorization URL
    let authUrl: string;

    if (authMeta.pushed_authorization_request_endpoint && !isPublicClient) {
      // Use PAR (Pushed Authorization Request) - only for confidential clients
      // Create client assertion for confidential client authentication
      const clientAssertion = await createClientAssertion(env, authMeta.issuer, clientId);

      const parResponse = await fetch(authMeta.pushed_authorization_request_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: requestedScopes,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          login_hint: normalizedHandle,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: clientAssertion,
        }),
      });

      // Retry once for transient invalid_client_metadata errors
      // (auth server intermittently fails to fetch our client metadata)
      if (!parResponse.ok) {
        const errorText = await parResponse.text();

        if (errorText.includes('invalid_client_metadata')) {
          console.warn('PAR got invalid_client_metadata, retrying once...');
          await new Promise((r) => setTimeout(r, 1000));

          const retryAssertion = await createClientAssertion(env, authMeta.issuer, clientId);
          const retryParResponse = await fetch(authMeta.pushed_authorization_request_endpoint!, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: clientId,
              redirect_uri: redirectUri,
              response_type: 'code',
              scope: requestedScopes,
              state,
              code_challenge: codeChallenge,
              code_challenge_method: 'S256',
              login_hint: normalizedHandle,
              client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
              client_assertion: retryAssertion,
            }),
          });

          if (!retryParResponse.ok) {
            const retryError = await retryParResponse.text();
            throw new Error(`PAR request failed: ${retryError}`);
          }

          const retryParData = (await retryParResponse.json()) as {
            request_uri: string;
          };
          authUrl = `${authMeta.authorization_endpoint}?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(retryParData.request_uri)}`;
        } else {
          throw new Error(`PAR request failed: ${errorText}`);
        }
      } else {
        const parData = (await parResponse.json()) as { request_uri: string };
        authUrl = `${authMeta.authorization_endpoint}?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(parData.request_uri)}`;
      }
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
        login_hint: normalizedHandle,
      });
      authUrl = `${authMeta.authorization_endpoint}?${params}`;
    }

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
    // Use the same scopes that were requested during login so the client_id matches
    const callbackScopes = ALL_POSSIBLE_SCOPES;
    const clientId = isPublicClient
      ? buildLocalhostClientId(redirectUri, callbackScopes)
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
        await invalidatePdsCache(oauthState.did, env);
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

    // Verify sub matches our expected DID
    if (tokenData.sub !== oauthState.did) {
      console.error('DID mismatch:', tokenData.sub, oauthState.did);
      return Response.redirect(
        `${oauthState.frontendUrl}/auth/error?error=DID+verification+failed`
      );
    }

    // Fetch user profile from public API (no auth needed for public profile data)
    const profileUrl = `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${oauthState.did}`;
    const profileResponse = await fetch(profileUrl);

    let displayName: string | undefined;
    let avatarUrl: string | undefined;
    let handle = oauthState.handle;

    if (profileResponse.ok) {
      const profile = (await profileResponse.json()) as {
        handle: string;
        displayName?: string;
        avatar?: string;
      };
      handle = profile.handle;
      displayName = profile.displayName;
      avatarUrl = profile.avatar;
    } else {
      console.error(
        'Profile fetch failed:',
        profileResponse.status,
        await profileResponse.text().catch(() => 'no body')
      );
    }

    // Create session
    // Use scope from token response if provided, otherwise use what we requested
    const grantedScopes = tokenData.scope || callbackScopes;

    const sessionId = generateRandomString(32);
    const session: Session = {
      did: oauthState.did,
      handle,
      displayName,
      avatarUrl,
      pdsUrl: oauthState.pdsUrl,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      dpopPrivateKey: JSON.stringify(privateKeyJwk),
      expiresAt: Date.now() + tokenData.expires_in * 1000,
      grantedScopes,
    };

    // Check if user has logged in before (registered_at is NULL for users added via Jetstream/follow sync)
    const existingUser = await env.DB.prepare('SELECT did, registered_at FROM users WHERE did = ?')
      .bind(oauthState.did)
      .first<{ did: string; registered_at: number | null }>();

    // Check user cap for new users
    const isNewUser = !existingUser || !existingUser.registered_at;
    if (isNewUser) {
      const userCountResult = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM users WHERE registered_at IS NOT NULL`
      ).first<{ count: number }>();

      if ((userCountResult?.count || 0) >= MAX_USERS) {
        console.log(`User cap reached, rejecting new user: ${oauthState.handle}`);
        return Response.redirect(`${oauthState.frontendUrl}/auth/error?error=user_cap_reached`);
      }
    }

    // Store/update user in D1 BEFORE storing session (sessions table has FK to users)
    await env.DB.prepare(
      `
      INSERT INTO users (did, handle, display_name, avatar_url, pds_url, updated_at, registered_at)
      VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
      ON CONFLICT(did) DO UPDATE SET
        handle = excluded.handle,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        pds_url = excluded.pds_url,
        updated_at = unixepoch(),
        registered_at = COALESCE(users.registered_at, unixepoch())
    `
    )
      .bind(oauthState.did, handle, displayName || null, avatarUrl || null, oauthState.pdsUrl)
      .run();

    // Now store session (after user exists in DB due to FK constraint)
    await storeSession(env, sessionId, session);

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
    const returnUrl = isValidReturnUrl(rawReturnUrl) ? rawReturnUrl : '/';
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

  const tier = await getUserTier(env, session.did);
  const limits = getLimitsForTier(tier);

  return new Response(
    JSON.stringify({
      did: session.did,
      handle: session.handle,
      displayName: session.displayName,
      avatarUrl: session.avatarUrl,
      pdsUrl: session.pdsUrl,
      tier,
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
        // Use the session's granted scopes so the client_id matches what was used during auth
        const logoutScopes = session.grantedScopes || GRANULAR_SCOPES;
        const clientId = isPublicClient
          ? buildLocalhostClientId(redirectUri, logoutScopes)
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
