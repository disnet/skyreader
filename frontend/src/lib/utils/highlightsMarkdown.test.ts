import { describe, expect, it } from 'vitest';
import { highlightsMarkdown } from './highlightsMarkdown';

const hl = (exact: string, note?: string) => ({
  selector: { type: 'TextQuoteSelector' as const, exact },
  ...(note ? { note } : {}),
});

describe('highlightsMarkdown', () => {
  it('quotes each passage, notes under it, the source last', () => {
    expect(
      highlightsMarkdown([hl('First passage.', 'Why it matters'), hl('Second.')], {
        title: 'An Essay',
        url: 'https://example.com/a',
      })
    ).toBe(
      '> First passage.\n\nWhy it matters\n\n> Second.\n\n— [An Essay](<https://example.com/a>)'
    );
  });

  it('keeps a passage of several paragraphs in one quote', () => {
    const passage = { ...hl('One. Two.'), passage: 'One.\n\nTwo.' };
    expect(highlightsMarkdown([passage], {})).toBe('> One.\n>\n> Two.');
  });

  it('keeps a single line break as a line break, not a new paragraph', () => {
    const verse = { ...hl('Line one Line two'), passage: 'Line one\nLine two' };
    expect(highlightsMarkdown([verse], {})).toBe('> Line one  \n> Line two');
  });

  it('escapes brackets in the title and falls back to what it has', () => {
    expect(highlightsMarkdown([hl('x')], { title: 'A [draft]', url: 'https://e.com' })).toBe(
      '> x\n\n— [A \\[draft\\]](<https://e.com>)'
    );
    expect(highlightsMarkdown([hl('x')], { title: 'Only a title' })).toBe('> x\n\n— Only a title');
    expect(highlightsMarkdown([hl('x')], { url: 'https://e.com' })).toBe('> x\n\nhttps://e.com');
  });
});
