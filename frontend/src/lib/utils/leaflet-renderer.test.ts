// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderLeafletContent } from './leaflet-renderer';
import { sanitizeHtml } from './sanitize';
import type {
  LeafletBlockWrapper,
  LeafletContent,
  LeafletFacet,
  LeafletListItemBlock,
} from '$lib/types';

const AUTHOR_DID = 'did:plc:example';

function doc(...blocks: LeafletBlockWrapper[]): LeafletContent {
  return {
    $type: 'pub.leaflet.content',
    pages: [{ $type: 'pub.leaflet.pages.linearDocument', blocks }],
  };
}

function text(plaintext: string, facets?: LeafletFacet[]): LeafletBlockWrapper {
  return { block: { $type: 'pub.leaflet.blocks.text', plaintext, facets } };
}

function list(...items: LeafletListItemBlock[]): LeafletBlockWrapper {
  return { block: { $type: 'pub.leaflet.blocks.unorderedList', children: items } };
}

function listItem(plaintext: string, facets?: LeafletFacet[]): LeafletListItemBlock {
  return {
    $type: 'pub.leaflet.blocks.unorderedList#listItem',
    content: { $type: 'pub.leaflet.blocks.text', plaintext, facets },
  };
}

/** A footnote facet over the marker character Leaflet leaves in the plaintext. */
function footnote(
  byteStart: number,
  footnoteId: string,
  contentPlaintext: string,
  contentFacets?: LeafletFacet[]
): LeafletFacet {
  return {
    index: { byteStart, byteEnd: byteStart + 1 },
    features: [
      {
        $type: 'pub.leaflet.richtext.facet#footnote',
        footnoteId,
        contentPlaintext,
        ...(contentFacets ? { contentFacets } : {}),
      },
    ],
  };
}

function link(byteStart: number, byteEnd: number, uri: string): LeafletFacet {
  return {
    index: { byteStart, byteEnd },
    features: [{ $type: 'pub.leaflet.richtext.facet#link', uri }],
  };
}

