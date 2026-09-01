import { describe, expect, it } from 'vitest';
import type { LeafletBlockWrapper } from '$lib/types';
import { ATTRIBUTION_TEXT, noteToLeafletBlocks, reconstructLinkPostNote } from './linkPostNote';

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

  // The card no longer closes the post — it can sit between the quote and the
  // commentary, or lead — so it's skipped, not treated as the end of the note.
  // Breaking at it truncated every note written in the new layout.
  it('skips the website card wherever it sits and handles website-only shares', () => {
    const website = {
      block: { $type: 'pub.leaflet.blocks.website', src: 'https://example.com' },
    } as LeafletBlockWrapper;
    expect(reconstructLinkPostNote([website])).toEqual({ note: undefined, mentions: [] });
    expect(
      reconstructLinkPostNote([
        { block: { $type: 'pub.leaflet.blocks.blockquote', plaintext: 'quoted' } },
        website,
        { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'commentary' } },
      ]).note
    ).toBe('> quoted\n\ncommentary');
    // …and card-first.
    expect(
      reconstructLinkPostNote([
        website,
        { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'commentary' } },
      ]).note
    ).toBe('commentary');
  });

  // A card between two note blocks contributes no note bytes, so the mention
  // offsets of the block after it must be unaffected by its presence.
  it('keeps mention offsets correct across a mid-post card', () => {
    const feature = { $type: 'pub.leaflet.richtext.facet#didMention', did: 'did:plc:bob' };
    const result = reconstructLinkPostNote([
      { block: { $type: 'pub.leaflet.blocks.blockquote', plaintext: 'quoted' } },
      {
        block: { $type: 'pub.leaflet.blocks.website', src: 'https://example.com' },
      } as LeafletBlockWrapper,
      {
        block: {
          $type: 'pub.leaflet.blocks.text',
          plaintext: 'hi @a.test',
          facets: [{ index: { byteStart: 3, byteEnd: 10 }, features: [feature] }],
        },
      },
    ]);
    expect(result.note).toBe('> quoted\n\nhi @a.test');
    const note = result.note!;
    const [m] = result.mentions;
    expect(
      new TextDecoder().decode(new TextEncoder().encode(note).slice(m.byteStart, m.byteEnd))
    ).toBe('@a.test');
  });

  // The attribution line is ours, not the author's words.
  it('excludes the attribution line from the note', () => {
    const blocks: LeafletBlockWrapper[] = [
      { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'commentary' } },
      { block: { $type: 'pub.leaflet.blocks.text', plaintext: ATTRIBUTION_TEXT } },
    ];
    expect(reconstructLinkPostNote(blocks, { hasAttribution: true }).note).toBe('commentary');
    // Absent the record's flag, the constant string is the fallback tell…
    expect(reconstructLinkPostNote(blocks).note).toBe('commentary');
    // …but a record that says it has no attribution keeps the author's line.
    expect(reconstructLinkPostNote(blocks, { hasAttribution: false }).note).toBe(
      `commentary\n\n${ATTRIBUTION_TEXT}`
    );
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
