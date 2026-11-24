import { describe, expect, it } from 'vitest';
import { capLines, layoutQuote, wrapLines } from './textShot';

// One unit per character keeps the arithmetic obvious.
const measure = (s: string) => s.length;

describe('wrapLines', () => {
  it('wraps on word boundaries', () => {
    expect(wrapLines('the quick brown fox', 10, measure)).toEqual(['the quick', 'brown fox']);
  });

  it('keeps paragraph breaks', () => {
    expect(wrapLines('one\n\ntwo', 10, measure)).toEqual(['one', 'two']);
  });

  it('breaks a word longer than the line', () => {
    expect(wrapLines('abcdefghij', 4, measure)).toEqual(['abcd', 'efgh', 'ij']);
  });
});

describe('capLines', () => {
  it('leaves short text alone', () => {
    expect(capLines(['a', 'b'], 3, 10, measure)).toEqual(['a', 'b']);
  });

  it('ends the last kept line with an ellipsis that fits', () => {
    expect(capLines(['abcd', 'efgh', 'ijkl'], 2, 4, measure)).toEqual(['abcd', 'efg…']);
  });
});

describe('layoutQuote', () => {
  it('keeps a plain passage as wrapLines does', () => {
    expect(layoutQuote('the quick brown fox', 10, measure, 24, 2)).toEqual([
      { text: 'the quick', indent: 0 },
      { text: 'brown fox', indent: 0 },
    ]);
  });

  it('starts each block on a new line, and hangs list items after their marker', () => {
    expect(layoutQuote('would be:\n• one two three\n2. four', 10, measure, 24, 2)).toEqual([
      { text: 'would be:', indent: 0 },
      { text: 'one two', indent: 2, marker: '•', blockStart: true },
      { text: 'three', indent: 2 },
      { text: 'four', indent: 2, marker: '2.', blockStart: true },
    ]);
  });

  it('caps the lines, ending the last in an ellipsis inside its indent', () => {
    const lines = layoutQuote('• abcd efgh ijkl', 6, measure, 2, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({ text: 'efg…', indent: 2 });
  });
});