/** Parse rendered HTML so assertions read against the DOM, not the string. */
function parse(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('renderLeafletContent footnotes', () => {
  it('replaces the marker with a numbered reference and lists the body at the end', () => {
    const html = renderLeafletContent(
      doc(text('The claim*', [footnote(9, 'fn-a', 'The evidence.')])),
      AUTHOR_DID
    );
    const el = parse(html);

    // The bare "*" the user saw is gone, replaced by an identifiable number.
    expect(el.querySelector('p')?.textContent).toBe('The claim1');
    const ref = el.querySelector('sup.footnote-ref a');
    expect(ref?.getAttribute('data-footnote-ref')).toBe('1');
    expect(ref?.getAttribute('aria-label')).toBe('Footnote 1');

    const entry = el.querySelector('section.footnotes li[data-footnote-id="1"]');
    expect(entry?.textContent).toContain('The evidence.');
    expect(entry?.querySelector('a.footnote-backref')?.getAttribute('data-footnote-backref')).toBe(
      '1'
    );
    expect(el.querySelector('section.footnotes')?.getAttribute('role')).toBe('doc-endnotes');
  });

  it('numbers footnotes in document order across blocks, including list items', () => {
    const html = renderLeafletContent(
      doc(
        text('First*', [footnote(5, 'fn-a', 'Note A')]),
        list(listItem('Item*', [footnote(4, 'fn-b', 'Note B')])),
        text('Last*', [footnote(4, 'fn-c', 'Note C')])
      ),
      AUTHOR_DID
    );
    const el = parse(html);

    expect([...el.querySelectorAll('sup.footnote-ref a')].map((a) => a.textContent)).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect([...el.querySelectorAll('section.footnotes li')].map((li) => li.textContent)).toEqual([
      expect.stringContaining('Note A'),
      expect.stringContaining('Note B'),
      expect.stringContaining('Note C'),
    ]);
  });

  it('numbers by reading order even when facets are stored out of order', () => {
    // applyFacets walks facets from the end backwards; numbering must not follow.
    const html = renderLeafletContent(
      doc(
        text('one* two*', [
          footnote(8, 'fn-second', 'Second note'),
          footnote(3, 'fn-first', 'First note'),
        ])
      ),
      AUTHOR_DID
    );
    const el = parse(html);

    expect(el.querySelector('p')?.textContent).toBe('one1 two2');
    expect(el.querySelector('li[data-footnote-id="1"]')?.textContent).toContain('First note');
    expect(el.querySelector('li[data-footnote-id="2"]')?.textContent).toContain('Second note');
  });

  it('reuses one number and one entry for a repeated footnoteId', () => {
    const html = renderLeafletContent(
      doc(
        text('here*', [footnote(4, 'fn-a', 'Note A')]),
        text('again*', [footnote(5, 'fn-a', 'Note A')])
      ),
      AUTHOR_DID
    );
    const el = parse(html);

    expect([...el.querySelectorAll('sup.footnote-ref a')].map((a) => a.textContent)).toEqual([
      '1',
      '1',
    ]);
    expect(el.querySelectorAll('section.footnotes li')).toHaveLength(1);
  });

  it('renders formatting inside a footnote body', () => {
    const html = renderLeafletContent(
      doc(
        text('cited*', [
          footnote(5, 'fn-a', 'See source here', [link(11, 15, 'https://example.com/paper')]),
        ])
      ),
      AUTHOR_DID
    );
    const entry = parse(html).querySelector('section.footnotes li');

    const anchor = entry?.querySelector('a:not(.footnote-backref)');
    expect(anchor?.getAttribute('href')).toBe('https://example.com/paper');
    expect(anchor?.textContent).toBe('here');
  });

  it('renders a footnote nested inside a footnote body as plain text', () => {
    const html = renderLeafletContent(
      doc(
        text('outer*', [footnote(5, 'fn-a', 'inner*', [footnote(5, 'fn-b', 'should not recurse')])])
      ),
      AUTHOR_DID
    );
    const el = parse(html);

    expect(el.querySelectorAll('sup.footnote-ref')).toHaveLength(1);
    expect(el.querySelectorAll('section.footnotes li')).toHaveLength(1);
    expect(el.querySelector('section.footnotes li')?.textContent).toContain('inner*');
    expect(html).not.toContain('should not recurse');
  });

  it('places the reference correctly after multi-byte text', () => {
    // "Héllo" is 6 bytes, so the marker facet starts at byte 6, not index 5.
    const html = renderLeafletContent(
      doc(text('Héllo* world', [footnote(6, 'fn-a', 'Note A')])),
      AUTHOR_DID
    );

    expect(parse(html).querySelector('p')?.textContent).toBe('Héllo1 world');
  });

  it('escapes HTML in a footnote body', () => {
    const html = renderLeafletContent(
      doc(text('x*', [footnote(1, 'fn-a', '<img src=x onerror=alert(1)>')])),
      AUTHOR_DID
    );

    expect(html).not.toContain('<img');
    expect(parse(html).querySelector('section.footnotes li')?.textContent).toContain(
      '<img src=x onerror=alert(1)>'
    );
  });

  it('leaves a malformed footnote feature as plain text', () => {
    const malformed: LeafletFacet = {
      index: { byteStart: 4, byteEnd: 5 },
      features: [{ $type: 'pub.leaflet.richtext.facet#footnote', contentPlaintext: 'orphan' }],
    };
    const html = renderLeafletContent(doc(text('here*', [malformed])), AUTHOR_DID);

    expect(parse(html).querySelector('p')?.textContent).toBe('here*');
    expect(html).not.toContain('section class="footnotes"');
  });

  it('renders no footnotes section for a document without footnotes', () => {
    const html = renderLeafletContent(doc(text('Just prose.')), AUTHOR_DID);

    expect(html).toBe('<p>Just prose.</p>');
  });
});

describe('footnote markup survives sanitizeHtml', () => {
  // The markup deliberately routes around the sanitizer (classes + data-* instead
  // of inline styles and hash hrefs). Pin those assumptions so a future tightening
  // of sanitize.ts fails here rather than silently breaking footnote navigation.
  const rendered = renderLeafletContent(
    doc(text('claim*', [footnote(5, 'fn-a', 'The evidence.')])),
    AUTHOR_DID
  );

  it('keeps the reference, the section, and every data attribute', () => {
    const el = parse(sanitizeHtml(rendered, 'https://example.com/post'));

    expect(el.querySelector('sup.footnote-ref a[data-footnote-ref="1"]')?.textContent).toBe('1');
    expect(el.querySelector('section.footnotes[role="doc-endnotes"]')).not.toBeNull();
    expect(el.querySelector('li[data-footnote-id="1"]')).not.toBeNull();
    expect(el.querySelector('a.footnote-backref[data-footnote-backref="1"]')).not.toBeNull();
  });
});

describe('current Leaflet lexicon support', () => {
  it('keeps token alignment and text sizing after sanitizing', () => {
    const content = doc(text('Centered'));
    content.pages[0].blocks[0].alignment = 'lex:pub.leaflet.pages.linearDocument#textAlignCenter';
    (content.pages[0].blocks[0].block as { textSize?: string }).textSize = 'large';
    const clean = sanitizeHtml(renderLeafletContent(content, AUTHOR_DID));
    expect(clean).toContain('op-align-center');
    expect(clean).toContain('lf-text-large');
    expect(clean).not.toContain('style=');
  });

  it('renders button and math blocks instead of dropping them', () => {
    const content = doc(
      {
        block: { $type: 'pub.leaflet.blocks.button', text: 'Continue', url: 'https://example.com' },
      },
      { block: { $type: 'pub.leaflet.blocks.math', tex: 'x^2' } }
    );
    const clean = sanitizeHtml(renderLeafletContent(content, AUTHOR_DID));
    expect(clean).toContain('op-button');
    // Math renders as its own source until the on-demand parser hydrates it; the TeX
    // has to survive sanitizing for the action to have anything to render.
    expect(clean).toContain('data-tex="x^2"');
    expect(clean).toContain('x^2</code>');
    expect(clean).not.toContain('Some content');
  });

  it('renders a referenced page once, at the reference, and guards a cycle', () => {
    const content: LeafletContent = {
      $type: 'pub.leaflet.content',
      pages: [
        {
          $type: 'pub.leaflet.pages.linearDocument',
          id: 'main',
          blocks: [text('Root'), { block: { $type: 'pub.leaflet.blocks.page', id: 'notes' } }],
        },
        {
          $type: 'pub.leaflet.pages.linearDocument',
          id: 'notes',
          blocks: [text('Nested'), { block: { $type: 'pub.leaflet.blocks.page', id: 'main' } }],
        },
      ],
    };
    const html = renderLeafletContent(content, AUTHOR_DID);
    // Leaflet writes a sub-page into `pages` *and* references it from its parent, so
    // walking both is what used to emit it twice.
    expect(html.match(/Nested/g)).toHaveLength(1);
    expect(html.match(/Root/g)).toHaveLength(1);
    expect(html.length).toBeLessThan(5000);
  });

  it('numbers a sub-page footnote once, where the page is referenced', () => {
    const content: LeafletContent = {
      $type: 'pub.leaflet.content',
      pages: [
        {
          $type: 'pub.leaflet.pages.linearDocument',
          id: 'main',
          blocks: [{ block: { $type: 'pub.leaflet.blocks.page', id: 'notes' } }],
        },
        {
          $type: 'pub.leaflet.pages.linearDocument',
          id: 'notes',
          blocks: [text('Cited*', [footnote(6, 'fn-a', 'The note')])],
        },
      ],
    };
    const html = renderLeafletContent(content, AUTHOR_DID);
    expect(html.match(/data-footnote-ref="1"/g)).toHaveLength(1);
    expect(html.match(/The note/g)).toHaveLength(1);
    expect(html).not.toContain('data-footnote-ref="2"');
  });

  it('renders a list nested under an item of the other kind', () => {
    const content = doc({
      block: {
        $type: 'pub.leaflet.blocks.unorderedList',
        children: [
          {
            ...listItem('Parent'),
            // The lexicon's shape: a ref to the whole list, not an array of items.
            orderedListChildren: {
              $type: 'pub.leaflet.blocks.orderedList',
              startIndex: 3,
              children: [listItem('Numbered')],
            },
          },
        ],
      },
    });
    const html = renderLeafletContent(content, AUTHOR_DID);
    expect(html).toContain('<ol start="3">');
    expect(html).toContain('Numbered');
    expect(html).not.toContain('Some content');
  });

  it('still reads a nested list written as a bare array of items', () => {
    const content = doc({
      block: {
        $type: 'pub.leaflet.blocks.unorderedList',
        children: [{ ...listItem('Parent'), unorderedListChildren: [listItem('Bulleted')] }],
      },
    });
    expect(renderLeafletContent(content, AUTHOR_DID)).toContain('Bulleted');
  });

  it('keeps the degradation notice for what was actually dropped', () => {
    // An empty text block is how Leaflet's editor spaces paragraphs. It renders to
    // nothing, but nothing was lost, so the footer must stay off.
    const spacing = doc(text('Body'), text(''));
    expect(renderLeafletContent(spacing, AUTHOR_DID)).not.toContain('Some content');

    // A site widget this reader deliberately doesn't render is a loss, and says so.
    const widget = doc(text('Body'), { block: { $type: 'pub.leaflet.blocks.poll' } });
    expect(renderLeafletContent(widget, AUTHOR_DID)).toContain('Some content');
  });

  it('marks a body truncated at ingest as degraded', () => {
    const content = doc(text('Beginning'));
    content.truncated = true;
    expect(renderLeafletContent(content, AUTHOR_DID)).toContain('Some content');
  });

  it('stops the whole document at the members-only delimiter', () => {
    const content: LeafletContent = {
      $type: 'pub.leaflet.content',
      truncated: true,
      pages: [
        {
          $type: 'pub.leaflet.pages.linearDocument',
          id: 'main',
          blocks: [
            text('Free'),
            {
              block: { $type: 'pub.leaflet.blocks.membersOnlyDelimiter', audience: 'subscribers' },
            },
            text('Gated'),
            { block: { $type: 'pub.leaflet.blocks.page', id: 'more' } },
          ],
        },
        {
          $type: 'pub.leaflet.pages.linearDocument',
          id: 'more',
          blocks: [text('Also gated')],
        },
      ],
    };
    const html = renderLeafletContent(content, AUTHOR_DID);
    expect(html).toContain('Free');
    expect(html).not.toContain('Gated');
    expect(html).not.toContain('Also gated');
    // `subscribers` is a follow, not a paywall — the copy shouldn't say members.
    expect(html).toContain('The rest is for subscribers');
    // A document that was also truncated at ingest keeps saying so.
    expect(html).toContain('Some content');
  });

  it('says members for a paid audience', () => {
    const content = doc(text('Free'), {
      block: { $type: 'pub.leaflet.blocks.membersOnlyDelimiter', audience: 'paid' },
    });
    expect(renderLeafletContent(content, AUTHOR_DID)).toContain('The rest is for members');
  });

  it('renders an image at full measure rather than mis-reading its pixel width', () => {
    const content = doc({
      block: {
        $type: 'pub.leaflet.blocks.image',
        image: { ref: { $link: 'bafyimage' }, mimeType: 'image/jpeg' },
        // Pixels, capped at the page width — not a percentage of the reader's measure.
        width: 400,
        aspectRatio: { width: 800, height: 600 },
      },
    });
    const html = renderLeafletContent(content, AUTHOR_DID);
    expect(html).toContain('width="800" height="600"');
    expect(html).not.toContain('op-figure--w');
  });

  it('lays an image gallery strip out as a scrolling row', () => {
    const content = doc({
      block: {
        $type: 'pub.leaflet.blocks.imageGallery',
        format: 'strip',
        images: [
          { image: { ref: { $link: 'bafyone' } } },
          { image: { ref: { $link: 'bafytwo' } } },
        ],
      },
    });
    const html = renderLeafletContent(content, AUTHOR_DID);
    expect(html).toContain('op-carousel');
    expect(html).not.toContain('op-grid');
  });

  it('sanitizes an inline html block instead of dropping it', () => {
    const content = doc({
      block: {
        $type: 'pub.leaflet.blocks.html',
        html: '<p>Inline <em>markup</em></p><script>alert(1)</script><style>p{color:red}</style>',
      },
    });
    const clean = sanitizeHtml(renderLeafletContent(content, AUTHOR_DID));
    expect(clean).toContain('Inline <em>markup</em>');
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('<style');
    expect(clean).not.toContain('Some content');
  });
});

describe('documents with nothing renderable', () => {
  it('returns nothing for an un-inflated blobPages stub, so the caller can fall back', () => {
    const stub: LeafletContent = {
      $type: 'pub.leaflet.content',
      pages: [],
      blobPages: { ref: { $link: 'bafkreipages' } },
    };
    expect(renderLeafletContent(stub, AUTHOR_DID)).toBe('');
  });

  it('returns nothing for a record whose only page is a freeform canvas', () => {
    const canvas = {
      $type: 'pub.leaflet.content',
      pages: [{ $type: 'pub.leaflet.pages.canvas', id: 'board' }],
    } as unknown as LeafletContent;
    expect(renderLeafletContent(canvas, AUTHOR_DID)).toBe('');
  });
});
