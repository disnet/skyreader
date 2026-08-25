import { describe, expect, it } from 'vitest';
import { buildMarginNoteRecord } from '../src/routes/integrations';

describe('Margin highlight records', () => {
  it('writes a canonical source so later exact backlink lookups can find it', () => {
    const record = buildMarginNoteRecord(
      {
        source:
          'https://chinaunread.substack.com/p/a-post?r=clku7&utm_campaign=post-expanded-share&utm_medium=post%20viewer',
        exact: 'A passage',
      },
      '2026-08-25T00:00:00.000Z'
    );

    expect(record.target.source).toBe('https://chinaunread.substack.com/p/a-post');
  });
});
