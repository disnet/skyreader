import { describe, expect, it } from 'vitest';
import { savedFromDetail, savedFromLabel } from './savedFromLabel';

describe('savedFromLabel', () => {
  it.each([
    [{}, null],
    [{ savedVia: 'web' }, null],
    [{ savedVia: 'extension' }, 'from extension'],
    [{ savedVia: 'share-target' }, 'from a shared link'],
    [{ savedVia: 'bookmarklet' }, 'from bookmarklet'],
    [{ savedVia: 'semble' }, 'from Semble'],
    [{ savedVia: 'margin' }, 'from Margin'],
  ] as const)('maps %o to %s', (item, label) => expect(savedFromLabel(item)).toBe(label));

  it('prefers and truncates the referrer title', () => {
    expect(savedFromLabel({ savedVia: 'extension', savedFromTitle: 'The article' })).toBe(
      'from The article'
    );
    expect(savedFromLabel({ savedFromTitle: 'x'.repeat(50) })).toBe(`from ${'x'.repeat(39)}…`);
  });
});

describe('savedFromDetail', () => {
  it('carries the source URL behind the label', () => {
    expect(
      savedFromDetail({
        savedVia: 'reader',
        savedFromTitle: 'The article',
        savedFromUrl: 'https://source.example/post',
      })
    ).toBe('from The article\nhttps://source.example/post');
  });

  it('spells out a title the label had to truncate', () => {
    expect(savedFromDetail({ savedFromTitle: 'x'.repeat(50) })).toBe(`from ${'x'.repeat(50)}`);
  });

  it('stays silent when the label already says everything', () => {
    expect(savedFromDetail({ savedFromTitle: 'The article' })).toBeNull();
    expect(savedFromDetail({ savedVia: 'extension' })).toBeNull();
    expect(savedFromDetail({})).toBeNull();
  });
});
