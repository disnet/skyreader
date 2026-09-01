import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTION_TEXT,
  buildLinkblogDocument,
  contentFormatOf,
  formattingFromRow,
  noteToLeafletBlocks,
  replaceItemsNoteRegion,
  replaceLeafletNoteRegion,
  replaceMarkpubNote,
  publicationUri,
  stripTitleDecoration,
  websiteCardMeta,
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
    expect(bare.title).toBe('🔗 https://example.com/x');
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

  it('gives a pckt post its flat website card', () => {
    const pckt = buildLinkblogDocument(DID, RKEY, input, undefined, target, 'pckt').content as {
      items: Array<{ $type: string; src?: string; attrs?: unknown }>;
    };
    const card = pckt.items.find((i) => i.$type === 'blog.pckt.block.website');
    // Top level, not nested under `attrs` — the shape pckt's lexicon requires and
    // its own posts use.
    expect(card).toBeDefined();
    expect(card?.src).toBe(input.articleUrl);
    expect(card?.attrs).toBeUndefined();
  });

  it('gives an Offprint post its native bookmark card, not a text line', () => {
    const offprint = buildLinkblogDocument(DID, RKEY, input, undefined, target, 'offprint')
      .content as { items: Array<{ $type: string; href?: string; title?: string }> };
    const card = offprint.items.find((i) => i.$type === 'app.offprint.block.webBookmark');
    // `href`, and a title that's required rather than optional.
    expect(card).toBeDefined();
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

    // The card lands between the quote and the commentary under the default
    // 'context' layout — the reader meets what's being responded to before the
    // response.
    it(`${format}: a quote followed by commentary on the next line stays two blocks`, () => {
      const items = build(format, '> A quoted sentence.\nMy commentary.');
      expect(items.map((i) => i.$type)).toEqual([`${prefix}blockquote`, card, `${prefix}text`]);
      expect(items[0].content).toEqual([
        { $type: `${prefix}text`, plaintext: 'A quoted sentence.' },
      ]);
      expect(items[2].plaintext).toBe('My commentary.');
    });

    it(`${format}: commentary followed by a quote on the next line keeps the quote`, () => {
      const items = build(format, 'My commentary.\n> A quoted sentence.');
      // Nothing is quoted up front, so the card leads instead.
      expect(items.map((i) => i.$type)).toEqual([card, `${prefix}text`, `${prefix}blockquote`]);
      expect(items[1].plaintext).toBe('My commentary.');
      expect(items[2].content).toEqual([
        { $type: `${prefix}text`, plaintext: 'A quoted sentence.' },
      ]);
    });

    it(`${format}: a multiline quote stays one block with its markers stripped`, () => {
      const items = build(format, '> line one\n> line two\n\nAfter.');
      expect(items.map((i) => i.$type)).toEqual([`${prefix}blockquote`, card, `${prefix}text`]);
      expect(items[0].content).toEqual([
        { $type: `${prefix}text`, plaintext: 'line one\nline two' },
      ]);
    });
  }
});

// ── Formatting preferences ───────────────────────────────────────────────────
//
// The two answers to the external-formatting feedback are per-user settings with
// new defaults, not hardcoded changes: 'link' + 'context'.

describe('title style', () => {
  const input = { articleUrl: 'https://example.com/a', articleTitle: 'The Article' };
  const titleFor = (style: 'link' | 'quoted' | 'plain') =>
    buildLinkblogDocument(DID, RKEY, input, undefined, publicationUri(DID), 'leaflet', {
      titleStyle: style,
      cardPosition: 'context',
    }).title;

  it('decorates the document title so a link post is not a repost of the article', () => {
    expect(titleFor('link')).toBe('🔗 The Article');
    expect(titleFor('quoted')).toBe('“The Article”');
    expect(titleFor('plain')).toBe('The Article');
  });

  it('leaves the website card title plain whatever the document title says', () => {
    const content = buildLinkblogDocument(
      DID,
      RKEY,
      input,
      undefined,
      publicationUri(DID),
      'leaflet',
      { titleStyle: 'link', cardPosition: 'context' }
    ).content as { pages: Array<{ blocks: Array<{ block: { $type: string; title?: string } }> }> };
    const card = content.pages[0].blocks.find(
      (b) => b.block.$type === 'pub.leaflet.blocks.website'
    );
    expect(card?.block.title).toBe('The Article');
  });

  it('round-trips through stripTitleDecoration', () => {
    expect(stripTitleDecoration('🔗 The Article')).toBe('The Article');
    expect(stripTitleDecoration('“The Article”')).toBe('The Article');
    expect(stripTitleDecoration('The Article')).toBe('The Article');
    // A title the author really did wrap in straight quotes is left alone.
    expect(stripTitleDecoration('"Quoted" for real')).toBe('"Quoted" for real');
  });
});

