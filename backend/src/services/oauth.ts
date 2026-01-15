import type { Env, OAuthState, Session } from '../types';

// Constants for refresh retry logic
const MAX_REFRESH_FAILURES = 5;
const BASE_BACKOFF_MS = 60 * 1000;      // 1 minute base
const MAX_BACKOFF_MS = 60 * 60 * 1000;  // 1 hour max

// Error codes that indicate permanent failure (refresh token is invalid)
const PERMANENT_REFRESH_ERRORS = [
  'invalid_grant',           // Refresh token expired or revoked
  'invalid_client',          // Client credentials invalid
  'unauthorized_client',     // Client not authorized for this grant type
  'invalid_token',           // Token is malformed or revoked
];

function isPermanentError(error: string | undefined): boolean {
  return error !== undefined && PERMANENT_REFRESH_ERRORS.includes(error);
}

function isTransientError(error: string | undefined, statusCode?: number): boolean {
  if (!error && statusCode) {
    // 5xx errors and rate limiting are transient
    return statusCode >= 500 || statusCode === 429;
  }
  // Network errors (no error code) are transient
  if (!error) return true;
  // Explicit transient errors
  if (['temporarily_unavailable', 'server_error'].includes(error)) return true;
  // Not a known permanent error = treat as transient for safety
  return !isPermanentError(error);
}

function calculateBackoffMs(failures: number): number {
  // Exponential backoff: 1min, 2min, 4min, 8min, 16min... capped at 1 hour
  const backoff = Math.min(
    BASE_BACKOFF_MS * Math.pow(2, failures - 1),
    MAX_BACKOFF_MS
  );
  // Add jitter (0-10% of backoff)
  const jitter = backoff * Math.random() * 0.1;
  return backoff + jitter;
}

// Extended session type with refresh state (internal use)
interface SessionWithRefreshState extends Session {
  refreshFailures: number;
  lastRefreshAttempt?: number;
  lastRefreshError?: string;
  refreshLockedUntil?: number;
}

// Generate a cryptographically random string
export function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Generate PKCE code verifier and challenge
export async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = generateRandomString(32);
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return { codeVerifier, codeChallenge };
}

// Generate DPoP key pair
export async function generateDPoPKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair;
}

// Export private key to JWK
export async function exportPrivateKey(key: CryptoKey): Promise<JsonWebKey> {
  return await crypto.subtle.exportKey('jwk', key) as JsonWebKey;
}

// Import private key from JWK
export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );
}

// Create DPoP proof
export async function createDPoPProof(
  privateKey: CryptoKey,
  publicKeyJwk: JsonWebKey,
  method: string,
  url: string,
  nonce?: string,
  accessToken?: string
): Promise<string> {
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: {
      kty: publicKeyJwk.kty,
      crv: publicKeyJwk.crv,
      x: publicKeyJwk.x,
      y: publicKeyJwk.y,
    },
  };

  const payload: Record<string, unknown> = {
    jti: generateRandomString(16),
    htm: method,
    htu: url,
    iat: Math.floor(Date.now() / 1000),
  };

  if (nonce) {
    payload.nonce = nonce;
  }

  if (accessToken) {
    const encoder = new TextEncoder();
    const data = encoder.encode(accessToken);
    const hash = await crypto.subtle.digest('SHA-256', data);
    payload.ath = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  const encodedHeader = btoa(JSON.stringify(header))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  const encodedPayload = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoder.encode(signingInput)
  );

  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${signingInput}.${encodedSignature}`;
}

// Resolve handle to DID
export async function resolveHandle(handle: string): Promise<string> {
  // Try DNS TXT record first
  const dnsUrl = `https://dns.google/resolve?name=_atproto.${handle}&type=TXT`;
  try {
    const dnsResponse = await fetch(dnsUrl);
    const dnsData = await dnsResponse.json() as { Answer?: { data: string }[] };
    if (dnsData.Answer && dnsData.Answer.length > 0) {
      const txtRecord = dnsData.Answer[0].data.replace(/"/g, '');
      if (txtRecord.startsWith('did=')) {
        return txtRecord.substring(4);
      }
    }
  } catch {
    // DNS lookup failed, try HTTP fallback
  }

  // HTTP fallback via well-known
  const httpUrl = `https://${handle}/.well-known/atproto-did`;
  const httpResponse = await fetch(httpUrl);
  if (httpResponse.ok) {
    const did = await httpResponse.text();
    return did.trim();
  }

  throw new Error(`Could not resolve handle: ${handle}`);
}

