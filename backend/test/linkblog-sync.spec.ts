import { describe, it, expect } from 'vitest';
import {
  buildLinkblogDocument,
  contentFormatOf,
  noteToLeafletBlocks,
  replaceItemsNoteRegion,
  replaceLeafletNoteRegion,
  replaceMarkpubNote,
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
          block: { $type: string; src?: string; plaintext?: string; description?: string };
        }>;
      }>;
    };
    expect(content.$type).toBe('pub.leaflet.content');
    const blocks = content.pages[0].blocks.map((b) => b.block);
    const text = blocks.find((b) => b.$type === 'pub.leaflet.blocks.text');
    const website = blocks.find((b) => b.$type === 'pub.leaflet.blocks.website');
    expect(text?.plaintext).toBe('Worth reading.');
    // `src`, not `url` — the field pub.leaflet.blocks.website requires. A card
    // without it fails Leaflet's record validation and the post never indexes.
    expect(website?.src).toBe('https://example.com/the-article');
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

  it('closes a pckt post with its flat website card', () => {
    const pckt = buildLinkblogDocument(DID, RKEY, input, undefined, target, 'pckt').content as {
      items: Array<{ $type: string; src?: string; attrs?: unknown }>;
    };
    const card = pckt.items.at(-1);
    // Top level, not nested under `attrs` — the shape pckt's lexicon requires and
    // its own posts use.
    expect(card?.$type).toBe('blog.pckt.block.website');
    expect(card?.src).toBe(input.articleUrl);
    expect(card?.attrs).toBeUndefined();
  });

  it('closes an Offprint post with its native bookmark card, not a text line', () => {
    const offprint = buildLinkblogDocument(DID, RKEY, input, undefined, target, 'offprint')
      .content as { items: Array<{ $type: string; href?: string; title?: string }> };
    const card = offprint.items.at(-1);
    // `href`, and a title that's required rather than optional.
    expect(card?.$type).toBe('app.offprint.block.webBookmark');
    expect(card?.href).toBe(input.articleUrl);
    expect(card?.title).toBe(input.articleTitle);
  });

  it('declares the flavor and text type markpub asks a writer to state', () => {
    const markpub = buildLinkblogDocument(DID, RKEY, input, undefined, target, 'markpub').content;
    expect(markpub).toMatchObject({
      $type: 'at.markpub.markdown',
      flavor: 'commonmark',
      text: { $type: 'at.markpub.text', markdown: expect.stringContaining(input.articleUrl) },
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
          { block: { $type: 'pub.leaflet.blocks.website', src: 'https://example.com' } },
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

// Editing a note on a connected publication has to round-trip through that
// publication's own content shape — otherwise the edit affordance is a dead end
// for three of the four supported formats.
describe('contentFormatOf', () => {
  it.each([
    ['pub.leaflet.content', 'leaflet'],
    ['blog.pckt.content', 'pckt'],
    ['app.offprint.content', 'offprint'],
    ['at.markpub.markdown', 'markpub'],
  ] as const)('maps %s', (type, format) => {
    expect(contentFormatOf({ $type: type })).toBe(format);
  });

  it('returns null for a shape we cannot rewrite', () => {
    expect(contentFormatOf({ $type: 'com.example.content' })).toBeNull();
    expect(contentFormatOf(undefined)).toBeNull();
  });
});

// The composer drops the cursor directly under the seeded `> quote`, so a note
// whose quote and commentary aren't separated by a blank line is the ordinary
// case, not an edge one. The block-item formats used to split on blank lines
// alone, which folded the commentary into the quote (or, in the reverse order,
// stripped the quote's markers and published it as prose).
describe('note runs in the block-item formats', () => {
  const ARTICLE_URL = 'https://example.com/the-article';
  const build = (format: 'pckt' | 'offprint', note: string) =>
    (
      buildLinkblogDocument(
        DID,
        RKEY,
        { articleUrl: ARTICLE_URL, articleTitle: 'The Article', note },
        undefined,
        publicationUri(DID),
        format
      ).content as { items: Array<{ $type: string; plaintext?: string; content?: unknown[] }> }
    ).items;

  for (const format of ['pckt', 'offprint'] as const) {
    const prefix = format === 'pckt' ? 'blog.pckt.block.' : 'app.offprint.block.';
    const card = format === 'pckt' ? `${prefix}website` : `${prefix}webBookmark`;

    it(`${format}: a quote followed by commentary on the next line stays two blocks`, () => {
      const items = build(format, '> A quoted sentence.\nMy commentary.');
      expect(items.map((i) => i.$type)).toEqual([`${prefix}blockquote`, `${prefix}text`, card]);
      expect(items[0].content).toEqual([
        { $type: `${prefix}text`, plaintext: 'A quoted sentence.' },
      ]);
      expect(items[1].plaintext).toBe('My commentary.');
    });

    it(`${format}: commentary followed by a quote on the next line keeps the quote`, () => {
      const items = build(format, 'My commentary.\n> A quoted sentence.');
      expect(items.map((i) => i.$type)).toEqual([`${prefix}text`, `${prefix}blockquote`, card]);
      expect(items[0].plaintext).toBe('My commentary.');
      expect(items[1].content).toEqual([
        { $type: `${prefix}text`, plaintext: 'A quoted sentence.' },
      ]);
    });

    it(`${format}: a multiline quote stays one block with its markers stripped`, () => {
      const items = build(format, '> line one\n> line two\n\nAfter.');
      expect(items.map((i) => i.$type)).toEqual([`${prefix}blockquote`, `${prefix}text`, card]);
      expect(items[0].content).toEqual([
        { $type: `${prefix}text`, plaintext: 'line one\nline two' },
      ]);
    });
  }
});

describe('replaceItemsNoteRegion', () => {
  const ARTICLE = { url: 'https://example.com/post', title: 'Post' };

  it('swaps the pckt note items and keeps the website card', () => {
    const existing = {
      $type: 'blog.pckt.content',
      items: [
        { $type: 'blog.pckt.block.text', plaintext: 'old' },
        { $type: 'blog.pckt.block.website', src: ARTICLE.url },
      ],
    };
    const content = replaceItemsNoteRegion(existing, 'pckt', 'new\n\n> quote', ARTICLE) as {
      items: Array<{ $type: string; plaintext?: string }>;
    };
    expect(content.items.map((i) => i.$type)).toEqual([
      'blog.pckt.block.text',
      'blog.pckt.block.blockquote',
      'blog.pckt.block.website',
    ]);
    expect(content.items[0].plaintext).toBe('new');
  });

  it("keeps Offprint's link card and swaps only the note above it", () => {
    const existing = {
      $type: 'app.offprint.content',
      items: [
        { $type: 'app.offprint.block.text', plaintext: 'old' },
        { $type: 'app.offprint.block.webBookmark', href: ARTICLE.url, title: 'Post' },
      ],
    };
    const content = replaceItemsNoteRegion(existing, 'offprint', 'new', ARTICLE) as {
      items: Array<{ $type: string; plaintext?: string }>;
    };
    expect(content.items.map((i) => i.$type)).toEqual([
      'app.offprint.block.text',
      'app.offprint.block.webBookmark',
    ]);
    expect(content.items[0].plaintext).toBe('new');
  });

  // Shares written before Offprint's native card was used put the article in a
  // trailing text line; editing one must still not swallow it into the note.
  it('keeps a legacy Offprint article line, which is itself a text block', () => {
    const existing = {
      $type: 'app.offprint.content',
      items: [
        { $type: 'app.offprint.block.text', plaintext: 'old' },
        { $type: 'app.offprint.block.text', plaintext: `Post — ${ARTICLE.url}` },
      ],
    };
    const content = replaceItemsNoteRegion(existing, 'offprint', 'new', ARTICLE) as {
      items: Array<{ plaintext?: string }>;
    };
    expect(content.items.map((i) => i.plaintext)).toEqual(['new', `Post — ${ARTICLE.url}`]);
  });

  it('clearing the note leaves only the article block', () => {
    const existing = {
      $type: 'blog.pckt.content',
      items: [
        { $type: 'blog.pckt.block.blockquote', content: [] },
        { $type: 'blog.pckt.block.website', src: ARTICLE.url },
      ],
    };
    const content = replaceItemsNoteRegion(existing, 'pckt', '', ARTICLE) as {
      items: Array<{ $type: string }>;
    };
    expect(content.items.map((i) => i.$type)).toEqual(['blog.pckt.block.website']);
  });
});

describe('replaceMarkpubNote', () => {
  const ARTICLE = { url: 'https://example.com/post', title: 'Post' };

  it('rewrites the prose and keeps the trailing article link verbatim', () => {
    const existing = {
      $type: 'at.markpub.markdown',
      text: { markdown: `old note\n\n[Post](${ARTICLE.url})` },
    };
    const content = replaceMarkpubNote(existing, 'new note', ARTICLE) as {
      text: { markdown: string };
    };
    expect(content.text.markdown).toBe(`new note\n\n[Post](${ARTICLE.url})`);
  });

  it('rebuilds the article link when the stored markdown has lost it', () => {
    const content = replaceMarkpubNote(
      { $type: 'at.markpub.markdown', text: { markdown: 'old note' } },
      'new note',
      ARTICLE
    ) as { text: { markdown: string } };
    expect(content.text.markdown).toBe(`new note\n\n[Post](${ARTICLE.url})`);
  });
});
