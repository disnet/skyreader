import type { Env, Session } from '../types';
import {
  generateRandomString,
  generatePKCE,
  generateDPoPKeyPair,
  exportPrivateKey,
  importPrivateKey,
  createDPoPProof,
  resolveHandle,
  getPdsFromDid,
  fetchAuthServerMetadata,
  storeOAuthState,
  getOAuthState,
  deleteOAuthState,
  storeSession,
  getSession,
  deleteSession,
} from '../services/oauth';
import { syncFollowsForUser } from './social';
import { syncReadPositionsForUser } from '../services/pds-sync';

// Transitional scope - provides broad PDS permissions
// TODO: Switch to granular scopes when AT Protocol "permission sets" feature
// supports custom third-party lexicons (see atproto discussion #4118)
const OAUTH_SCOPES = 'atproto transition:generic';

// RFC 8252 requires loopback IP instead of localhost for OAuth
function getBaseUrl(url: URL): string {
  let host = url.host;
  // Replace localhost with 127.0.0.1 for OAuth compliance
  if (host.startsWith('localhost')) {
    host = host.replace('localhost', '127.0.0.1');
  }
  return `${url.protocol}//${host}`;
}

export function handleClientMetadata(request: Request, env: Env): Response {
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
    scope: OAUTH_SCOPES,
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
  };

  return new Response(JSON.stringify(metadata), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const handle = url.searchParams.get('handle');
  const returnUrl = url.searchParams.get('returnUrl') || '/';

  if (!handle) {
    return new Response(JSON.stringify({ error: 'Missing handle parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Resolve handle to DID (resolveHandle handles normalization)
    const did = await resolveHandle(handle);

    // Get PDS URL from DID
    const pdsUrl = await getPdsFromDid(did);

    // Fetch authorization server metadata
    const authMeta = await fetchAuthServerMetadata(pdsUrl);

    // Generate PKCE
    const { codeVerifier, codeChallenge } = await generatePKCE();

    // Generate state
    const state = generateRandomString(32);

    // Store state in KV (handle will be updated from profile in callback)
    await storeOAuthState(env, state, {
      codeVerifier,
      did,
      handle,
      pdsUrl,
      authServer: authMeta.issuer,
      returnUrl,
    });

    const baseUrl = getBaseUrl(url);
    const clientId = `${baseUrl}/.well-known/client-metadata`;
    const redirectUri = `${baseUrl}/api/auth/callback`;

    // Build authorization URL
    let authUrl: string;

    if (authMeta.pushed_authorization_request_endpoint) {
      // Use PAR (Pushed Authorization Request)
      const parResponse = await fetch(authMeta.pushed_authorization_request_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: OAUTH_SCOPES,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          login_hint: handle,
        }),
      });

      if (!parResponse.ok) {
        const error = await parResponse.text();
        throw new Error(`PAR request failed: ${error}`);
      }

      const parData = await parResponse.json() as { request_uri: string };
      authUrl = `${authMeta.authorization_endpoint}?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(parData.request_uri)}`;
    } else {
      // Direct authorization request
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: OAUTH_SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        login_hint: handle,
      });
      authUrl = `${authMeta.authorization_endpoint}?${params}`;
    }

    return new Response(JSON.stringify({ authUrl }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Login error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Login failed' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export async function handleAuthCallback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    const errorDescription = url.searchParams.get('error_description') || error;
    return Response.redirect(`${env.FRONTEND_URL}/auth/error?error=${encodeURIComponent(errorDescription)}`);
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
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as JsonWebKey;

    const baseUrl = getBaseUrl(url);
    const clientId = `${baseUrl}/.well-known/client-metadata`;
    const redirectUri = `${baseUrl}/api/auth/callback`;

    const tokenRequestBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: oauthState.codeVerifier,
    });

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
      const errorData = await tokenResponse.json().catch(() => null) as { error?: string } | null;
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

        tokenResponse = await fetch(authMeta.token_endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            DPoP: dpopProof,
          },
          body: tokenRequestBody,
        });
      }
    }

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token exchange failed:', errorText);
      return Response.redirect(`${env.FRONTEND_URL}/auth/error?error=Token+exchange+failed`);
    }

    const tokenData = await tokenResponse.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      sub: string;
    };

    // Verify sub matches our expected DID
    if (tokenData.sub !== oauthState.did) {
      console.error('DID mismatch:', tokenData.sub, oauthState.did);
      return Response.redirect(`${env.FRONTEND_URL}/auth/error?error=DID+verification+failed`);
    }

    // Fetch user profile
    const profileUrl = `${oauthState.pdsUrl}/xrpc/app.bsky.actor.getProfile?actor=${oauthState.did}`;
    let profileDpop = await createDPoPProof(
      keyPair.privateKey,
      publicKeyJwk,
      'GET',
      profileUrl,
      undefined,
      tokenData.access_token
    );

    let profileResponse = await fetch(profileUrl, {
      headers: {
        Authorization: `DPoP ${tokenData.access_token}`,
        DPoP: profileDpop,
      },
    });

    // Handle DPoP nonce requirement for profile fetch
    if (!profileResponse.ok && profileResponse.status === 401) {
      const profileErrorData = await profileResponse.json().catch(() => null) as { error?: string } | null;
      const profileDpopNonce = profileResponse.headers.get('DPoP-Nonce');

      if (profileErrorData?.error === 'use_dpop_nonce' && profileDpopNonce) {
        profileDpop = await createDPoPProof(
          keyPair.privateKey,
          publicKeyJwk,
          'GET',
          profileUrl,
          profileDpopNonce,
          tokenData.access_token
        );

        profileResponse = await fetch(profileUrl, {
          headers: {
            Authorization: `DPoP ${tokenData.access_token}`,
            DPoP: profileDpop,
          },
        });
      }
    }

    let displayName: string | undefined;
    let avatarUrl: string | undefined;
    let handle = oauthState.handle;

    if (profileResponse.ok) {
      const profile = await profileResponse.json() as {
        handle: string;
        displayName?: string;
        avatar?: string;
      };
      handle = profile.handle;
      displayName = profile.displayName;
      avatarUrl = profile.avatar;
    }

    // Create session
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
    };

    // Check if user has logged in before (pds_url is empty for users added via follow sync)
    const existingUser = await env.DB.prepare(
      'SELECT did, pds_url FROM users WHERE did = ?'
    ).bind(oauthState.did).first<{ did: string; pds_url: string }>();

    // Store/update user in D1 BEFORE storing session (sessions table has FK to users)
    await env.DB.prepare(`
      INSERT INTO users (did, handle, display_name, avatar_url, pds_url, updated_at)
      VALUES (?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(did) DO UPDATE SET
        handle = excluded.handle,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        pds_url = excluded.pds_url,
        updated_at = unixepoch()
    `).bind(oauthState.did, handle, displayName || null, avatarUrl || null, oauthState.pdsUrl).run();

    // Now store session (after user exists in DB due to FK constraint)
    await storeSession(env, sessionId, session);

    // For new users: sync their existing follows from PDS
    // Also sync if user exists but never logged in (added via someone else's follow sync)
    if (!existingUser || !existingUser.pds_url) {
      console.log(`First login for ${handle}, syncing follows...`);

      ctx.waitUntil(
        syncFollowsForUser(env, session)
          .then(syncedCount => console.log(`Synced ${syncedCount} follows for ${handle}`))
          .catch(syncError => console.error('Failed to sync follows on first login:', syncError))
      );
    }

    // Sync unsynced read positions to PDS on each login
    ctx.waitUntil(
      syncReadPositionsForUser(env, session)
        .then(result => {
          if (result.synced > 0) {
            console.log(`Synced ${result.synced} read positions to PDS for ${handle}`);
          }
        })
        .catch(syncError => console.error('Failed to sync read positions on login:', syncError))
    );

    // Redirect to frontend with session
    const returnUrl = oauthState.returnUrl || '/';
    return Response.redirect(
      `${env.FRONTEND_URL}/auth/callback?sessionId=${sessionId}&returnUrl=${encodeURIComponent(returnUrl)}`
    );
  } catch (error) {
    console.error('Callback error:', error);
    return Response.redirect(
      `${env.FRONTEND_URL}/auth/error?error=${encodeURIComponent(error instanceof Error ? error.message : 'Authentication failed')}`
    );
  }
}

export async function handleAuthMe(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sessionId = authHeader.substring(7);
  const session = await getSession(env, sessionId);

  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    did: session.did,
    handle: session.handle,
    displayName: session.displayName,
    avatarUrl: session.avatarUrl,
    pdsUrl: session.pdsUrl,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleAuthLogout(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sessionId = authHeader.substring(7);
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

        let dpopProof = await createDPoPProof(
          privateKey,
          publicKeyJwk,
          'POST',
          authMeta.revocation_endpoint,
          undefined,
          session.accessToken
        );

        let revokeResponse = await fetch(authMeta.revocation_endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            DPoP: dpopProof,
          },
          body: new URLSearchParams({
            token: session.refreshToken,
          }),
        });

        // Handle DPoP nonce requirement
        if (!revokeResponse.ok && revokeResponse.status === 401) {
          const revokeErrorData = await revokeResponse.json().catch(() => null) as { error?: string } | null;
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

            revokeResponse = await fetch(authMeta.revocation_endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                DPoP: dpopProof,
              },
              body: new URLSearchParams({
                token: session.refreshToken,
              }),
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
    headers: { 'Content-Type': 'application/json' },
  });
}
