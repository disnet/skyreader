import { describe, it, expect } from 'bun:test';
import { extractContentText } from './document-content';

describe('extractContentText', () => {
  it('reads the leading text block of leaflet content', () => {
    const content = {
      $type: 'pub.leaflet.content',
      pages: [
        {
          blocks: [
            { block: { $type: 'pub.leaflet.blocks.image', image: {} } },
            { block: { $type: 'pub.leaflet.blocks.text', plaintext: '  my leaflet take  ' } },
          ],
        },
      ],
    };
    expect(extractContentText(content)).toBe('my leaflet take');
  });

  it('reads the leading text block of pckt content (flat items)', () => {
    const content = {
      $type: 'blog.pckt.content',
      items: [
        { $type: 'blog.pckt.block.heading', plaintext: 'A title' },
        { $type: 'blog.pckt.block.text', plaintext: 'my pckt take' },
      ],
    };
    expect(extractContentText(content)).toBe('my pckt take');
  });

  it('reads the leading text block of offprint content (flat items)', () => {
    const content = {
      $type: 'app.offprint.content',
      items: [{ $type: 'app.offprint.block.text', plaintext: 'my offprint take' }],
    };
    expect(extractContentText(content)).toBe('my offprint take');
  });

  // Leaflet's blockquote holds its text in a top-level `plaintext`, so the
  // container descent can't reach it. A share whose note is only the quoted
  // passage — the shape the composer seeds — must still yield that quote rather
  // than falling through to `textContent` (which keeps the `> ` marker).
  it('reads a leaflet blockquote as the snippet when the note is quote-only', () => {
    const content = {
      $type: 'pub.leaflet.content',
      pages: [
        {
          blocks: [
            { block: { $type: 'pub.leaflet.blocks.blockquote', plaintext: 'the quoted passage' } },
            { block: { $type: 'pub.leaflet.blocks.website', src: 'https://example.com' } },
          ],
        },
      ],
    };
    expect(extractContentText(content)).toBe('the quoted passage');
  });

  // The composer seeds the selected passage as a quote and drops the cursor under
  // it, so quote-then-commentary is the ordinary shape of a note. The snippet is
  // the linker's prose, so the quote only wins when there's nothing else.
  it('prefers the linker prose over a quote that precedes it (leaflet)', () => {
    const content = {
      $type: 'pub.leaflet.content',
      pages: [
        {
          blocks: [
            { block: { $type: 'pub.leaflet.blocks.blockquote', plaintext: 'the quoted passage' } },
            { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'my commentary' } },
          ],
        },
      ],
    };
    expect(extractContentText(content)).toBe('my commentary');
  });

  it('prefers the linker prose over a quote that precedes it (offprint)', () => {
    const content = {
      $type: 'app.offprint.content',
      items: [
        {
          $type: 'app.offprint.block.blockquote',
          content: [{ $type: 'app.offprint.block.text', plaintext: 'the quoted passage' }],
        },
        { $type: 'app.offprint.block.text', plaintext: 'my commentary' },
      ],
    };
    expect(extractContentText(content)).toBe('my commentary');
  });

  it('descends into pckt/offprint container blocks for a lead quote/list', () => {
    const content = {
      $type: 'app.offprint.content',
      items: [
        {
          $type: 'app.offprint.block.blockquote',
          content: [{ $type: 'app.offprint.block.text', plaintext: 'quoted lead' }],
        },
      ],
    };
    expect(extractContentText(content)).toBe('quoted lead');
  });

  it('reads the first meaningful line of greengale markdown, stripping markers', () => {
    const content = {
      $type: 'app.greengale.document',
      markdown: '\n# Heading\n\nThe actual body line.\n',
    };
    expect(extractContentText(content)).toBe('Heading');
  });

  it('reads the first meaningful line of markpub markdown under text.markdown', () => {
    const content = {
      $type: 'at.markpub.markdown',
      flavor: 'gfm',
      text: {
        $type: 'at.markpub.text',
        markdown: '# Title\n\nThe markpub body line.\n',
      },
    };
    expect(extractContentText(content)).toBe('Title');
  });

  it('returns null for a markpub record with no inline markdown', () => {
    const content = {
      $type: 'at.markpub.markdown',
      text: { $type: 'at.markpub.text', textBlob: { ref: { $link: 'bafy' } } },
    };
    expect(extractContentText(content)).toBeNull();
  });

  it('returns null for unknown / missing content', () => {
    expect(extractContentText(undefined)).toBeNull();
    expect(extractContentText(null)).toBeNull();
    expect(extractContentText({ $type: 'app.unknown.content', items: [] })).toBeNull();
    expect(extractContentText({ pages: [] })).toBeNull(); // no $type discriminator
  });
});
