import { describe, expect, it } from 'vitest';
import { savedFromLabel } from './savedFromLabel';

describe('savedFromLabel', () => {
  it.each([
    [{}, null],
    [{ savedVia: 'web' }, null],
    [{ savedVia: 'extension' }, 'from extension'],
    [{ savedVia: 'share-target' }, 'from share sheet'],
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
