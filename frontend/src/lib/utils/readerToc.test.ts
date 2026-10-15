// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildReaderToc, currentTocIndex, tocText } from './readerToc';

function body(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

const shape = (root: HTMLElement, opts?: Parameters<typeof buildReaderToc>[1]) =>
  buildReaderToc(root, opts).map(({ title, level }) => [title, level]);

describe('buildReaderToc: headings', () => {
  it('ranks levels by the headings actually used', () => {
    const root = body(`
      <h2>Intro</h2><p>a</p>
      <h3>Detail</h3><p>b</p>
      <h2>Method</h2>
      <h4>Deep</h4>
      <h6>Too deep</h6>`);
    expect(shape(root)).toEqual([
      ['Intro', 1],
      ['Detail', 2],
      ['Method', 1],
      ['Deep', 3],
    ]);
  });

  it('skips headings that are part of a quote, an embed or a list, and empty ones', () => {
    const root = body(`
      <h2>One</h2>
      <blockquote><h2>Quoted</h2></blockquote>
      <aside><h3>Sidebar</h3></aside>
      <ul><li><h4>Item</h4></li></ul>
      <h2>   </h2>
      <h2>Two</h2>`);
    expect(shape(root)).toEqual([
      ['One', 1],
      ['Two', 1],
    ]);
  });

  it('drops a first heading that repeats the title', () => {
    const root = body(`<h1>The  Title</h1><h2>Part</h2>`);
    expect(shape(root, { articleTitle: 'The Title' })).toEqual([['Part', 1]]);
  });

  it('keeps the element each entry jumps to', () => {
    const root = body(`<h2>Here</h2>`);
    expect(buildReaderToc(root)[0].el).toBe(root.querySelector('h2'));
  });
});

describe('buildReaderToc: marked entries', () => {
  const marked = `
    <section data-toc-title="Chapter 1" data-toc-level="1"><h1>I</h1><h2>Sub</h2></section>
    <div data-toc-title="Part  a" data-toc-level="2"></div>
    <p data-toc-title="Deep" data-toc-level="9">x</p>`;

  it('uses the marked TOC in place of headings', () => {
    expect(shape(body(marked), { markers: true })).toEqual([
      ['Chapter 1', 1],
      ['Part a', 2],
      ['Deep', 3],
    ]);
  });

  it('ignores marks on content Skyreader did not convert', () => {
    expect(shape(body(marked))).toEqual([
      ['I', 1],
      ['Sub', 2],
    ]);
  });

  it('falls back to headings when nothing is marked', () => {
    expect(shape(body(`<h2>A</h2><h2>B</h2>`), { markers: true })).toEqual([
      ['A', 1],
      ['B', 1],
    ]);
  });
});

describe('tocText', () => {
  it('collapses whitespace and caps the length', () => {
    expect(tocText('  a \n b ')).toBe('a b');
    expect(tocText('x'.repeat(300))).toHaveLength(200);
  });
});

describe('currentTocIndex', () => {
  it('is the last entry reached', () => {
    const pages = [0, 2, 5, 9];
    expect(currentTocIndex(pages, (p) => p <= 6)).toBe(2);
    expect(currentTocIndex(pages, (p) => p <= 0)).toBe(0);
    expect(currentTocIndex(pages, () => false)).toBe(-1);
    expect(currentTocIndex(pages, () => true)).toBe(3);
  });
});
