import { describe, it, expect, vi, afterEach } from 'vitest';
import { scanPublications } from './socialGraph';

const DID = 'did:plc:someone';
const PDS = 'https://pds.example';
const FOLLOW = { did: DID, handle: 'someone.test', displayName: 'Someone' };

const publication = (rkey: string, value: Record<string, unknown>) => ({
  uri: `at://${DID}/site.standard.publication/${rkey}`,
  value: { url: `https://${rkey}.example/`, ...value },
});

// Answers the DID document, then the publication listing.
function stubPds(records: Array<{ uri: string; value: Record<string, unknown> }>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://plc.directory/')) {
      return new Response(
        JSON.stringify({ service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ records }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('scanPublications', () => {
  afterEach(() => vi.restoreAllMocks());

  // A Skyreader linkblog belongs to the Linkblogs section on /discover, so
  // listing it here too would show the same account twice. Publications minted
  // since the TID change each sit at their own rkey, so the marker — not the old
  // fixed rkey — is what identifies them.
  it('skips a linkblog minted at a TID, on its marker', async () => {
    stubPds([
      publication('3mstjk7sct22d', {
        name: 'My links',
        skyreaderLinkblog: 'https://skyreader.app/linkblog',
      }),
      publication('3mv4qfo5qj2zu', { name: 'An essay collection' }),
    ]);

    const out = await scanPublications(FOLLOW);
    expect(out.map((p) => p.name)).toEqual(['An essay collection']);
  });

  it('still skips a linkblog left at the legacy rkey', async () => {
    stubPds([
      // Created before the marker existed, so the rkey is the only tell.
      publication('skyreader-links', { name: 'My links' }),
      publication('3mv4qfo5qj2zu', { name: 'An essay collection' }),
    ]);

    const out = await scanPublications(FOLLOW);
    expect(out.map((p) => p.name)).toEqual(['An essay collection']);
  });
});
