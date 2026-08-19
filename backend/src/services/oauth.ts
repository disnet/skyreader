import type { Env, OAuthState, Session } from '../types';
import { createClientAssertion } from './client-auth';
import { parseCookies, SESSION_COOKIE_NAME } from '../utils/cookies';
import { ALL_POSSIBLE_SCOPES } from '../config/scopes';
import { timedFirst } from '../utils/d1-timing';

// Constants for refresh retry logic
const MAX_REFRESH_FAILURES = 5;
const BASE_BACKOFF_MS = 60 * 1000; // 1 minute base
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1 hour max

// Error codes that indicate permanent failure (refresh token is invalid)
const PERMANENT_REFRESH_ERRORS = [
  'invalid_grant', // Refresh token expired or revoked
  'invalid_client', // Client credentials invalid
  'unauthorized_client', // Client not authorized for this grant type
  'invalid_token', // Token is malformed or revoked
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
  const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
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
  refreshInProgress?: number; // Timestamp of ongoing refresh
}

// Generate a cryptographically random string
export function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Generate PKCE code verifier and challenge
export async function generatePKCE(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
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
  return (await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
}

// Export private key to JWK
export async function exportPrivateKey(key: CryptoKey): Promise<JsonWebKey> {
  return (await crypto.subtle.exportKey('jwk', key)) as JsonWebKey;
}

// Import private key from JWK
export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ]);
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

// Normalize handle input (auto-append .bsky.social if needed)
export function normalizeHandleInput(handle: string): string {
  let normalized = handle.startsWith('@') ? handle.substring(1) : handle;
  normalized = normalized.toLowerCase().trim();
  if (!normalized.includes('.')) {
    normalized = `${normalized}.bsky.social`;
  }
  return normalized;
}

