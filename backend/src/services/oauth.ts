import type { Env, OAuthState, Session } from '../types';

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

// Get session from D1
export async function getSession(env: Env, sessionId: string): Promise<Session | null> {
  const row = await env.DB.prepare(
    'SELECT * FROM sessions WHERE session_id = ? AND expires_at > ?'
  ).bind(sessionId, Date.now()).first<{
    did: string;
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    pds_url: string;
    access_token: string;
    refresh_token: string;
    dpop_private_key: string;
    expires_at: number;
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
  };
}

// Delete session from D1
export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE session_id = ?').bind(sessionId).run();
}

// Get session from Authorization header, auto-refreshing if needed
export async function getSessionFromRequest(request: Request, env: Env): Promise<Session | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const sessionId = authHeader.substring(7);
  const session = await getSession(env, sessionId);

  if (!session) {
    return null;
  }

  // Check if token is expired or about to expire (within 5 minutes)
  const expiryBuffer = 5 * 60 * 1000; // 5 minutes
  const timeUntilExpiry = (session.expiresAt || 0) - Date.now();

  if (timeUntilExpiry < expiryBuffer) {
    console.log(`Token expiring in ${timeUntilExpiry}ms, refreshing...`);
    // Try to refresh the token
    try {
      const refreshedSession = await refreshSession(env, sessionId, session);
      if (refreshedSession) {
        return refreshedSession;
      }
    } catch (error) {
      console.error('Token refresh error:', error);
    }
    // If refresh fails, return null (session is invalid)
    return null;
  }

  return session;
}

// Refresh session tokens
async function refreshSession(env: Env, sessionId: string, session: Session): Promise<Session | null> {
  try {
    // Import the DPoP key
    const privateKeyJwk = JSON.parse(session.dpopPrivateKey);
    const privateKey = await importPrivateKey(privateKeyJwk);
    const publicKeyJwk = { ...privateKeyJwk };
    delete (publicKeyJwk as Record<string, unknown>).d;

    // Get token endpoint
    const authMeta = await fetchAuthServerMetadata(session.pdsUrl);

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
      } else {
        console.error('Token refresh failed:', errorText);
        // Delete invalid session
        await deleteSession(env, sessionId);
        return null;
      }
    }

    if (!tokenResponse.ok) {
      console.error('Token refresh failed:', await tokenResponse.text());
      // Delete invalid session
      await deleteSession(env, sessionId);
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

    // Store updated session
    await storeSession(env, sessionId, updatedSession);
    console.log('Session refreshed successfully for', session.handle);
    return updatedSession;
  } catch (error) {
    console.error('Session refresh error:', error);
    // Delete invalid session
    await deleteSession(env, sessionId);
    return null;
  }
}

// Update user's last active timestamp
export async function updateUserActivity(env: Env, did: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE users SET last_active_at = unixepoch() WHERE did = ?'
  ).bind(did).run();
}
