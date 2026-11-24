import { describe, expect, it } from 'vitest';
import { passageText } from './textSelector';

function rangeOver(html: string, from: string, to: string): Range {
  document.body.innerHTML = `<article>${html}</article>`;
  const root = document.body.firstElementChild!;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let started = false;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!started && n.data.includes(from)) {
      range.setStart(n, n.data.indexOf(from));
      started = true;
    }
    if (started && n.data.includes(to)) {
      range.setEnd(n, n.data.indexOf(to) + to.length);
      break;
    }
  }
  return range;
}

const ARTICLE = `
  <p>Here is <a href="#">the press release</a>. Obviously the funniest outcome would be:</p>
  <ul>
    <li>Kim and the directors conduct their investigation <em>impartially</em>;</li>
    <li>They find lots more bad stuff; and</li>
    <li>The board fires Huang again.</li>
  </ul>
  <ol start="3"><li><p>Third</p></li><li>Fourth</li></ol>
  <p>One line<br>and the next</p>
  <p>Notes <span data-marginalia>a gloss</span>stay out.</p>`;

describe('passageText', () => {
  it('keeps a paragraph and the list after it apart, with bullets', () => {
    const range = rangeOver(ARTICLE, 'Obviously', 'again.');
    expect(passageText(range)).toBe(
      [
        'Obviously the funniest outcome would be:',
        '• Kim and the directors conduct their investigation impartially;',
        '• They find lots more bad stuff; and',
        '• The board fires Huang again.',
      ].join('\n')
    );
  });

  it('numbers an ordered list from its start, through a nested paragraph', () => {
    expect(passageText(rangeOver(ARTICLE, 'Third', 'Fourth'))).toBe('3. Third\n4. Fourth');
  });

  it('reads part of one item as a quote, not a one-item list', () => {
    expect(passageText(rangeOver(ARTICLE, 'lots more', 'stuff'))).toBe('lots more bad stuff');
  });

  it('breaks at a <br>, and leaves marginalia out', () => {
    expect(passageText(rangeOver(ARTICLE, 'One line', 'next'))).toBe('One line\nand the next');
    expect(passageText(rangeOver(ARTICLE, 'Notes', 'stay out.'))).toBe('Notes stay out.');
  });
});