// Resolve handle to DID using multiple strategies
export async function resolveHandle(handle: string): Promise<string> {
  const normalizedHandle = normalizeHandleInput(handle);

  // Strategy 1: Try Bluesky public API (works for all Bluesky handles)
  try {
    const bskyUrl = `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(normalizedHandle)}`;
    const bskyResponse = await fetch(bskyUrl);
    if (bskyResponse.ok) {
      const data = (await bskyResponse.json()) as { did: string };
      if (data.did) {
        return data.did;
      }
    }
  } catch {
    // Bluesky API failed, continue to fallbacks
  }

  // Strategy 2: DNS TXT record lookup (for custom domains)
  try {
    const dnsUrl = `https://dns.google/resolve?name=_atproto.${normalizedHandle}&type=TXT`;
    const dnsResponse = await fetch(dnsUrl);
    const dnsData = (await dnsResponse.json()) as {
      Answer?: { data: string }[];
    };
    if (dnsData.Answer && dnsData.Answer.length > 0) {
      const txtRecord = dnsData.Answer[0].data.replace(/"/g, '');
      if (txtRecord.startsWith('did=')) {
        return txtRecord.substring(4);
      }
    }
  } catch {
    // DNS lookup failed, try HTTP fallback
  }

  // Strategy 3: HTTP well-known (for custom domains without DNS TXT)
  try {
    const httpUrl = `https://${normalizedHandle}/.well-known/atproto-did`;
    const httpResponse = await fetch(httpUrl);
    if (httpResponse.ok) {
      const did = await httpResponse.text();
      return did.trim();
    }
  } catch {
    // HTTP fallback also failed
  }

  throw new Error(
    `Could not resolve handle: ${normalizedHandle}. ` +
      `Please ensure this is a valid Bluesky handle.`
  );
}

// PDS endpoints rarely change, but users can migrate. Keep TTL short enough
// that a migration self-heals within a day even without cache invalidation.
const PDS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function extractPdsFromDidDoc(didDoc: Record<string, unknown>, did: string): string {
  const services = didDoc.service as
    | { id: string; type: string; serviceEndpoint: string }[]
    | undefined;
  const pdsService = services?.find(
    (s) => s.type === 'AtprotoPersonalDataServer' || s.id === '#atproto_pds'
  );
  if (!pdsService) {
    throw new Error(`No PDS service found in DID document for: ${did}`);
  }
  return pdsService.serviceEndpoint;
}

async function fetchDidDocFrom(url: string, did: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    console.error(`getPdsFromDid: fetch threw for ${url}:`, err);
    throw new Error(`Could not resolve DID: ${did} (network error from ${url})`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>');
    console.error(
      `getPdsFromDid: ${url} returned ${response.status} ${response.statusText}; body: ${body.slice(0, 500)}`
    );
    throw new Error(`Could not resolve DID: ${did} (HTTP ${response.status} from ${url})`);
  }
  return (await response.json()) as Record<string, unknown>;
}

// Resolve DID via plc.directory (or did:web), with a bsky.app AppView fallback for did:plc.
async function resolvePdsFromNetwork(did: string): Promise<string> {
  if (did.startsWith('did:plc:')) {
    try {
      const didDoc = await fetchDidDocFrom(`https://plc.directory/${did}`, did);
      return extractPdsFromDidDoc(didDoc, did);
    } catch (err) {
      console.warn(
        `getPdsFromDid: plc.directory failed for ${did}, trying bsky.app fallback:`,
        err
      );
    }
    // describeRepo on the AppView returns the full DID document under `didDoc`.
    const describe = (await fetchDidDocFrom(
      `https://api.bsky.app/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`,
      did
    )) as { didDoc?: Record<string, unknown> };
    if (!describe.didDoc) {
      throw new Error(`bsky.app describeRepo returned no didDoc for ${did}`);
    }
    return extractPdsFromDidDoc(describe.didDoc, did);
  }

  if (did.startsWith('did:web:')) {
    const domain = did.substring(8).replace(/:/g, '/');
    const didDoc = await fetchDidDocFrom(`https://${domain}/.well-known/did.json`, did);
    return extractPdsFromDidDoc(didDoc, did);
  }

  throw new Error(`Unsupported DID method: ${did}`);
}

// Get PDS URL from DID, with D1 caching and AppView fallback. Returns
// `fromCache: true` when the value came from a fresh cache hit, so callers
// can invalidate and retry if the cached endpoint turns out to be stale
// (e.g., user migrated their PDS).
export async function getPdsFromDid(
  did: string,
  env: Env
): Promise<{ pdsUrl: string; fromCache: boolean }> {
  // 1. Fresh cache hit
  let cached: { pds_url: string; updated_at: number } | null = null;
  try {
    cached = await env.DB.prepare('SELECT pds_url, updated_at FROM did_pds_cache WHERE did = ?')
      .bind(did)
      .first<{ pds_url: string; updated_at: number }>();
  } catch (err) {
    console.error('getPdsFromDid: cache read failed:', err);
  }

  if (cached && Date.now() - cached.updated_at < PDS_CACHE_TTL_MS) {
    return { pdsUrl: cached.pds_url, fromCache: true };
  }

  // 2. Network resolution (plc.directory, with bsky.app fallback for did:plc)
  let pdsUrl: string | null = null;
  let networkError: unknown;
  try {
    pdsUrl = await resolvePdsFromNetwork(did);
  } catch (err) {
    networkError = err;
    console.error(`getPdsFromDid: network resolution failed for ${did}:`, err);
  }

  // 3. Stale cache fallback — keeps login working if plc.directory and bsky.app both fail
  if (!pdsUrl) {
    if (cached) {
      console.warn(
        `getPdsFromDid: using stale cached PDS for ${did} (age ${Math.round((Date.now() - cached.updated_at) / 1000)}s)`
      );
      return { pdsUrl: cached.pds_url, fromCache: true };
    }
    if (networkError instanceof Error) throw networkError;
    throw new Error(`Could not resolve DID: ${did}`);
  }

  // 4. Cache successful resolution
  try {
    await env.DB.prepare(
      'INSERT INTO did_pds_cache (did, pds_url, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(did) DO UPDATE SET pds_url = excluded.pds_url, updated_at = excluded.updated_at'
    )
      .bind(did, pdsUrl, Date.now())
      .run();
  } catch (err) {
    console.error('getPdsFromDid: cache write failed:', err);
  }

  return { pdsUrl, fromCache: false };
}

// Evict a DID from the PDS cache. Call after an OAuth failure that suggests
// the cached endpoint is stale (e.g., user migrated their PDS).
export async function invalidatePdsCache(did: string, env: Env): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM did_pds_cache WHERE did = ?').bind(did).run();
    console.warn(`invalidatePdsCache: evicted ${did}`);
  } catch (err) {
    console.error('invalidatePdsCache failed:', err);
  }
}

