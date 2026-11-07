import { describe, expect, it } from 'vitest';
import { PUBLIC_EXCERPT_CHARS, publicExcerpt } from '../src/utils/html-text';

describe('publicExcerpt', () => {
  it('strips markup from an HTML summary and flattens it to one line', () => {
    expect(
      publicExcerpt('<p>First <a href="https://x.test">link</a>.</p><p>Second &amp; last.</p>')
    ).toBe('First link . Second & last.');
  });

  it('caps a full-text summary at a word, with an ellipsis', () => {
    const body = `<p>${'word '.repeat(2000)}</p>`;
    const out = publicExcerpt(body);
    expect(out.length).toBeLessThanOrEqual(PUBLIC_EXCERPT_CHARS);
    expect(out.endsWith('word…')).toBe(true);
  });

  it('leaves angle brackets in a plain summary alone', () => {
    expect(publicExcerpt('When x < y and y > z, x <= z')).toBe('When x < y and y > z, x <= z');
  });

  it('is empty when nothing but markup is left', () => {
    expect(publicExcerpt('<p> </p>')).toBe('');
  });
});
