import { describe, expect, it } from 'vitest';
import type { SocialDocument } from '$lib/types';
import { buildOptimisticLinkPost, getLinkPostNote, isSkyreaderShare } from './linkPost';

const ARTICLE = 'https://example.com/post';

function doc(content: unknown): SocialDocument {
  return {
    authorDid: 'did:plc:someone',
    recordUri: 'at://did:plc:someone/site.standard.document/3kabcdefghijk',
    siteUri: 'at://did:plc:someone/site.standard.publication/my-leaflet',
    title: 'Post',
    publishedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    links: [{ uri: ARTICLE, rel: 'related' }],
    content,
  } as SocialDocument;
}

// A linkblog connected to an existing publication writes its notes in that
// publication's own content lexicon. Reading them back is what keeps the user's
// commentary visible on Skyreader's own surfaces.
describe('getLinkPostNote across connected publication formats', () => {
  it('reads a Leaflet note, quotes included', () => {
    const note = getLinkPostNote(
      doc({
        $type: 'pub.leaflet.content',
        pages: [
          {
            blocks: [
              { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'Worth reading.' } },
              { block: { $type: 'pub.leaflet.blocks.blockquote', plaintext: 'A quote' } },
              { block: { $type: 'pub.leaflet.blocks.website', url: ARTICLE } },
            ],
          },
        ],
      })
    );
    expect(note).toBe('Worth reading.\n\n> A quote');
  });

  it('reads a pckt note and stops at the website card', () => {
    const note = getLinkPostNote(
      doc({
        $type: 'blog.pckt.content',
        items: [
          { $type: 'blog.pckt.block.text', plaintext: 'Worth reading.' },
          {
            $type: 'blog.pckt.block.blockquote',
            content: [{ $type: 'blog.pckt.block.text', plaintext: 'A quote' }],
          },
          { $type: 'blog.pckt.block.website', attrs: { src: ARTICLE } },
        ],
      })
    );
    expect(note).toBe('Worth reading.\n\n> A quote');
  });

  it("stops at Offprint's trailing article line, which is itself a text block", () => {
    const note = getLinkPostNote(
      doc({
        $type: 'app.offprint.content',
        items: [
          { $type: 'app.offprint.block.text', plaintext: 'Worth reading.' },
          { $type: 'app.offprint.block.text', plaintext: `Post — ${ARTICLE}` },
        ],
      })
    );
    expect(note).toBe('Worth reading.');
  });

  it('reads a Markdown note without its trailing article link', () => {
    const note = getLinkPostNote(
      doc({
        $type: 'at.markpub.markdown',
        text: { markdown: `Worth reading.\n\n> A quote\n\n[Post](${ARTICLE})` },
      })
    );
    expect(note).toBe('Worth reading.\n\n> A quote');
  });

  it('returns undefined for a link post with no commentary', () => {
    expect(
      getLinkPostNote(
        doc({
          $type: 'blog.pckt.content',
          items: [{ $type: 'blog.pckt.block.website', attrs: { src: ARTICLE } }],
        })
      )
    ).toBeUndefined();
    expect(
      getLinkPostNote(
        doc({ $type: 'at.markpub.markdown', text: { markdown: `[Post](${ARTICLE})` } })
      )
    ).toBeUndefined();
  });

  it('ignores a content shape it does not know', () => {
    expect(getLinkPostNote(doc({ $type: 'com.example.content', items: [] }))).toBeUndefined();
  });
});

// The gate for every affordance that MUTATES a document: un-share/delete, the
// in-place note edit, and the "already shared" overlay. A connected publication
// carries its home app's own posts too, and an essay that links out is shaped
// exactly like a share — so "lives in my linkblog and has a link" must not be
// enough to offer Remove.
describe('isSkyreaderShare', () => {
  const MARKER = 'https://skyreader.app/linkblog';

  it('accepts a marked post in a connected publication', () => {
    expect(isSkyreaderShare({ ...doc(undefined), skyreaderLinkblog: MARKER })).toBe(true);
  });

  it('rejects an unmarked post in a connected publication', () => {
    expect(isSkyreaderShare(doc(undefined))).toBe(false);
  });

  it('accepts an unmarked post in the user’s own Skyreader publication', () => {
    expect(
      isSkyreaderShare({
        ...doc(undefined),
        siteUri: 'at://did:plc:someone/site.standard.publication/skyreader-links',
      })
    ).toBe(true);
  });

  it('rejects a marker that isn’t ours', () => {
    expect(
      isSkyreaderShare({ ...doc(undefined), skyreaderLinkblog: 'https://evil.example/linkblog' })
    ).toBe(false);
  });
});

// The optimistic document stands in for a share the proxy hasn't indexed yet. If
// it doesn't read as ours, the cross-device overlay drops it — and reconcile()
// takes "absent from the overlay" as "deleted elsewhere" and prunes the local
// row, un-sharing an article that is live in the user's PDS.
describe('buildOptimisticLinkPost', () => {
  const input = {
    recordUri: 'at://did:plc:someone/site.standard.document/3kabcdefghijk',
    siteUri: 'at://did:plc:someone/site.standard.publication/my-leaflet',
    articleUrl: ARTICLE,
    articleTitle: 'Post',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('reads as a Skyreader share even in a connected publication', () => {
    const optimistic = buildOptimisticLinkPost('did:plc:someone', input);
    expect(optimistic.skyreaderLinkblog).toBe('https://skyreader.app/linkblog');
    expect(isSkyreaderShare(optimistic)).toBe(true);
  });

  it('carries the article link and the note as Leaflet blocks', () => {
    const optimistic = buildOptimisticLinkPost('did:plc:someone', {
      ...input,
      note: 'Worth reading.',
    });
    expect(optimistic.links?.[0]?.uri).toBe(ARTICLE);
    expect(getLinkPostNote(optimistic)).toBe('Worth reading.');
  });
});
