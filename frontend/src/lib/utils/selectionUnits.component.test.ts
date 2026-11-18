import { describe, expect, it } from 'vitest';
import { MARGINALIA_ATTR } from './textSelector';
import { expandRange, sentenceBounds } from './selectionUnits';

/** Mount `html` as the article and return it. */
function article(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.replaceChildren(container);
  return container;
}

/** A range over the first occurrence of `text` (inside one text node), from `from` for `len` chars. */
function rangeOf(container: HTMLElement, text: string, from = 0, len = text.length - from): Range {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent!.indexOf(text);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at + from);
    range.setEnd(node, at + from + len);
    return range;
  }
  throw new Error(`no "${text}"`);
}

const PARA =
  '<p>The cost is not paid in minutes. It is paid in what we stop noticing: the footnote. A wealth of information creates a poverty of attention.</p>' +
  '<p>Herbert Simon made the point in 1971. Information consumes attention.</p>';

describe('expandRange', () => {
  it('rounds a drag that cuts words out to whole words', () => {
    const el = article(PARA);
    // "ost is not pa"
    const range = rangeOf(el, 'cost is not paid', 1, 13);
    expect(expandRange(range, 'word', el)!.toString()).toBe('cost is not paid');
  });

  it('drops leading and trailing space instead of growing into the next word', () => {
    const el = article(PARA);
    const range = rangeOf(el, ' is not ', 0);
    expect(expandRange(range, 'word', el)!.toString()).toBe('is not');
  });

  it('leaves a selection already on word boundaries alone', () => {
    const el = article(PARA);
    const range = rangeOf(el, 'paid in minutes');
    expect(expandRange(range, 'word', el)!.toString()).toBe('paid in minutes');
  });

  it('grows to the sentence around the selection', () => {
    const el = article(PARA);
    const range = rangeOf(el, 'stop noticing', 2, 5);
    expect(expandRange(range, 'sentence', el)!.toString()).toBe(
      'It is paid in what we stop noticing: the footnote.'
    );
  });

  it('grows to every sentence a selection touches', () => {
    const el = article(PARA);
    const start = rangeOf(el, 'minutes');
    const end = rangeOf(el, 'stop noticing');
    const range = document.createRange();
    range.setStart(start.startContainer, start.startOffset);
    range.setEnd(end.endContainer, end.endOffset);
    expect(expandRange(range, 'sentence', el)!.toString()).toBe(
      'The cost is not paid in minutes. It is paid in what we stop noticing: the footnote.'
    );
  });

  it('grows to the paragraph, and across paragraphs', () => {
    const el = article(PARA);
    expect(expandRange(rangeOf(el, 'footnote'), 'paragraph', el)!.toString()).toBe(
      el.querySelector('p')!.textContent
    );
    const start = rangeOf(el, 'footnote');
    const end = rangeOf(el, '1971');
    const range = document.createRange();
    range.setStart(start.startContainer, start.startOffset);
    range.setEnd(end.endContainer, end.endOffset);
    const grown = expandRange(range, 'paragraph', el)!;
    expect(grown.toString().startsWith('The cost')).toBe(true);
    expect(grown.toString().endsWith('consumes attention.')).toBe(true);
  });

  it('steps across inline markup and existing highlight marks', () => {
    const el = article(
      '<p>Readers have a tool. A <em>pencil</em> line beside a <mark class="highlight">para</mark>graph says come back. A note says more.</p>'
    );
    const range = rangeOf(el, 'pencil', 2, 2);
    expect(expandRange(range, 'sentence', el)!.toString()).toBe(
      'A pencil line beside a paragraph says come back.'
    );
    // A word split across a mark and the text after it is one word.
    expect(expandRange(rangeOf(el, 'para', 1, 2), 'word', el)!.toString()).toBe('paragraph');
  });

  it('leaves notes drawn into the body out of the sentence', () => {
    const el = article(
      `<p>First sentence here. Second <span ${MARGINALIA_ATTR}>A note. With sentences.</span>sentence here. Third.</p>`
    );
    const range = rangeOf(el, 'Second');
    expect(
      expandRange(range, 'sentence', el)!.toString().replace('A note. With sentences.', '')
    ).toBe('Second sentence here.');
  });

  it('never reaches outside the article', () => {
    const outside = document.createElement('p');
    outside.textContent = 'Outside text.';
    const el = article('<span>Loose words with no block. Another one.</span>');
    document.body.prepend(outside);
    const range = rangeOf(el, 'words');
    expect(expandRange(range, 'paragraph', el)!.toString()).toBe(
      'Loose words with no block. Another one.'
    );
  });
});

describe('sentenceBounds', () => {
  it('covers the whole text, in order', () => {
    const text = 'One. Two? Three!';
    const bounds = sentenceBounds(text);
    expect(bounds.map(([s, e]) => text.slice(s, e).trim())).toEqual(['One.', 'Two?', 'Three!']);
  });
});
