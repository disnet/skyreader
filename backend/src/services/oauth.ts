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

// Store OAuth state in KV
export async function storeOAuthState(env: Env, state: string, data: OAuthState): Promise<void> {
  await env.SESSION_CACHE.put(`oauth:state:${state}`, JSON.stringify(data), {
    expirationTtl: 600, // 10 minutes
  });
}

// Get OAuth state from KV
export async function getOAuthState(env: Env, state: string): Promise<OAuthState | null> {
  const data = await env.SESSION_CACHE.get(`oauth:state:${state}`);
  if (!data) return null;
  return JSON.parse(data) as OAuthState;
}

// Delete OAuth state from KV
export async function deleteOAuthState(env: Env, state: string): Promise<void> {
  await env.SESSION_CACHE.delete(`oauth:state:${state}`);
}

// Store session in KV
export async function storeSession(env: Env, sessionId: string, session: Session): Promise<void> {
  await env.SESSION_CACHE.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: 3600, // 1 hour
  });
}

// Get session from KV
export async function getSession(env: Env, sessionId: string): Promise<Session | null> {
  const data = await env.SESSION_CACHE.get(`session:${sessionId}`);
  if (!data) return null;
  return JSON.parse(data) as Session;
}

// Delete session from KV
export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.SESSION_CACHE.delete(`session:${sessionId}`);
}

// Get session from Authorization header
export async function getSessionFromRequest(request: Request, env: Env): Promise<Session | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const sessionId = authHeader.substring(7);
  return await getSession(env, sessionId);
}

// Update user's last active timestamp
export async function updateUserActivity(env: Env, did: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE users SET last_active_at = unixepoch() WHERE did = ?'
  ).bind(did).run();
}