// Get PDS URL from DID
export async function getPdsFromDid(did: string): Promise<string> {
  let didDoc: Record<string, unknown>;

  if (did.startsWith('did:plc:')) {
    const response = await fetch(`https://plc.directory/${did}`);
    if (!response.ok) {
      throw new Error(`Could not resolve DID: ${did}`);
    }
    didDoc = await response.json() as Record<string, unknown>;
  } else if (did.startsWith('did:web:')) {
    const domain = did.substring(8).replace(/:/g, '/');
    const response = await fetch(`https://${domain}/.well-known/did.json`);
    if (!response.ok) {
      throw new Error(`Could not resolve DID: ${did}`);
    }
    didDoc = await response.json() as Record<string, unknown>;
  } else {
    throw new Error(`Unsupported DID method: ${did}`);
  }

  // Find PDS service in DID document
  const services = didDoc.service as { id: string; type: string; serviceEndpoint: string }[] | undefined;
  if (services) {
    const pdsService = services.find(
      (s) => s.type === 'AtprotoPersonalDataServer' || s.id === '#atproto_pds'
    );
    if (pdsService) {
      return pdsService.serviceEndpoint;
    }
  }

  throw new Error(`No PDS service found in DID document for: ${did}`);
}

// Fetch Authorization Server metadata
export async function fetchAuthServerMetadata(pdsUrl: string): Promise<{
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint?: string;
  revocation_endpoint?: string;
}> {
  // First get the PDS resource server metadata
  const resourceResponse = await fetch(`${pdsUrl}/.well-known/oauth-protected-resource`);
  if (!resourceResponse.ok) {
    throw new Error(`Could not fetch resource server metadata from ${pdsUrl}`);
  }
  const resourceMeta = await resourceResponse.json() as { authorization_servers: string[] };

  const authServerUrl = resourceMeta.authorization_servers[0];

  // Then get the authorization server metadata
  const authResponse = await fetch(`${authServerUrl}/.well-known/oauth-authorization-server`);
  if (!authResponse.ok) {
    throw new Error(`Could not fetch auth server metadata from ${authServerUrl}`);
  }

  return await authResponse.json() as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    pushed_authorization_request_endpoint?: string;
    revocation_endpoint?: string;
  };
}

// Store OAuth state in D1
export async function storeOAuthState(env: Env, state: string, data: OAuthState): Promise<void> {
  const expiresAt = Date.now() + 600 * 1000; // 10 minutes
  await env.DB.prepare(`
    INSERT INTO oauth_state (state, code_verifier, did, handle, pds_url, auth_server, return_url, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    state,
    data.codeVerifier,
    data.did,
    data.handle,
    data.pdsUrl,
    data.authServer,
    data.returnUrl || null,
    expiresAt
  ).run();
}

// Get OAuth state from D1
export async function getOAuthState(env: Env, state: string): Promise<OAuthState | null> {
  const row = await env.DB.prepare(
    'SELECT * FROM oauth_state WHERE state = ? AND expires_at > ?'
  ).bind(state, Date.now()).first<{
    code_verifier: string;
    did: string;
    handle: string;
    pds_url: string;
    auth_server: string;
    return_url: string | null;
  }>();

  if (!row) return null;

  return {
    codeVerifier: row.code_verifier,
    did: row.did,
    handle: row.handle,
    pdsUrl: row.pds_url,
    authServer: row.auth_server,
    returnUrl: row.return_url || undefined,
  };
}

// Delete OAuth state from D1
export async function deleteOAuthState(env: Env, state: string): Promise<void> {
  await env.DB.prepare('DELETE FROM oauth_state WHERE state = ?').bind(state).run();
}

// Store session in D1
export async function storeSession(env: Env, sessionId: string, session: Session): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO sessions (session_id, did, handle, display_name, avatar_url, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at
  `).bind(
    sessionId,
    session.did,
    session.handle,
    session.displayName || null,
    session.avatarUrl || null,
    session.pdsUrl,
    session.accessToken,
    session.refreshToken,
    session.dpopPrivateKey,
    session.expiresAt
  ).run();
}

