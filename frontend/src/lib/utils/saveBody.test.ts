import { describe, expect, it } from 'vitest';
import { htmlWordCount, preferExtractedBody } from './saveBody';

const words = (n: number) => `<p>${Array.from({ length: n }, (_, i) => `w${i}`).join(' ')}</p>`;

describe('htmlWordCount', () => {
  it('counts visible words, not tags', () => {
    expect(htmlWordCount('<p class="a">one <b>two</b></p><img src="x">three')).toBe(3);
    expect(htmlWordCount('')).toBe(0);
    expect(htmlWordCount(null)).toBe(0);
    expect(htmlWordCount('<style>p { a: b }</style><p>x</p>')).toBe(1);
  });
});

describe('preferExtractedBody', () => {
  it('takes the extraction when the feed body is empty or an excerpt', () => {
    expect(preferExtractedBody(null, words(500))).toBe(true);
    expect(preferExtractedBody(words(40), words(1500))).toBe(true);
  });

  it('takes a clean extraction of an equally full article', () => {
    expect(preferExtractedBody(words(2000), words(1850))).toBe(true);
  });

  it('keeps a full feed body over a paywall stub', () => {
    expect(preferExtractedBody(words(2000), words(250))).toBe(false);
  });

  it('never picks an empty extraction', () => {
    expect(preferExtractedBody(words(10), '')).toBe(false);
    expect(preferExtractedBody(null, '<p> </p>')).toBe(false);
  });
});