describe('card position', () => {
  const NOTE = '> A quoted sentence.\n\nMy commentary.';
  const blocksFor = (cardPosition: 'context' | 'top' | 'bottom', note = NOTE) =>
    (
      buildLinkblogDocument(
        DID,
        RKEY,
        { articleUrl: 'https://example.com/a', articleTitle: 'A', note },
        undefined,
        publicationUri(DID),
        'leaflet',
        { titleStyle: 'link', cardPosition }
      ).content as { pages: Array<{ blocks: Array<{ block: { $type: string } }> }> }
    ).pages[0].blocks.map((b) => b.block.$type);

  it('puts the card between the quote and the commentary by default', () => {
    expect(blocksFor('context')).toEqual([
      'pub.leaflet.blocks.blockquote',
      'pub.leaflet.blocks.website',
      'pub.leaflet.blocks.text',
    ]);
  });

  it('leads with the card when nothing is quoted', () => {
    expect(blocksFor('context', 'Just commentary.')).toEqual([
      'pub.leaflet.blocks.website',
      'pub.leaflet.blocks.text',
    ]);
  });

  it('honors top and bottom', () => {
    expect(blocksFor('top')[0]).toBe('pub.leaflet.blocks.website');
    expect(blocksFor('bottom').at(-1)).toBe('pub.leaflet.blocks.website');
  });

  it('splits markpub markdown around the link line', () => {
    const markpub = (cardPosition: 'context' | 'top' | 'bottom') =>
      (
        buildLinkblogDocument(
          DID,
          RKEY,
          { articleUrl: 'https://example.com/a', articleTitle: 'A', note: NOTE },
          undefined,
          publicationUri(DID),
          'markpub',
          { titleStyle: 'link', cardPosition }
        ).content as { text: { markdown: string } }
      ).text.markdown;
    expect(markpub('context')).toBe(
      '> A quoted sentence.\n\n[A](https://example.com/a)\n\nMy commentary.'
    );
    // With the link at either end the note text is emitted verbatim.
    expect(markpub('bottom')).toBe(`${NOTE}\n\n[A](https://example.com/a)`);
    expect(markpub('top')).toBe(`[A](https://example.com/a)\n\n${NOTE}`);
  });
});

describe('attribution', () => {
  const input = {
    articleUrl: 'https://example.com/a',
    articleTitle: 'A',
    note: '> Quoted.\n\nMine.',
    attribution: true,
  };

  it('is opt-in and absent by default', () => {
    const doc = buildLinkblogDocument(DID, RKEY, { ...input, attribution: undefined });
    expect(doc.skyreaderAttribution).toBeUndefined();
    expect(JSON.stringify(doc.content)).not.toContain(ATTRIBUTION_TEXT);
  });

  it.each(['leaflet', 'pckt', 'offprint', 'markpub'] as const)(
    'appends a trailing %s attribution block and stamps the flag',
    (format) => {
      const doc = buildLinkblogDocument(DID, RKEY, input, undefined, publicationUri(DID), format, {
        titleStyle: 'link',
        cardPosition: 'context',
      });
      expect(doc.skyreaderAttribution).toBe(true);
      const content = doc.content as {
        pages?: Array<{ blocks: Array<{ block: { plaintext?: string } }> }>;
        items?: Array<{ plaintext?: string }>;
        text?: { markdown: string };
      };
      const last =
        content.pages?.[0].blocks.at(-1)?.block.plaintext ??
        content.items?.at(-1)?.plaintext ??
        content.text?.markdown.split('\n').at(-1);
      expect(last).toBe(ATTRIBUTION_TEXT);
      // The user's words + excerpt are what textContent is for; the attribution
      // is ours and stays out of it.
      expect(doc.textContent ?? '').not.toContain(ATTRIBUTION_TEXT);
    }
  );

  it('survives a note edit without being duplicated', () => {
    const doc = buildLinkblogDocument(DID, RKEY, input);
    const edited = replaceLeafletNoteRegion(
      doc.content,
      '> Quoted.\n\nRevised.',
      undefined,
      doc.skyreaderAttribution === true
    ) as {
      pages: Array<{ blocks: Array<{ block: { $type: string; plaintext?: string } }> }>;
    };
    const plaintexts = edited.pages[0].blocks.map((b) => b.block.plaintext);
    expect(plaintexts.filter((t) => t === ATTRIBUTION_TEXT)).toHaveLength(1);
    expect(edited.pages[0].blocks.at(-1)?.block.plaintext).toBe(ATTRIBUTION_TEXT);
    // …and the note the reader sees never contains it.
    expect(plaintexts).toContain('Revised.');
  });
});

