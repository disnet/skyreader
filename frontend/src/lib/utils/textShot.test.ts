import { describe, expect, it } from 'vitest';
import { capLines, wrapLines } from './textShot';

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
