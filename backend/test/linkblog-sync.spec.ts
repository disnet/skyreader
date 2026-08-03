import { describe, it, expect } from 'vitest';
import {
  buildLinkblogDocument,
  noteToLeafletBlocks,
  replaceLeafletNoteRegion,
  publicationUri,
  LINKBLOG_RKEY,
} from '../src/services/linkblog-sync';

const DID = 'did:plc:linkblogtest123';
const RKEY = '3kabcdefghijk';

// These assertions encode the contract with the feed-proxy parser
// (feed-proxy/src/standard-site.ts): it reads `site`, `title`, `path`,
// `description`, `textContent`, `tags`, `createdAt`, `content` from the raw
// record. If a field name drifts here, the linkblog stops round-tripping.
describe('buildLinkblogDocument', () => {
  const doc = buildLinkblogDocument(DID, RKEY, {
    articleUrl: 'https://example.com/the-article',
    articleTitle: 'The Article',
    excerpt: 'A generous first-paragraph excerpt.',
    note: 'Worth reading.',
    tags: ['design'],
  });

  it('is a site.standard.document scoped to the skyreader-links publication', () => {
    expect(doc.$type).toBe('site.standard.document');
    expect(doc.site).toBe(publicationUri(DID));
    expect(doc.site).toBe(`at://${DID}/site.standard.publication/${LINKBLOG_RKEY}`);
  });

  it('uses the rkey as its path for canonical-URL building', () => {
    expect(doc.path).toBe(`/${RKEY}`);
  });

  it('carries the external URL in the machine-readable links field', () => {
    expect(doc.links).toEqual([{ uri: 'https://example.com/the-article', rel: 'related' }]);
  });

  it('reserves the top-level description (the legacy-quote marker) and keeps the excerpt durable', () => {
    // The quote now lives inside the editable note, so new records leave the
    // top-level `description` unset — its presence marks a legacy record. The
    // excerpt stays durable in `textContent` (search) and on the website card.
    expect(doc.description).toBeUndefined();
    expect(doc.textContent).toContain('Worth reading.');
    expect(doc.textContent).toContain('A generous first-paragraph excerpt.');
  });

  it('builds a pub.leaflet body with a note text block and a website link-card carrying the excerpt', () => {
    const content = doc.content as {
      $type: string;
      pages: Array<{
        blocks: Array<{
          block: { $type: string; url?: string; plaintext?: string; description?: string };
        }>;
      }>;
    };
    expect(content.$type).toBe('pub.leaflet.content');
    const blocks = content.pages[0].blocks.map((b) => b.block);
    const text = blocks.find((b) => b.$type === 'pub.leaflet.blocks.text');
    const website = blocks.find((b) => b.$type === 'pub.leaflet.blocks.website');
    expect(text?.plaintext).toBe('Worth reading.');
    expect(website?.url).toBe('https://example.com/the-article');
    // The website card is the excerpt's durable home now that `description` is reserved.
    expect(website?.description).toBe('A generous first-paragraph excerpt.');
  });

  it('falls back to the URL as title and omits empty note block', () => {
    const bare = buildLinkblogDocument(DID, RKEY, {
      articleUrl: 'https://example.com/x',
    });
    expect(bare.title).toBe('https://example.com/x');
    const content = bare.content as {
      pages: Array<{ blocks: Array<{ block: { $type: string } }> }>;
    };
    const types = content.pages[0].blocks.map((b) => b.block.$type);
    expect(types).not.toContain('pub.leaflet.blocks.text');
    expect(types).toContain('pub.leaflet.blocks.website');
  });
});