// The attribution sentence is only OURS when the record says so. Without the flag
// an identical last line is the author's own words: an edit rebuilds it from the
// submitted note like any other line — it must not be lifted out and re-appended
// (which duplicated the sentence), and deleting it from the note must delete it.
describe("an author's own attribution-shaped line", () => {
  const ARTICLE = { url: 'https://example.com/post', title: 'Post' };
  const CARD = { $type: 'pub.leaflet.blocks.website', src: ARTICLE.url, title: 'Post' };
  const NOTE = `Worth reading.\n\n${ATTRIBUTION_TEXT}`;

  it('is kept once, not duplicated, when a leaflet note is edited', () => {
    const existing = {
      $type: 'pub.leaflet.content',
      pages: [
        {
          $type: 'pub.leaflet.pages.linearDocument',
          blocks: [
            { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'Worth reading.' } },
            { block: { $type: 'pub.leaflet.blocks.text', plaintext: ATTRIBUTION_TEXT } },
            { block: CARD },
          ],
        },
      ],
    };
    const edited = replaceLeafletNoteRegion(existing, NOTE) as {
      pages: Array<{ blocks: Array<{ block: { $type: string; plaintext?: string } }> }>;
    };
    const plaintexts = edited.pages[0].blocks.map((b) => b.block.plaintext);
    expect(plaintexts.filter((t) => t === ATTRIBUTION_TEXT)).toHaveLength(1);
    // The card still closes the post: the author's line is note text, so the
    // layout the record was written in is unchanged.
    expect(edited.pages[0].blocks.at(-1)?.block.$type).toBe('pub.leaflet.blocks.website');
  });

  it('can be removed by editing it out of a leaflet note', () => {
    const existing = {
      $type: 'pub.leaflet.content',
      pages: [
        {
          $type: 'pub.leaflet.pages.linearDocument',
          blocks: [
            { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'Worth reading.' } },
            { block: { $type: 'pub.leaflet.blocks.text', plaintext: ATTRIBUTION_TEXT } },
            { block: CARD },
          ],
        },
      ],
    };
    const edited = replaceLeafletNoteRegion(existing, 'Worth reading.') as {
      pages: Array<{ blocks: Array<{ block: { plaintext?: string } }> }>;
    };
    expect(edited.pages[0].blocks.map((b) => b.block.plaintext)).not.toContain(ATTRIBUTION_TEXT);
  });

  it.each(['pckt', 'offprint'] as const)('is kept once when a %s note is edited', (format) => {
    const prefix = format === 'pckt' ? 'blog.pckt.block.' : 'app.offprint.block.';
    const card =
      format === 'pckt'
        ? { $type: `${prefix}website`, src: ARTICLE.url }
        : { $type: `${prefix}webBookmark`, href: ARTICLE.url, title: 'Post' };
    const existing = {
      $type: format === 'pckt' ? 'blog.pckt.content' : 'app.offprint.content',
      items: [
        { $type: `${prefix}text`, plaintext: 'Worth reading.' },
        { $type: `${prefix}text`, plaintext: ATTRIBUTION_TEXT },
        card,
      ],
    };
    const edited = replaceItemsNoteRegion(existing, format, NOTE, ARTICLE) as {
      items: Array<{ $type: string; plaintext?: string }>;
    };
    expect(edited.items.filter((i) => i.plaintext === ATTRIBUTION_TEXT)).toHaveLength(1);
    expect(edited.items.at(-1)?.$type).toBe(card.$type);
    // …and editing it out removes it.
    const cleared = replaceItemsNoteRegion(existing, format, 'Worth reading.', ARTICLE) as {
      items: Array<{ plaintext?: string }>;
    };
    expect(cleared.items.map((i) => i.plaintext)).not.toContain(ATTRIBUTION_TEXT);
  });

  it('is kept once when a markpub note is edited', () => {
    const existing = {
      $type: 'at.markpub.markdown',
      text: { markdown: `Worth reading.\n\n${ATTRIBUTION_TEXT}\n\n[Post](${ARTICLE.url})` },
    };
    const edited = replaceMarkpubNote(existing, NOTE, ARTICLE) as { text: { markdown: string } };
    expect(edited.text.markdown).toBe(`${NOTE}\n\n[Post](${ARTICLE.url})`);
    const cleared = replaceMarkpubNote(existing, 'Worth reading.', ARTICLE) as {
      text: { markdown: string };
    };
    expect(cleared.text.markdown).toBe(`Worth reading.\n\n[Post](${ARTICLE.url})`);
  });

  it('is still ours to carry when the record flag says we added it', () => {
    const existing = {
      $type: 'at.markpub.markdown',
      text: { markdown: `Worth reading.\n\n[Post](${ARTICLE.url})\n\n${ATTRIBUTION_TEXT}` },
    };
    const edited = replaceMarkpubNote(existing, 'Revised.', ARTICLE, true) as {
      text: { markdown: string };
    };
    expect(edited.text.markdown).toBe(`Revised.\n\n[Post](${ARTICLE.url})\n\n${ATTRIBUTION_TEXT}`);
  });
});

