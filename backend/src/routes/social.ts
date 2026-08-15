import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { resolvePdsUrl } from '../utils/did-resolver';

function isValidDid(did: string): boolean {
  return typeof did === 'string' && did.startsWith('did:');
}

// GET /api/social/detect-content?did={did} - Detect available content for a user
export async function handleDetectContent(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const did = url.searchParams.get('did');

  if (!did || !isValidDid(did)) {
    return new Response(JSON.stringify({ error: 'Valid did parameter is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const pdsUrl = await resolvePdsUrl(did);
    if (!pdsUrl) {
      return new Response(JSON.stringify({ did, publications: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Query PDS for the user's publications
    const pubResponse = await fetch(
      `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({
        repo: did,
        collection: 'site.standard.publication',
        limit: '100',
      })}`
    );

    interface PublicationBlobRef {
      ref: { $link: string };
      mimeType: string;
    }

    interface PublicationRecord {
      name?: string;
      url?: string;
      description?: string;
      icon?: PublicationBlobRef;
    }

    let publications: Array<{
      uri: string;
      name: string;
      url: string;
      description?: string;
      iconUrl?: string;
    }> = [];
    if (pubResponse.ok) {
      const pubData = (await pubResponse.json()) as {
        records: Array<{ uri: string; value: PublicationRecord }>;
      };
      publications = pubData.records.map((r) => {
        // Resolve icon blob to CDN URL
        let iconUrl: string | undefined;
        if (r.value.icon?.ref?.$link) {
          iconUrl = `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${r.value.icon.ref.$link}@jpeg`;
        }
        return {
          uri: r.uri,
          name: (r.value as PublicationRecord).name || '',
          url: (r.value as PublicationRecord).url || '',
          description: (r.value as PublicationRecord).description,
          iconUrl,
        };
      });
    }

    return new Response(JSON.stringify({ did, publications }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Detect content error:', error);
    return new Response(JSON.stringify({ error: 'Failed to detect content' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