// Fetch Authorization Server metadata
export async function fetchAuthServerMetadata(pdsUrl: string): Promise<{
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint?: string;
  revocation_endpoint?: string;
}> {
  // First get the PDS resource server metadata to discover its auth server.
  let authServerUrl = pdsUrl;
  const resourceResponse = await fetch(`${pdsUrl}/.well-known/oauth-protected-resource`);
  if (resourceResponse.ok) {
    const resourceMeta = (await resourceResponse.json()) as {
      authorization_servers: string[];
    };
    authServerUrl = resourceMeta.authorization_servers[0];
  }
  // Otherwise the host may itself be the authorization server — e.g. an entryway
  // like bsky.social, which has no resource metadata. Fall back to it directly.

  // Then get the authorization server metadata
  const authResponse = await fetch(`${authServerUrl}/.well-known/oauth-authorization-server`);
  if (!authResponse.ok) {
    throw new Error(`Could not fetch auth server metadata from ${authServerUrl}`);
  }

  return (await authResponse.json()) as {
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
  await env.DB.prepare(
    `
    INSERT INTO oauth_state (state, code_verifier, did, handle, pds_url, auth_server, return_url, frontend_url, cli_port, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  )
    .bind(
      state,
      data.codeVerifier,
      data.did,
      data.handle,
      data.pdsUrl,
      data.authServer,
      data.returnUrl || null,
      data.frontendUrl,
      data.cliPort || null,
      expiresAt
    )
    .run();
}

// Get OAuth state from D1
export async function getOAuthState(env: Env, state: string): Promise<OAuthState | null> {
  const row = await env.DB.prepare('SELECT * FROM oauth_state WHERE state = ? AND expires_at > ?')
    .bind(state, Date.now())
    .first<{
      code_verifier: string;
      did: string;
      handle: string;
      pds_url: string;
      auth_server: string;
      return_url: string | null;
      frontend_url: string | null;
      cli_port: number | null;
    }>();

  if (!row) return null;

  return {
    codeVerifier: row.code_verifier,
    did: row.did,
    handle: row.handle,
    pdsUrl: row.pds_url,
    authServer: row.auth_server,
    returnUrl: row.return_url || undefined,
    frontendUrl: row.frontend_url || '',
    cliPort: row.cli_port || undefined,
  };
}

// Delete OAuth state from D1
export async function deleteOAuthState(env: Env, state: string): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM oauth_state WHERE state = ?').bind(state).run();
  } catch (dbError) {
    console.error(`[OAuth] D1 WRITE ERROR deleting oauth_state for state ${state}:`, dbError);
    throw dbError;
  }
}

// Store session in D1
export async function storeSession(env: Env, sessionId: string, session: Session): Promise<void> {
  await env.DB.prepare(
    `
    INSERT INTO sessions (session_id, did, handle, display_name, avatar_url, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at
  `
  )
    .bind(
      sessionId,
      session.did,
      session.handle,
      session.displayName || null,
      session.avatarUrl || null,
      session.pdsUrl,
      session.accessToken,
      session.refreshToken,
      session.dpopPrivateKey,
      session.expiresAt,
      session.grantedScopes || null
    )
    .run();
}

// Persist a re-resolved PDS host onto an existing session. storeSession's
// ON CONFLICT clause deliberately only refreshes tokens/expiry and does NOT
// touch pds_url, so a host that moved after a PDS migration must be written
// explicitly here (see PDSClient's stale-endpoint recovery).
export async function updateSessionPdsUrl(
  env: Env,
  sessionId: string,
  pdsUrl: string
): Promise<void> {
  await env.DB.prepare('UPDATE sessions SET pds_url = ? WHERE session_id = ?')
    .bind(pdsUrl, sessionId)
    .run();
}

// Extract the session id from a request's cookie or Authorization header, using
// the same precedence as resolveSessionFromRequest. Returns null if neither is
// present. Useful when a caller needs the id itself (not just the session) to
// persist a migrated PDS host back to the row.
export function getSessionIdFromRequest(request: Request): string | null {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const fromCookie = cookies.get(SESSION_COOKIE_NAME);
  if (fromCookie) return fromCookie;

  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return null;
}

// Get session from D1 (returns session even if expired, to allow refresh)
async function getSessionWithRefreshState(
  env: Env,
  sessionId: string
): Promise<SessionWithRefreshState | null> {
  // Timed like the rest of the read path: this runs before every authenticated
  // route, so it is one of the sequential D1 round trips any per-request latency
  // budget has to account for.
  const row = await timedFirst<{
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
    refresh_in_progress: number | null;
    granted_scopes: string | null;
  }>(
    'session_lookup',
    env.DB.prepare(
      `
    SELECT
      did, handle, display_name, avatar_url, pds_url,
      access_token, refresh_token, dpop_private_key, expires_at,
      refresh_failures, last_refresh_attempt, last_refresh_error, refresh_locked_until,
      refresh_in_progress, granted_scopes
    FROM sessions
    WHERE session_id = ?
  `
    ).bind(sessionId)
  );

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
    grantedScopes: row.granted_scopes || undefined,
    refreshFailures: row.refresh_failures || 0,
    lastRefreshAttempt: row.last_refresh_attempt || undefined,
    lastRefreshError: row.last_refresh_error || undefined,
    refreshLockedUntil: row.refresh_locked_until || undefined,
    refreshInProgress: row.refresh_in_progress || undefined,
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
    grantedScopes: session.grantedScopes,
  };
}

// Delete session from D1
export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM sessions WHERE session_id = ?').bind(sessionId).run();
  } catch (dbError) {
    console.error(`[OAuth] D1 WRITE ERROR deleting session ${sessionId}:`, dbError);
    throw dbError;
  }
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

// Build client_id for localhost development using AT Protocol's localhost exception.
// The redirect_uri and scope embedded here are part of the client's virtual metadata,
// so they MUST match byte-for-byte what was used at authorization time — otherwise the
// auth server treats refresh as coming from a different client and rejects it.
// See: https://atproto.com/specs/oauth#localhost-client-development
export function buildLocalhostClientId(redirectUri: string, scope: string): string {
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    scope: scope,
  });
  return `http://localhost?${params.toString()}`;
}

// Resolve the OAuth client_id (and whether to attach a private_key_jwt assertion) for a
// request, mirroring the login/callback flow. Production sets CLIENT_SIGNING_KEY and is a
// confidential client using the hosted client-metadata URL. Local dev has no signing key and
// is a *public* client on a loopback host, using AT Protocol's localhost exception — no
// assertion, with the client_id reconstructed from the same redirect_uri + scopes as auth.
// Getting this wrong locally manifests as endless `session_refresh_pending` 503s, because
// createClientAssertion() throws when CLIENT_SIGNING_KEY is unset.
function resolveClientIdentity(env: Env, url: URL): { clientId: string; isPublicClient: boolean } {
  const baseUrl = getBaseUrl(url);
  const hasSigningKey = !!(env as Env & { CLIENT_SIGNING_KEY?: string }).CLIENT_SIGNING_KEY;
  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';

  if (!hasSigningKey && isLoopback) {
    const redirectUri = `${baseUrl}/api/auth/callback`;
    return {
      clientId: buildLocalhostClientId(redirectUri, ALL_POSSIBLE_SCOPES),
      isPublicClient: true,
    };
  }

  return { clientId: `${baseUrl}/.well-known/client-metadata`, isPublicClient: false };
}

// Why a session resolution produced no usable session. This lets callers avoid
// logging a user out over a momentary hiccup:
//   'none'      - no credentials presented (no cookie / bearer). Not logged in.
//   'permanent' - session is genuinely gone: deleted, refresh token revoked/expired
//                 (invalid_grant), or too many refresh failures. User MUST re-auth.
//   'transient' - the session row is still alive, but its access token is expired and
//                 a refresh couldn't complete RIGHT NOW (in backoff, raced by a
//                 concurrent refresh, or the poll timed out). The next attempt will
//                 very likely succeed — e.g. a burst of requests after a deploy. The
//                 caller should retry, NOT log the user out.
export type SessionFailureReason = 'none' | 'permanent' | 'transient';

export interface SessionResolution {
  session: Session | null;
  // Set only when session is null.
  reason?: SessionFailureReason;
}

// Resolve the session for a request, auto-refreshing if needed, and report WHY it's
// unavailable when it is. Prefer this over getSessionFromRequest at the auth gate so a
// transient refresh failure can be surfaced as a retryable error instead of a logout.
export async function resolveSessionFromRequest(
  request: Request,
  env: Env
): Promise<SessionResolution> {
  // Try cookie first (new method)
  const cookieHeader = request.headers.get('Cookie');
  const cookies = parseCookies(cookieHeader);
  let sessionId = cookies.get(SESSION_COOKIE_NAME);

  // Fall back to Authorization header (backward compatibility during migration)
  if (!sessionId) {
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      sessionId = authHeader.substring(7);
    }
  }

  if (!sessionId) {
    return { session: null, reason: 'none' };
  }

  const session = await getSessionWithRefreshState(env, sessionId);

  if (!session) {
    // No row for this session id — it was deleted or never existed. Re-auth required.
    return { session: null, reason: 'permanent' };
  }

  // Check if session has exceeded max refresh failures
  if (session.refreshFailures >= MAX_REFRESH_FAILURES) {
    console.log(
      `Session for ${session.handle} has exceeded max refresh failures, treating as invalid`
    );
    return { session: null, reason: 'permanent' };
  }

  // Check if token is expired or about to expire (within 5 minutes)
  const expiryBuffer = 5 * 60 * 1000; // 5 minutes
  const timeUntilExpiry = (session.expiresAt || 0) - Date.now();

  if (timeUntilExpiry < expiryBuffer) {
    const isActuallyExpired = timeUntilExpiry <= 0;

    // Check if we're in backoff period
    if (session.refreshLockedUntil && Date.now() < session.refreshLockedUntil) {
      const lockRemaining = session.refreshLockedUntil - Date.now();
      console.log(
        `Refresh locked for ${session.handle} for ${Math.round(lockRemaining / 1000)}s more (failure ${session.refreshFailures}/${MAX_REFRESH_FAILURES})`
      );
      // If token not actually expired yet, continue with existing session
      if (!isActuallyExpired) {
        console.log(`Token still valid for ${session.handle}, using existing session`);
        return { session };
      }
      // Token expired and we're mid-backoff after a transient failure — recoverable.
      return { session: null, reason: 'transient' };
    }

    console.log(
      `Token expiring in ${timeUntilExpiry}ms for ${session.handle}, attempting refresh...`
    );
    // Try to refresh the token
    try {
      const refreshedSession = await refreshSession(env, sessionId, session, request);
      if (refreshedSession) {
        return { session: refreshedSession };
      }
    } catch (error) {
      console.error('Token refresh error:', error);
    }

    // Refresh returned null - either another refresh is in progress, or it failed
    // Poll to wait for the concurrent refresh to complete
    if (isActuallyExpired) {
      console.log(
        `Refresh didn't complete for ${session.handle}, waiting for concurrent refresh...`
      );

      // Poll up to 10 seconds (10 attempts, 1 second apart) for refresh to complete
      const maxAttempts = 10;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Re-fetch session to see if another request completed the refresh
        const updatedSession = await getSessionWithRefreshState(env, sessionId);

        if (!updatedSession) {
          // Session was deleted (permanent refresh error like invalid_grant)
          console.log(
            `Session for ${session.handle} was deleted during concurrent refresh (likely permanent error)`
          );
          return { session: null, reason: 'permanent' };
        }

        const updatedTimeUntilExpiry = (updatedSession.expiresAt || 0) - Date.now();
        if (updatedTimeUntilExpiry > 0) {
          console.log(
            `Concurrent refresh completed for ${session.handle} after ${attempt}s, using updated session`
          );
          return { session: updatedSession };
        }

        // Check if refresh is still in progress (using the refresh_in_progress lock field)
        const lockStaleThreshold = Date.now() - REFRESH_LOCK_TIMEOUT_MS;
        const refreshStillInProgress =
          updatedSession.refreshInProgress && updatedSession.refreshInProgress > lockStaleThreshold;

        if (!refreshStillInProgress) {
          // Refresh completed but failed (transient error recorded)
          console.log(
            `Concurrent refresh failed for ${session.handle}: ${updatedSession.lastRefreshError || 'unknown error'}, ` +
              `failures: ${updatedSession.refreshFailures}/${MAX_REFRESH_FAILURES}`
          );
          // If the failures hit the cap, the session is effectively dead.
          if (updatedSession.refreshFailures >= MAX_REFRESH_FAILURES) {
            return { session: null, reason: 'permanent' };
          }
          // Otherwise it's a transient failure with retries left — recoverable.
          return { session: null, reason: 'transient' };
        }

        if (attempt < maxAttempts) {
          console.log(
            `Still waiting for concurrent refresh for ${session.handle} (attempt ${attempt}/${maxAttempts})...`
          );
        }
      }

      // Timed out waiting for concurrent refresh — the refresh may still land shortly.
      console.log(
        `Timed out waiting for concurrent refresh for ${session.handle}, treating as transient`
      );
      return { session: null, reason: 'transient' };
    }

    // Token not actually expired yet, use existing session
    console.log(
      `Refresh failed but token still valid for ${session.handle}, using existing session`
    );
    return { session };
  }

  return { session };
}

// Get session from cookie or Authorization header, auto-refreshing if needed.
// Thin wrapper over resolveSessionFromRequest for callers that only need the session
// itself (and treat any absence as "not authenticated").
export async function getSessionFromRequest(request: Request, env: Env): Promise<Session | null> {
  const { session } = await resolveSessionFromRequest(request, env);
  return session;
}

// Find the most recent stored session id for a DID. Used by the AT Intents service-auth
// path: a verified inter-service JWT proves the user's identity, but acting on their
// behalf (especially PDS writes) still needs Skyreader's stored OAuth tokens, so we map
// the DID to a session the user established by signing in. Returns null if there is none.
// The caller delegates with this session id, so the normal auto-refresh still applies.
export async function findSessionIdForDid(env: Env, did: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT session_id FROM sessions WHERE did = ? ORDER BY expires_at DESC LIMIT 1'
  )
    .bind(did)
    .first<{ session_id: string }>();
  return row?.session_id ?? null;
}

