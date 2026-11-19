import { describe, expect, it } from 'vitest';
import type { ShareDraftBlock } from '$lib/types';
import {
  blocksToNote,
  noteToBlocks,
  draftWordCount,
  draftHasContent,
  blocksToText,
  insertQuote,
  moveParagraph,
  quoteLines,
  toggleQuote,
} from './shareNote';

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

describe('blocksToText', () => {
  it('is the note, ready to type after a closing quote', () => {
    expect(blocksToText([text('Hi'), quote('a')])).toBe('Hi\n\n> a\n\n');
    expect(blocksToText([quote('a'), text('after'), text('')])).toBe('> a\n\nafter');
    expect(blocksToText([text('')])).toBe('');
  });

  it('round-trips through noteToBlocks', () => {
    const blocks = [text('Before'), quote('one\n\ntwo'), quote('three'), text('After')];
    expect(noteToBlocks(blocksToText(blocks))).toEqual([...blocks]);
  });
});

describe('quoteLines', () => {
  it('quotes every line, blank ones too, so the passage stays one quote', () => {
    expect(quoteLines('  a \n\n b ')).toBe('> a\n>\n> b');
    expect(noteToBlocks(quoteLines('a\n\nb'))).toEqual([quote('a\n\nb'), text('')]);
  });
});

describe('insertQuote', () => {
  it('appends at the end without a caret, leaving the caret after it', () => {
    const r = insertQuote('My take.', 'A passage.');
    expect(r.text).toBe('My take.\n\n> A passage.\n\n');
    expect(r.selectionStart).toBe(r.text.length);
  });

  it('goes after the paragraph the caret is in, never inside it', () => {
    const t = 'First para here.\n\nSecond.';
    const r = insertQuote(t, 'Q', 3);
    expect(r.text).toBe('First para here.\n\n> Q\n\nSecond.');
    expect(r.text.slice(r.selectionStart)).toBe('Second.');
  });

  it('goes right where the caret is on a blank line', () => {
    const t = 'One.\n\n\nTwo.';
    const r = insertQuote(t, 'Q', 5);
    expect(r.text).toBe('One.\n\n> Q\n\nTwo.');
  });

  it('starts an empty draft with the quote', () => {
    expect(insertQuote('', 'Q', 0).text).toBe('> Q\n\n');
  });
});

describe('toggleQuote', () => {
  it('quotes the lines a selection touches', () => {
    const t = 'keep\nmake this\nand this\nkeep';
    const start = t.indexOf('this');
    const end = t.indexOf('and') + 2;
    const r = toggleQuote(t, start, end);
    expect(r.text).toBe('keep\n> make this\n> and this\nkeep');
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('> make this\n> and this');
  });

  it('unquotes when every line is quoted', () => {
    const r = toggleQuote('> a\n> b', 0, 7);
    expect(r.text).toBe('a\nb');
  });

  it('works on the caret line alone and leaves blank lines blank', () => {
    expect(toggleQuote('a\n\nb', 0, 4).text).toBe('> a\n\n> b');
    expect(toggleQuote('x\ny', 3, 3).text).toBe('x\n> y');
  });
});

describe('moveParagraph', () => {
  it('swaps the caret paragraph with its neighbour and keeps the caret in it', () => {
    const t = '> quote\n\nmy take';
    const r = moveParagraph(t, t.indexOf('take'), -1)!;
    expect(r.text).toBe('my take\n\n> quote');
    expect(r.text.slice(r.selectionStart)).toBe('take\n\n> quote');
  });

  it('separates a quote from commentary written right under it', () => {
    const r = moveParagraph('> q\nafter', 1, 1)!;
    expect(r.text).toBe('after\n\n> q');
  });

  it('does nothing at the edges or on a blank line', () => {
    expect(moveParagraph('a\n\nb', 0, -1)).toBeNull();
    expect(moveParagraph('a\n\nb', 5, 1)).toBeNull();
    expect(moveParagraph('a\n\n\nb', 3, 1)).toBeNull();
  });

  it('keeps leading and trailing whitespace', () => {
    expect(moveParagraph('a\n\nb\n\n', 0, 1)!.text).toBe('b\n\na\n\n');
  });
});
