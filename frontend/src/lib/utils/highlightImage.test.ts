import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/toast.svelte', () => ({ toastStore: { add: vi.fn(), update: vi.fn() } }));

import { highlightImageName } from './highlightImage';

describe('highlightImageName', () => {
  it('names the file after the article', () => {
    expect(highlightImageName('The Reading Room: Notes', 'image/png')).toBe(
      'skyreader-quote-the-reading-room-notes.png'
    );
  });

  it('folds accents and drops what a file name cannot carry', () => {
    expect(highlightImageName('Café / “Déjà vu”?', 'image/png')).toBe(
      'skyreader-quote-cafe-deja-vu.png'
    );
  });

  it('matches the extension to a JPEG fallback', () => {
    expect(highlightImageName('Long one', 'image/jpeg')).toBe('skyreader-quote-long-one.jpg');
  });

  it('falls back to a bare name without a usable title', () => {
    expect(highlightImageName(undefined, 'image/png')).toBe('skyreader-quote.png');
    expect(highlightImageName('日本語', 'image/png')).toBe('skyreader-quote.png');
  });

  it('keeps a long title short, without a trailing dash', () => {
    const name = highlightImageName('word '.repeat(40), 'image/png');
    expect(name.length).toBeLessThanOrEqual('skyreader-quote-.png'.length + 60);
    expect(name).not.toMatch(/-\.png$/);
  });
});
