import { describe, expect, it } from 'vitest';
import type { SocialDocument } from '$lib/types';
import { getLinkPostNote } from './linkPost';

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