// Get session from D1 (returns session even if expired, to allow refresh)
async function getSessionWithRefreshState(env: Env, sessionId: string): Promise<SessionWithRefreshState | null> {
  const row = await env.DB.prepare(`
    SELECT
      did, handle, display_name, avatar_url, pds_url,
      access_token, refresh_token, dpop_private_key, expires_at,
      refresh_failures, last_refresh_attempt, last_refresh_error, refresh_locked_until
    FROM sessions
    WHERE session_id = ?
  `).bind(sessionId).first<{
    did: string;
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    pds_url: string;
    access_token: string;
    refresh_token: string;
    dpop_private_key: string;
    expires_at: number;
    refresh_failures: number | null;
    last_refresh_attempt: number | null;
    last_refresh_error: string | null;
    refresh_locked_until: number | null;
  }>();

  if (!row) return null;

  return {
    did: row.did,
    handle: row.handle,
    displayName: row.display_name || undefined,
    avatarUrl: row.avatar_url || undefined,
    pdsUrl: row.pds_url,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    dpopPrivateKey: row.dpop_private_key,
    expiresAt: row.expires_at,
    refreshFailures: row.refresh_failures || 0,
    lastRefreshAttempt: row.last_refresh_attempt || undefined,
    lastRefreshError: row.last_refresh_error || undefined,
    refreshLockedUntil: row.refresh_locked_until || undefined,
  };
}

// Public getSession - returns Session type for external use
export async function getSession(env: Env, sessionId: string): Promise<Session | null> {
  const session = await getSessionWithRefreshState(env, sessionId);
  if (!session) return null;

  // Return just the Session fields (without refresh state)
  return {
    did: session.did,
    handle: session.handle,
    displayName: session.displayName,
    avatarUrl: session.avatarUrl,
    pdsUrl: session.pdsUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    dpopPrivateKey: session.dpopPrivateKey,
    expiresAt: session.expiresAt,
  };
}

// Delete session from D1
export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE session_id = ?').bind(sessionId).run();
}

// RFC 8252 requires loopback IP instead of localhost for OAuth
function getBaseUrl(url: URL): string {
  let host = url.host;
  // Replace localhost with 127.0.0.1 for OAuth compliance
  if (host.startsWith('localhost')) {
    host = host.replace('localhost', '127.0.0.1');
  }
  return `${url.protocol}//${host}`;
}

// Get session from Authorization header, auto-refreshing if needed
export async function getSessionFromRequest(request: Request, env: Env): Promise<Session | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const sessionId = authHeader.substring(7);
  const session = await getSessionWithRefreshState(env, sessionId);

  if (!session) {
    return null;
  }

  // Check if session has exceeded max refresh failures
  if (session.refreshFailures >= MAX_REFRESH_FAILURES) {
    console.log(`Session for ${session.handle} has exceeded max refresh failures, treating as invalid`);
    return null;
  }

  // Check if token is expired or about to expire (within 5 minutes)
  const expiryBuffer = 5 * 60 * 1000; // 5 minutes
  const timeUntilExpiry = (session.expiresAt || 0) - Date.now();

  if (timeUntilExpiry < expiryBuffer) {
    // Check if we're in backoff period
    if (session.refreshLockedUntil && Date.now() < session.refreshLockedUntil) {
      const lockRemaining = session.refreshLockedUntil - Date.now();
      console.log(`Refresh locked for ${session.handle} for ${Math.round(lockRemaining / 1000)}s more (failure ${session.refreshFailures}/${MAX_REFRESH_FAILURES})`);
      return null;
    }

    console.log(`Token expiring in ${timeUntilExpiry}ms for ${session.handle}, attempting refresh...`);
    // Try to refresh the token
    try {
      const refreshedSession = await refreshSession(env, sessionId, session, request);
      if (refreshedSession) {
        return refreshedSession;
      }
    } catch (error) {
      console.error('Token refresh error:', error);
    }
    // If refresh fails, return null (session needs refresh but can't right now)
    return null;
  }

  return session;
}

