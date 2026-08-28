import { describe, expect, it } from 'vitest';
import { MAX_EXACT_LENGTH, createSelector, exceedsSelectorLimit } from './textSelector';

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