// Lock timeout in milliseconds - if a refresh takes longer than this, the lock is considered stale
const REFRESH_LOCK_TIMEOUT_MS = 30 * 1000; // 30 seconds

// Refresh session tokens with resilience (retry logic with backoff)
async function refreshSession(
  env: Env,
  sessionId: string,
  session: SessionWithRefreshState,
  request: Request
): Promise<Session | null> {
  // Try to acquire refresh lock using optimistic locking
  // This prevents concurrent refresh requests from racing
  const lockAcquireTime = Date.now();
  const staleThreshold = lockAcquireTime - REFRESH_LOCK_TIMEOUT_MS;

  const lockResult = await env.DB.prepare(
    `
    UPDATE sessions
    SET refresh_in_progress = ?
    WHERE session_id = ?
    AND (refresh_in_progress IS NULL OR refresh_in_progress < ?)
  `
  )
    .bind(lockAcquireTime, sessionId, staleThreshold)
    .run();

  if (!lockResult.meta?.changes || lockResult.meta.changes === 0) {
    // Another refresh is in progress - caller will decide whether to use existing session
    console.log(`Refresh lock not acquired for ${session.handle}, another refresh in progress`);
    return null;
  }

  // Helper to release the refresh lock
  async function releaseLock(): Promise<void> {
    await env.DB.prepare(
      `
      UPDATE sessions SET refresh_in_progress = NULL WHERE session_id = ?
    `
    )
      .bind(sessionId)
      .run();
  }

  // Helper to record a refresh failure with backoff (also releases lock)
  async function recordRefreshFailure(
    errorCode: string | undefined,
    statusCode?: number
  ): Promise<void> {
    const newFailures = session.refreshFailures + 1;
    const backoffMs = calculateBackoffMs(newFailures);
    const lockUntil = Date.now() + backoffMs;

    await env.DB.prepare(
      `
      UPDATE sessions
      SET refresh_failures = ?,
          last_refresh_attempt = ?,
          last_refresh_error = ?,
          refresh_locked_until = ?,
          refresh_in_progress = NULL
      WHERE session_id = ?
    `
    )
      .bind(
        newFailures,
        Date.now(),
        errorCode || `HTTP ${statusCode || 'unknown'}`,
        lockUntil,
        sessionId
      )
      .run();

    console.log(
      `Transient refresh error for ${session.handle}, ` +
        `failure ${newFailures}/${MAX_REFRESH_FAILURES}, ` +
        `locked until ${new Date(lockUntil).toISOString()}`
    );
  }

  // Helper to reset refresh state on success (also releases lock)
  async function resetRefreshState(): Promise<void> {
    await env.DB.prepare(
      `
      UPDATE sessions
      SET refresh_failures = 0,
          last_refresh_attempt = ?,
          last_refresh_error = NULL,
          refresh_locked_until = NULL,
          refresh_in_progress = NULL
      WHERE session_id = ?
    `
    )
      .bind(Date.now(), sessionId)
      .run();
  }

  try {
    // Import the DPoP key
    const privateKeyJwk = JSON.parse(session.dpopPrivateKey);
    const privateKey = await importPrivateKey(privateKeyJwk);
    const publicKeyJwk = { ...privateKeyJwk };
    delete (publicKeyJwk as Record<string, unknown>).d;

    // Get token endpoint
    const authMeta = await fetchAuthServerMetadata(session.pdsUrl);

    // Resolve client identity from the request. In local dev this is a public client
    // (localhost exception, no assertion); in production it's a confidential client.
    const url = new URL(request.url);
    const { clientId, isPublicClient } = resolveClientIdentity(env, url);

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

    // Confidential clients (production) authenticate with a private_key_jwt assertion.
    // Public clients (local dev) must NOT send one.
    if (!isPublicClient) {
      const clientAssertion = await createClientAssertion(env, authMeta.issuer, clientId);
      refreshBody.set(
        'client_assertion_type',
        'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
      );
      refreshBody.set('client_assertion', clientAssertion);
    }

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
      const errorData = (() => {
        try {
          return JSON.parse(errorText) as { error?: string };
        } catch {
          return null;
        }
      })();
      const dpopNonce = tokenResponse.headers.get('DPoP-Nonce');

      if (errorData?.error === 'use_dpop_nonce' && dpopNonce) {
        dpopProof = await createDPoPProof(
          privateKey,
          publicKeyJwk,
          'POST',
          authMeta.token_endpoint,
          dpopNonce
        );

        const retryBody = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: session.refreshToken,
          client_id: clientId,
        });

        // Confidential clients re-sign a fresh assertion (must not reuse — each needs a
        // unique jti); public clients (local dev) send none.
        if (!isPublicClient) {
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

    // Handle refresh failure with resilience
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      const errorData = (() => {
        try {
          return JSON.parse(errorText) as { error?: string };
        } catch {
          return null;
        }
      })();
      const errorCode = errorData?.error;
      const statusCode = tokenResponse.status;

      console.error(
        `Token refresh failed for ${session.handle}:`,
        errorCode,
        statusCode,
        errorText
      );

      // Permanent error: delete session immediately
      if (isPermanentError(errorCode)) {
        console.log(
          `PERMANENT refresh error (${errorCode}) for ${session.handle} - session will be DELETED. ` +
            `This typically means the refresh token expired or was revoked. User must re-authenticate.`
        );
        await deleteSession(env, sessionId);
        return null;
      }

      // Transient error: check if we've exceeded max failures
      const newFailures = session.refreshFailures + 1;
      if (newFailures >= MAX_REFRESH_FAILURES) {
        console.log(
          `Max refresh failures (${MAX_REFRESH_FAILURES}) reached for ${session.handle}, deleting session`
        );
        await deleteSession(env, sessionId);
        return null;
      }

      // Record the failure and set backoff
      await recordRefreshFailure(errorCode, statusCode);
      return null;
    }

    const tokenData = (await tokenResponse.json()) as {
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
      console.log(
        `Max refresh failures reached for ${session.handle} (network error), deleting session`
      );
      await deleteSession(env, sessionId);
      return null;
    }

    // Record network error as transient failure (also releases lock)
    const backoffMs = calculateBackoffMs(newFailures);
    const lockUntil = Date.now() + backoffMs;

    await env.DB.prepare(
      `
      UPDATE sessions
      SET refresh_failures = ?,
          last_refresh_attempt = ?,
          last_refresh_error = ?,
          refresh_locked_until = ?,
          refresh_in_progress = NULL
      WHERE session_id = ?
    `
    )
      .bind(
        newFailures,
        Date.now(),
        error instanceof Error ? error.message : 'Network error',
        lockUntil,
        sessionId
      )
      .run();

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
  try {
    await env.DB.prepare('UPDATE users SET last_active_at = unixepoch() WHERE did = ?')
      .bind(did)
      .run();
  } catch (dbError) {
    console.error(`[OAuth] D1 WRITE ERROR updating user activity for ${did}:`, dbError);
    // Don't throw - this is called from waitUntil and shouldn't crash the request
  }
}
