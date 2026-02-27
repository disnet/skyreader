/**
 * Utility functions for resolving DIDs to PDS URLs and other AT Protocol operations
 */

// PLC directory for DID resolution
const PLC_DIRECTORY = 'https://plc.directory';

interface DidDocument {
  id: string;
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

/**
 * Resolve a DID to get the user's PDS URL
 */
export async function resolvePdsUrl(did: string): Promise<string | null> {
  try {
    if (did.startsWith('did:plc:')) {
      const response = await fetch(`${PLC_DIRECTORY}/${did}`);
      if (!response.ok) return null;
      const doc = (await response.json()) as DidDocument;
      const pdsService = doc.service?.find(
        (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
      );
      return pdsService?.serviceEndpoint || null;
    } else if (did.startsWith('did:web:')) {
      // For did:web, the PDS URL is derived from the DID
      const domain = did.replace('did:web:', '');
      const response = await fetch(`https://${domain}/.well-known/did.json`);
      if (!response.ok) return null;
      const doc = (await response.json()) as DidDocument;
      const pdsService = doc.service?.find(
        (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
      );
      return pdsService?.serviceEndpoint || null;
    }
    return null;
  } catch (error) {
    console.error(`[did-resolver] Failed to resolve PDS URL for ${did}:`, error);
    return null;
  }
}
