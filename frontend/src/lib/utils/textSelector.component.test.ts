import { describe, expect, it } from 'vitest';
import type { TextQuoteSelector } from '$lib/types';
import {
  MAX_EXACT_LENGTH,
  createSelector,
  exceedsSelectorLimit,
  findTextInDOM,
} from './textSelector';

/** A container of `paragraphs` blocks, each `chars` long, plus the range over all of them. */
function article(paragraphs: number, chars: number): { container: HTMLElement; range: Range } {
  const container = document.createElement('div');
  for (let i = 0; i < paragraphs; i++) {
    const p = document.createElement('p');
    p.textContent = String(i % 10).repeat(chars);
    container.append(p);
  }
  document.body.replaceChildren(container);
  const range = document.createRange();
  range.selectNodeContents(container);
  return { container, range };
}

describe('selector length limit', () => {
  it('flags only passages past the cap', () => {
    expect(exceedsSelectorLimit('a'.repeat(MAX_EXACT_LENGTH))).toBe(false);
    expect(exceedsSelectorLimit('a'.repeat(MAX_EXACT_LENGTH + 1))).toBe(true);
  });

  it('is what stands between an over-long range and a quietly shortened quote', () => {
    // The selection a paged reader can now make by dragging across page turns.
    const { container, range } = article(20, 500);
    expect(range.toString().length).toBeGreaterThan(MAX_EXACT_LENGTH);
    expect(exceedsSelectorLimit(range.toString())).toBe(true);

    // Without the guard this is what would be stored: a well-formed selector for
    // a passage that stops 5 000 characters in, indistinguishable from a
    // highlight the reader meant to end there.
    const selector = createSelector(range, container);
    expect(selector.exact).toHaveLength(MAX_EXACT_LENGTH);
    expect(selector.exact).not.toBe(range.toString());
  });

  it('leaves a passage inside the cap untouched', () => {
    const { container, range } = article(2, 100);
    expect(exceedsSelectorLimit(range.toString())).toBe(false);
    expect(createSelector(range, container).exact).toBe(range.toString());
  });
});

describe('finding a stored quote again', () => {
  /** Render `html` in a detached container and look for `selector` in it. */
  function findIn(html: string, selector: TextQuoteSelector): Range | null {
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.replaceChildren(container);
    return findTextInDOM(selector, container);
  }

  it('finds an untouched quote', () => {
    const range = findIn('<p>One two three.</p>', {
      type: 'TextQuoteSelector',
      exact: 'two three',
    });
    expect(range?.toString()).toBe('two three');
  });

  // The case that regressed: a plaintext document used to render as one text node
  // with real newlines in it, so a selection spanning a line break stored those
  // newlines verbatim. It now renders as paragraphs and <br>s, which contribute no
  // text at all, and an exact match finds nothing — the highlight would vanish.
  it('finds a quote whose line breaks the re-render dropped', () => {
    const range = findIn('<p>Line one<br>Line two</p><p>Next block.</p>', {
      type: 'TextQuoteSelector',
      exact: 'one\nLine two',
      suffix: '\n\nNext block.',
    });
    expect(range?.toString()).toBe('oneLine two');
  });

  it('spans the paragraph split a blank line became', () => {
    const range = findIn('<p>First block.</p><p>Second block.</p>', {
      type: 'TextQuoteSelector',
      exact: 'First block.\n\nSecond',
    });
    expect(range?.toString()).toBe('First block.Second');
  });

  it('uses context to pick between repeats when it falls back', () => {
    const range = findIn('<p>ping</p><p>marker</p><p>ping</p>', {
      type: 'TextQuoteSelector',
      exact: ' ping',
      prefix: 'marker',
    });
    expect(range?.startContainer.parentElement?.previousElementSibling?.textContent).toBe('marker');
  });

  it('still returns null for a quote that is simply not there', () => {
    expect(
      findIn('<p>One two three.</p>', { type: 'TextQuoteSelector', exact: 'four' })
    ).toBeNull();
  });

  it('returns null for a quote that is nothing but whitespace', () => {
    expect(findIn('<p>One two.</p>', { type: 'TextQuoteSelector', exact: ' \n ' })).toBeNull();
  });
});