describe('edits preserve the layout they find', () => {
  const card = { $type: 'pub.leaflet.blocks.website', src: 'https://example.com/a' };
  const wrap = (blocks: Array<Record<string, unknown>>) => ({
    $type: 'pub.leaflet.content',
    pages: [
      { $type: 'pub.leaflet.pages.linearDocument', blocks: blocks.map((b) => ({ block: b })) },
    ],
  });
  const typesAfterEdit = (blocks: Array<Record<string, unknown>>, note: string) =>
    (
      replaceLeafletNoteRegion(wrap(blocks), note) as {
        pages: Array<{ blocks: Array<{ block: { $type: string } }> }>;
      }
    ).pages[0].blocks.map((b) => b.block.$type);

  it('keeps a legacy note-leads/card-closes record at the bottom', () => {
    expect(
      typesAfterEdit(
        [{ $type: 'pub.leaflet.blocks.text', plaintext: 'old' }, card],
        '> quote\n\nnew'
      )
    ).toEqual([
      'pub.leaflet.blocks.blockquote',
      'pub.leaflet.blocks.text',
      'pub.leaflet.blocks.website',
    ]);
  });

  it('keeps a context-layout record in context layout', () => {
    expect(
      typesAfterEdit(
        [
          { $type: 'pub.leaflet.blocks.blockquote', plaintext: 'old quote' },
          card,
          { $type: 'pub.leaflet.blocks.text', plaintext: 'old' },
        ],
        '> quote\n\nnew'
      )
    ).toEqual([
      'pub.leaflet.blocks.blockquote',
      'pub.leaflet.blocks.website',
      'pub.leaflet.blocks.text',
    ]);
  });

  it('keeps commentary that sits after a mid-post card', () => {
    const content = replaceLeafletNoteRegion(
      wrap([
        { $type: 'pub.leaflet.blocks.blockquote', plaintext: 'q' },
        card,
        { $type: 'pub.leaflet.blocks.text', plaintext: 'old' },
      ]),
      '> q\n\nnew commentary'
    ) as { pages: Array<{ blocks: Array<{ block: { plaintext?: string } }> }> };
    expect(content.pages[0].blocks.at(-1)?.block.plaintext).toBe('new commentary');
  });

  it('keeps a card-first record card-first', () => {
    expect(
      typesAfterEdit([card, { $type: 'pub.leaflet.blocks.text', plaintext: 'old' }], 'new')
    ).toEqual(['pub.leaflet.blocks.website', 'pub.leaflet.blocks.text']);
  });
});

describe('websiteCardMeta', () => {
  it('reads the plain article title back off the card', () => {
    const doc = buildLinkblogDocument(DID, RKEY, {
      articleUrl: 'https://example.com/a',
      articleTitle: 'The Article',
      excerpt: 'An excerpt.',
    });
    expect(doc.title).toBe('🔗 The Article');
    expect(websiteCardMeta(doc.content)).toEqual({
      title: 'The Article',
      excerpt: 'An excerpt.',
    });
  });

  it.each(['pckt', 'offprint'] as const)('reads a %s card', (format) => {
    const doc = buildLinkblogDocument(
      DID,
      RKEY,
      { articleUrl: 'https://example.com/a', articleTitle: 'The Article', excerpt: 'An excerpt.' },
      undefined,
      publicationUri(DID),
      format
    );
    expect(websiteCardMeta(doc.content).title).toBe('The Article');
  });
});

describe('formattingFromRow', () => {
  it('treats NULL and anything unrecognized as the defaults', () => {
    expect(formattingFromRow(null, null)).toEqual({
      titleStyle: 'link',
      cardPosition: 'context',
    });
    expect(formattingFromRow('nonsense', 'nonsense')).toEqual({
      titleStyle: 'link',
      cardPosition: 'context',
    });
  });

  it('takes stored values it recognizes', () => {
    expect(formattingFromRow('plain', 'bottom')).toEqual({
      titleStyle: 'plain',
      cardPosition: 'bottom',
    });
  });
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
