/**
 * Utility functions for resolving DIDs to PDS URLs and atproto signing keys.
 */

// PLC directory for DID resolution
const PLC_DIRECTORY = 'https://plc.directory';

interface DidDocument {
  id: string;
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
  verificationMethod?: Array<{
    id: string;
    type: string;
    controller?: string;
    publicKeyMultibase?: string;
  }>;
}

/**
 * Resolve a `did:web` identifier to the `https` URL of its DID document, or null if the
 * host isn't a safe, public domain. This is an SSRF guard: the host comes straight from an
 * attacker-controllable DID (e.g. the issuer of a service-auth JWT), so we must not let it
 * point fetch() at internal infrastructure.
 *
 * atproto `did:web` identities are bare, public domains. We therefore reject:
 *   - path-form did:web (extra `:`-separated segments) — unused by atproto identities,
 *   - ports / IPv6 literals (anything with a `:` after percent-decoding),
 *   - IPv4 literals (e.g. 169.254.169.254, 127.0.0.1, 10.x — the classic SSRF targets),
 *   - localhost and internal TLDs (.local / .internal / .lan),
 *   - anything without a dot (not a real public domain).
 */
function didWebToDocUrl(did: string): string | null {
  const raw = did.slice('did:web:'.length);
  // A literal ':' here is a path-form separator (a port would be percent-encoded as %3A).
  if (!raw || raw.includes(':')) return null;

  let host: string;
  try {
    host = decodeURIComponent(raw).toLowerCase();
  } catch {
    return null; // malformed percent-encoding
  }

  if (!host || host.includes(':')) return null; // empty, ported, or IPv6 literal
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null; // IPv4 literal
  if (!host.includes('.')) return null; // not a public domain

  return `https://${host}/.well-known/did.json`;
}

/**
 * Fetch and parse a DID document for did:plc or did:web.
 */
async function fetchDidDocument(did: string): Promise<DidDocument | null> {
  if (did.startsWith('did:plc:')) {
    const response = await fetch(`${PLC_DIRECTORY}/${did}`);
    if (!response.ok) return null;
    return (await response.json()) as DidDocument;
  } else if (did.startsWith('did:web:')) {
    const docUrl = didWebToDocUrl(did);
    if (!docUrl) return null;
    // Don't follow redirects: didWebToDocUrl only vetted the literal host, so a redirect
    // could send us to an internal address (e.g. 169.254.169.254) and defeat the SSRF
    // guard. Treat any 3xx as a resolution failure.
    const response = await fetch(docUrl, { redirect: 'manual' });
    if (!response.ok) return null;
    return (await response.json()) as DidDocument;
  }
  return null;
}

/**
 * Resolve a DID to get the user's PDS URL
 */
export async function resolvePdsUrl(did: string): Promise<string | null> {
  try {
    const doc = await fetchDidDocument(did);
    const pdsService = doc?.service?.find(
      (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
    );
    return pdsService?.serviceEndpoint || null;
  } catch (error) {
    console.error(`[did-resolver] Failed to resolve PDS URL for ${did}:`, error);
    return null;
  }
}

/**
 * Resolve a DID to its atproto signing key (the `#atproto` verification method's
 * publicKeyMultibase — a Multikey/base58btc-encoded compressed public key). Used to
 * verify atproto service-auth JWTs. Returns null if the DID or key can't be resolved.
 */
export async function resolveAtprotoSigningKey(did: string): Promise<string | null> {
  try {
    const doc = await fetchDidDocument(did);
    const vm = doc?.verificationMethod?.find((v) => v.id.endsWith('#atproto'));
    return vm?.publicKeyMultibase || null;
  } catch (error) {
    console.error(`[did-resolver] Failed to resolve signing key for ${did}:`, error);
    return null;
  }
}
