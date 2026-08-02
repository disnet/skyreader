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
