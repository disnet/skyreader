import { describe, expect, it } from 'vitest';
import type { ShareDraftBlock } from '$lib/types';
import { blocksToNote, noteToBlocks, draftWordCount, draftHasContent } from './shareNote';

const text = (t: string): ShareDraftBlock => ({ kind: 'text', text: t });
const quote = (t: string): ShareDraftBlock => ({ kind: 'quote', text: t });

describe('blocksToNote', () => {
  it('serializes commentary and quotes into the note Markdown subset', () => {
    expect(blocksToNote([text('Before'), quote('first\nsecond'), text('After')])).toBe(
      'Before\n\n> first\n> second\n\nAfter'
    );
  });

  it('drops empty blocks, including the trailing one the composer always keeps', () => {
    expect(blocksToNote([text('Just this'), text('   '), text('')])).toBe('Just this');
    expect(blocksToNote([text('')])).toBe('');
  });

  it('prefixes every line of a multi-line quote', () => {
    expect(blocksToNote([quote('  a  \n  b  ')])).toBe('> a\n> b');
  });
});

describe('noteToBlocks', () => {
  it('parses the note back into the blocks that wrote it', () => {
    expect(noteToBlocks('Before\n\n> first\n> second\n\nAfter')).toEqual([
      text('Before'),
      quote('first\nsecond'),
      text('After'),
    ]);
  });

  it('always ends on a text block so the composer has somewhere to type', () => {
    expect(noteToBlocks('> only a quote')).toEqual([quote('only a quote'), text('')]);
    expect(noteToBlocks(undefined)).toEqual([text('')]);
    expect(noteToBlocks('')).toEqual([text('')]);
    expect(noteToBlocks('   ')).toEqual([text('')]);
  });

  it('folds consecutive quote lines into one block and splits on interruption', () => {
    expect(noteToBlocks('> a\n> b\nmiddle\n> c\n')).toEqual([
      quote('a\nb'),
      text('middle'),
      quote('c'),
      text(''),
    ]);
  });

  it('tolerates leading whitespace and a bare > with no space', () => {
    expect(noteToBlocks('  >a\n\t> b')).toEqual([quote('a\nb'), text('')]);
  });
});

describe('round trip', () => {
  // The note is the wire format the linkblog write path already speaks, so what
  // the composer reopens has to be what it posted.
  it.each([
    'Before\n\n> first\n> second\n\nAfter',
    '> a quote on its own',
    'Just commentary',
    'A paragraph\n\nand another in the same block',
    '> q1\n\n> q2',
  ])('survives %j', (note) => {
    expect(blocksToNote(noteToBlocks(note))).toBe(note);
  });

  it('merges adjacent commentary blocks — the note has no separator for them', () => {
    // Known and accepted: two text blocks serialize to one blank-line-separated
    // note, which reads back as a single block. Nothing the user wrote is lost.
    expect(noteToBlocks(blocksToNote([text('one'), text('two')]))).toEqual([text('one\n\ntwo')]);
  });

  it("reads a '>' the user typed in commentary as the quote it means", () => {
    // Also known and accepted: `> ` is the note's quote marker, so typing one in
    // commentary makes a quote on reopen. Same rule the linkblog renders by.
    expect(noteToBlocks(blocksToNote([text('> looks like a quote')]))).toEqual([
      quote('looks like a quote'),
      text(''),
    ]);
  });
});

describe('draft summaries', () => {
  it('counts words across commentary and quotes', () => {
    expect(draftWordCount([text('one two'), quote('three  four\nfive'), text('')])).toBe(5);
    expect(draftWordCount([text('   ')])).toBe(0);
  });

  it('treats whitespace-only blocks as no content', () => {
    expect(draftHasContent([text(''), text('  \n ')])).toBe(false);
    expect(draftHasContent([text(''), quote('something')])).toBe(true);
  });
});