describe('connected publication formats', () => {
  const target = `at://${DID}/site.standard.publication/existing`;
  const input = { articleUrl: 'https://example.com/post', articleTitle: 'Post', note: 'A note' };

  it.each([
    ['pckt', 'blog.pckt.content'],
    ['offprint', 'app.offprint.content'],
    ['markpub', 'at.markpub.markdown'],
  ] as const)('writes %s content while preserving the selected site URI', (format, type) => {
    const doc = buildLinkblogDocument(DID, RKEY, input, undefined, target, format);
    expect(doc.site).toBe(target);
    expect(doc.content).toMatchObject({ $type: type });
    expect(doc.links).toEqual([{ uri: input.articleUrl, rel: 'related' }]);
  });

  it('uses the observed pckt website attrs and markpub text wrapper shapes', () => {
    const pckt = buildLinkblogDocument(DID, RKEY, input, undefined, target, 'pckt').content as {
      items: Array<{ $type: string; attrs?: { src?: string } }>;
    };
    expect(pckt.items.at(-1)?.attrs?.src).toBe(input.articleUrl);
    const markpub = buildLinkblogDocument(DID, RKEY, input, undefined, target, 'markpub').content;
    expect(markpub).toMatchObject({
      text: { markdown: expect.stringContaining(input.articleUrl) },
    });
  });
});

describe('noteToLeafletBlocks', () => {
  it('converts mixed commentary and multiline quotes into ordered native blocks', () => {
    const blocks = noteToLeafletBlocks('Before\n\n> first\n> second\n>\n> fourth\n\nAfter');
    expect(blocks.map(({ block }) => [block.$type, block.plaintext])).toEqual([
      ['pub.leaflet.blocks.text', 'Before'],
      ['pub.leaflet.blocks.blockquote', 'first\nsecond\n\nfourth'],
      ['pub.leaflet.blocks.text', 'After'],
    ]);
  });

  it('supports quote-only and multiple separated quote runs without empty blocks', () => {
    const blocks = noteToLeafletBlocks('  \n> one\n\nComment\n\n>two\n  ');
    expect(blocks.map(({ block }) => [block.$type, block.plaintext])).toEqual([
      ['pub.leaflet.blocks.blockquote', 'one'],
      ['pub.leaflet.blocks.text', 'Comment'],
      ['pub.leaflet.blocks.blockquote', 'two'],
    ]);
  });

  it('does not interpret greater-than characters away from line start', () => {
    expect(noteToLeafletBlocks('one > two')[0].block).toMatchObject({
      $type: 'pub.leaflet.blocks.text',
      plaintext: 'one > two',
    });
  });

  it('rebases Unicode mention facets to each marker-stripped block', () => {
    const blocks = noteToLeafletBlocks(
      'é @text.test\n> ü @quote.test',
      new Map([
        ['text.test', 'did:plc:text'],
        ['quote.test', 'did:plc:quote'],
      ])
    );
    expect(blocks[0].block.facets).toMatchObject([{ index: { byteStart: 3, byteEnd: 13 } }]);
    expect(blocks[1].block.facets).toMatchObject([{ index: { byteStart: 3, byteEnd: 14 } }]);
  });
});

describe('replaceLeafletNoteRegion', () => {
  const existing = {
    $type: 'pub.leaflet.content',
    pages: [
      {
        $type: 'pub.leaflet.pages.linearDocument',
        blocks: [
          { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'old' } },
          { block: { $type: 'pub.leaflet.blocks.blockquote', plaintext: 'old quote' } },
          { block: { $type: 'pub.leaflet.blocks.website', url: 'https://example.com' } },
          { block: { $type: 'pub.leaflet.blocks.image', image: { ref: { $link: 'cid' } } } },
        ],
      },
    ],
  };

  it('replaces every leading note block and preserves the website and trailing blocks', () => {
    const content = replaceLeafletNoteRegion(existing, 'new\n> quote') as typeof existing;
    expect(content.pages[0].blocks.map(({ block }) => block.$type)).toEqual([
      'pub.leaflet.blocks.text',
      'pub.leaflet.blocks.blockquote',
      'pub.leaflet.blocks.website',
      'pub.leaflet.blocks.image',
    ]);
  });

  it('clearing a note removes both old note block types', () => {
    const content = replaceLeafletNoteRegion(existing, '') as typeof existing;
    expect(content.pages[0].blocks.map(({ block }) => block.$type)).toEqual([
      'pub.leaflet.blocks.website',
      'pub.leaflet.blocks.image',
    ]);
  });
});
