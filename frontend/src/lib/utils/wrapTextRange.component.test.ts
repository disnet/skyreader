import { describe, expect, it } from 'vitest';
import { wrapTextRange } from './wrapTextRange';

describe('wrapTextRange', () => {
  it('wraps cross-node text without cloning or moving article elements', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>foo <strong>bar</strong></p><p> baz</p>';
    const paragraphs = [...container.querySelectorAll('p')];
    const strong = container.querySelector('strong')!;
    const range = document.createRange();
    range.setStart(strong.firstChild!, 0);
    range.setEnd(paragraphs[1].firstChild!, 4);

    const marks = wrapTextRange(range, container, () => {
      const mark = document.createElement('mark');
      mark.className = 'community-highlight';
      return mark;
    });

    expect(marks).toHaveLength(2);
    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect(container.querySelectorAll('strong')).toHaveLength(1);
    expect(strong.parentElement).toBe(paragraphs[0]);

    for (const mark of marks) mark.replaceWith(...mark.childNodes);
    container.normalize();
    expect(container.innerHTML).toBe('<p>foo <strong>bar</strong></p><p> baz</p>');
  });
});
