// Identity + publication-metadata lookups for the public linkblog. All best-effort
// and read-only: a public page loader stays fast and degrades to profile defaults.

import { PUBLICATION_COLLECTION, LINKBLOG_RKEY } from '$lib/fields';
import type { Profile, PublicationMeta } from '$lib/types';

// Resolve a handle to a DID via the Bluesky public AppView. Returns null if it
// can't be resolved (we don't fall back to DNS/well-known here — the AppView
// covers the overwhelming majority).
export async function resolveHandleToDid(handle: string): Promise<string | null> {
  const normalized = handle.trim().replace(/^@/, '').toLowerCase();
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(normalized)}`
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { did?: string };
    return data.did ?? null;
  } catch {
    return null;
  }
}

// Fetch a profile (display name, handle, avatar) from the Bluesky AppView. Used
// for the page header and as the source of the default linkblog name/icon.
export async function getProfile(actor: string): Promise<Profile | null> {
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      did: string;
      handle?: string;
      displayName?: string;
      avatar?: string;
      description?: string;
    };
    return {
      did: data.did,
      handle: data.handle,
      displayName: data.displayName,
      avatar: data.avatar,
      description: data.description,
    };
  } catch {
    return null;
  }
}

interface DidDocService {
  id: string;
  type: string;
  serviceEndpoint: string;
}

function pdsFromServices(services: DidDocService[] | undefined): string | null {
  const pds = services?.find(
    (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
  );
  return pds?.serviceEndpoint ?? null;
}

async function resolvePdsUrl(did: string): Promise<string | null> {
  try {
    if (did.startsWith('did:plc:')) {
      const res = await fetch(`https://plc.directory/${did}`);
      if (!res.ok) return null;
      const doc = (await res.json()) as { service?: DidDocService[] };
      return pdsFromServices(doc.service);
    }
    if (did.startsWith('did:web:')) {
      const domain = did.slice('did:web:'.length).replace(/:/g, '/');
      const res = await fetch(`https://${domain}/.well-known/did.json`);
      if (!res.ok) return null;
      const doc = (await res.json()) as { service?: DidDocService[] };
      return pdsFromServices(doc.service);
    }
    return null;
  } catch {
    return null;
  }
}

// Read the user's linkblog publication record (if it exists yet) for a customized
// name/description/icon. Falls back silently — when the record is absent the page
// renders fine from the profile defaults.
export async function fetchPublicationMeta(did: string): Promise<PublicationMeta | null> {
  const pdsUrl = await resolvePdsUrl(did);
  if (!pdsUrl) return null;
  try {
    const params = new URLSearchParams({
      repo: did,
      collection: PUBLICATION_COLLECTION,
      rkey: LINKBLOG_RKEY,
    });
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      value?: {
        name?: string;
        description?: string;
        icon?: { ref?: { $link?: string } };
      };
    };
    const value = data.value;
    if (!value) return null;
    const iconCid = value.icon?.ref?.$link;
    return {
      name: value.name,
      description: value.description,
      icon: iconCid ? `https://cdn.bsky.app/img/avatar/plain/${did}/${iconCid}@jpeg` : undefined,
    };
  } catch {
    return null;
  }
}
