import { describe, it, expect, vi, afterEach } from 'vitest';
import { scanFollow, scanPublications } from './socialGraph';

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

describe('scanFollow', () => {
  afterEach(() => vi.restoreAllMocks());

  const PROFILE_LINK = (rkey: string) => `at://${DID}/app.bsky.actor.link/${rkey}`;

  function stub(byCollection: Record<string, unknown>, profile: unknown) {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://plc.directory/')) {
        return new Response(
          JSON.stringify({ service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] }),
          { status: 200 }
        );
      }
      const params = new URL(url).searchParams;
      if (url.includes('com.atproto.repo.getRecord')) {
        return new Response(JSON.stringify(profile), { status: profile ? 200 : 400 });
      }
      const records = byCollection[params.get('collection') ?? ''] ?? [];
      return new Response(JSON.stringify({ records }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('keeps the links a Bluesky profile shows, in its order, then Sifa websites', async () => {
    stub(
      {
        'app.bsky.actor.link': [
          { uri: PROFILE_LINK('a'), value: { url: 'https://first.example', title: 'Blog' } },
          { uri: PROFILE_LINK('b'), value: { url: 'https://second.example' } },
          // Not on the profile: removed from it, so not shown.
          { uri: PROFILE_LINK('c'), value: { url: 'https://hidden.example' } },
          { uri: PROFILE_LINK('d'), value: { url: 'javascript:alert(1)' } },
        ],
        'id.sifa.profile.externalAccount': [
          { value: { platform: 'id.sifa.defs#platformWebsite', url: 'https://someone.example' } },
          {
            value: {
              platform: 'id.sifa.defs#platformRss',
              url: 'https://blog.example',
              feedUrl: 'https://blog.example/feed.xml',
              label: 'Blog',
            },
          },
          { value: { platform: 'id.sifa.defs#platformGithub', url: 'https://github.com/someone' } },
        ],
      },
      {
        value: {
          links: [
            { uri: PROFILE_LINK('b'), cid: 'x' },
            { uri: PROFILE_LINK('d'), cid: 'x' },
            { uri: PROFILE_LINK('a'), cid: 'x' },
          ],
        },
      }
    );

    const { profileLinks } = await scanFollow(FOLLOW);
    expect(profileLinks).toEqual([
      { source: 'bluesky', url: 'https://second.example', label: undefined },
      { source: 'bluesky', url: 'https://first.example', label: 'Blog' },
      { source: 'sifa', url: 'https://someone.example', feedUrl: undefined, label: undefined },
      {
        source: 'sifa',
        url: 'https://blog.example',
        feedUrl: 'https://blog.example/feed.xml',
        label: 'Blog',
      },
    ]);
  });

  it('skips the link list when the profile shows none', async () => {
    stub({}, { value: { description: 'no links' } });
    const { profileLinks } = await scanFollow(FOLLOW);
    expect(profileLinks).toEqual([]);
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some(([u]) => String(u).includes('app.bsky.actor.link'))).toBe(false);
  });
});
