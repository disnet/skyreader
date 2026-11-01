// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readingBlocks } from './readingBlocks';

const LONG = 'long enough text to count as a reading block';

function body(html: string) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

function texts(el: HTMLElement) {
  return readingBlocks(el).map((b) => `${b.tagName.toLowerCase()}:${b.textContent?.trim()}`);
}

describe('readingBlocks', () => {
  it('steps into a blockquote of paragraphs rather than landing on the whole quote', () => {
    const el = body(`<p>A ${LONG}</p><blockquote><p>B ${LONG}</p><p>C ${LONG}</p></blockquote>`);
    expect(texts(el)).toEqual([`p:A ${LONG}`, `p:B ${LONG}`, `p:C ${LONG}`]);
  });

  it('steps through a nested list item by item', () => {
    const el = body(
      `<ul><li>Parent ${LONG}<ul><li>Child one ${LONG}</li><li>Child two ${LONG}</li></ul></li><li>Sibling ${LONG}</li></ul>`
    );
    expect(texts(el)).toEqual([
      `li:Child one ${LONG}`,
      `li:Child two ${LONG}`,
      `li:Sibling ${LONG}`,
    ]);
  });

  it('keeps a container whose children are too short to read on their own', () => {
    const el = body(`<blockquote><p>Short line one.</p><p>Short line two.</p></blockquote>`);
    expect(readingBlocks(el).map((b) => b.tagName)).toEqual(['BLOCKQUOTE']);
  });

  it('keeps one block for a list item wrapping a paragraph', () => {
    const el = body(`<ul><li><p>Item ${LONG}</p></li></ul>`);
    expect(readingBlocks(el).map((b) => b.tagName)).toEqual(['P']);
  });
});
