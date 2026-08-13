import { describe, expect, it } from 'vitest';
import type { LeafletBlockWrapper } from '$lib/types';
import { noteToLeafletBlocks, reconstructLinkPostNote } from './linkPostNote';

describe('link post note conversion', () => {
  it('round-trips mixed commentary and native blockquotes', () => {
    const note = 'Before\n\n> first\n> second\n\nAfter';
    const blocks = noteToLeafletBlocks(note);
    expect(
      blocks.map(({ block }) => [block.$type, 'plaintext' in block && block.plaintext])
    ).toEqual([
      ['pub.leaflet.blocks.text', 'Before'],
      ['pub.leaflet.blocks.blockquote', 'first\nsecond'],
      ['pub.leaflet.blocks.text', 'After'],
    ]);
    expect(reconstructLinkPostNote(blocks).note).toBe(note);
  });

  it('leaves legacy Markdown in a text block unchanged', () => {
    const blocks = noteToLeafletBlocks('placeholder');
    blocks[0] = { block: { $type: 'pub.leaflet.blocks.text', plaintext: '> legacy quote' } };
    expect(reconstructLinkPostNote(blocks).note).toBe('> legacy quote');
  });

  it('stops the note at the website card and handles website-only shares', () => {
    const website = {
      block: { $type: 'pub.leaflet.blocks.website', src: 'https://example.com' },
    } as LeafletBlockWrapper;
    expect(reconstructLinkPostNote([website])).toEqual({ note: undefined, mentions: [] });
    expect(
      reconstructLinkPostNote([
        { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'note' } },
        website,
        { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'not note' } },
      ]).note
    ).toBe('note');
  });

  it('rebases block-local Unicode mention offsets into reconstructed Markdown', () => {
    const feature = { $type: 'pub.leaflet.richtext.facet#didMention', did: 'did:plc:bob' };
    const result = reconstructLinkPostNote([
      {
        block: {
          $type: 'pub.leaflet.blocks.text',
          plaintext: 'é @a.test',
          facets: [{ index: { byteStart: 3, byteEnd: 10 }, features: [feature] }],
        },
      },
      {
        block: {
          $type: 'pub.leaflet.blocks.blockquote',
          plaintext: 'ü @b.test',
          facets: [{ index: { byteStart: 3, byteEnd: 10 }, features: [feature] }],
        },
      },
    ]);
    expect(result.note).toBe('é @a.test\n\n> ü @b.test');
    expect(result.mentions.map(({ byteStart, byteEnd }) => [byteStart, byteEnd])).toEqual([
      [3, 10],
      [17, 24],
    ]);
  });
});