// Refresh session tokens with resilience (retry logic with backoff)
async function refreshSession(
  env: Env,
  sessionId: string,
  session: SessionWithRefreshState,
  request: Request
): Promise<Session | null> {
  // Helper to record a refresh failure with backoff
  async function recordRefreshFailure(errorCode: string | undefined, statusCode?: number): Promise<void> {
    const newFailures = session.refreshFailures + 1;
    const backoffMs = calculateBackoffMs(newFailures);
    const lockUntil = Date.now() + backoffMs;

    await env.DB.prepare(`
      UPDATE sessions
      SET refresh_failures = ?,
          last_refresh_attempt = ?,
          last_refresh_error = ?,
          refresh_locked_until = ?
      WHERE session_id = ?
    `).bind(
      newFailures,
      Date.now(),
      errorCode || `HTTP ${statusCode || 'unknown'}`,
      lockUntil,
      sessionId
    ).run();

    console.log(
      `Transient refresh error for ${session.handle}, ` +
      `failure ${newFailures}/${MAX_REFRESH_FAILURES}, ` +
      `locked until ${new Date(lockUntil).toISOString()}`
    );
  }

  // Helper to reset refresh state on success
  async function resetRefreshState(): Promise<void> {
    await env.DB.prepare(`
      UPDATE sessions
      SET refresh_failures = 0,
          last_refresh_attempt = ?,
          last_refresh_error = NULL,
          refresh_locked_until = NULL
      WHERE session_id = ?
    `).bind(Date.now(), sessionId).run();
  }

  try {
    // Import the DPoP key
    const privateKeyJwk = JSON.parse(session.dpopPrivateKey);
    const privateKey = await importPrivateKey(privateKeyJwk);
    const publicKeyJwk = { ...privateKeyJwk };
    delete (publicKeyJwk as Record<string, unknown>).d;

    // Get token endpoint
    const authMeta = await fetchAuthServerMetadata(session.pdsUrl);

    // Construct client_id from request URL
    const url = new URL(request.url);
    const baseUrl = getBaseUrl(url);
    const clientId = `${baseUrl}/.well-known/client-metadata`;

    // Create DPoP proof for refresh request
    let dpopProof = await createDPoPProof(
      privateKey,
      publicKeyJwk,
      'POST',
      authMeta.token_endpoint
    );

    const refreshBody = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: clientId,
    });

    let tokenResponse = await fetch(authMeta.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: dpopProof,
      },
      body: refreshBody,
    });

    // Handle DPoP nonce requirement
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      const errorData = (() => { try { return JSON.parse(errorText) as { error?: string }; } catch { return null; } })();
      const dpopNonce = tokenResponse.headers.get('DPoP-Nonce');

      if (errorData?.error === 'use_dpop_nonce' && dpopNonce) {
        dpopProof = await createDPoPProof(
          privateKey,
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
          body: refreshBody,
        });
      }
    }

    // Handle refresh failure with resilience
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      const errorData = (() => { try { return JSON.parse(errorText) as { error?: string }; } catch { return null; } })();
      const errorCode = errorData?.error;
      const statusCode = tokenResponse.status;

      console.error(`Token refresh failed for ${session.handle}:`, errorCode, statusCode, errorText);

      // Permanent error: delete session immediately
      if (isPermanentError(errorCode)) {
        console.log(`Permanent refresh error (${errorCode}) for ${session.handle}, deleting session`);
        await deleteSession(env, sessionId);
        return null;
      }

      // Transient error: check if we've exceeded max failures
      const newFailures = session.refreshFailures + 1;
      if (newFailures >= MAX_REFRESH_FAILURES) {
        console.log(`Max refresh failures (${MAX_REFRESH_FAILURES}) reached for ${session.handle}, deleting session`);
        await deleteSession(env, sessionId);
        return null;
      }

      // Record the failure and set backoff
      await recordRefreshFailure(errorCode, statusCode);
      return null;
    }

    const tokenData = await tokenResponse.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // Update session with new tokens
    const updatedSession: Session = {
      ...session,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
    };

    // Store updated session and reset failure counters
    await storeSession(env, sessionId, updatedSession);
    await resetRefreshState();
    console.log('Session refreshed successfully for', session.handle);
    return updatedSession;
  } catch (error) {
    // Network/fetch errors are transient
    console.error('Session refresh network error for', session.handle, ':', error);

    const newFailures = session.refreshFailures + 1;
    if (newFailures >= MAX_REFRESH_FAILURES) {
      console.log(`Max refresh failures reached for ${session.handle} (network error), deleting session`);
      await deleteSession(env, sessionId);
      return null;
    }

    // Record network error as transient failure
    const backoffMs = calculateBackoffMs(newFailures);
    const lockUntil = Date.now() + backoffMs;

    await env.DB.prepare(`
      UPDATE sessions
      SET refresh_failures = ?,
          last_refresh_attempt = ?,
          last_refresh_error = ?,
          refresh_locked_until = ?
      WHERE session_id = ?
    `).bind(
      newFailures,
      Date.now(),
      error instanceof Error ? error.message : 'Network error',
      lockUntil,
      sessionId
    ).run();

    console.log(
      `Network error for ${session.handle}, ` +
      `failure ${newFailures}/${MAX_REFRESH_FAILURES}, ` +
      `locked until ${new Date(lockUntil).toISOString()}`
    );
    return null;
  }
}

// Update user's last active timestamp
export async function updateUserActivity(env: Env, did: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE users SET last_active_at = unixepoch() WHERE did = ?'
  ).bind(did).run();
}
