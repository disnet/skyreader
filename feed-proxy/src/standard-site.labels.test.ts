import { describe, expect, it } from 'bun:test';
import { readSelfLabels } from './standard-site';

describe('readSelfLabels', () => {
  it('reads selfLabels values, dropping system labels, junk and repeats', () => {
    expect(
      readSelfLabels({
        $type: 'com.atproto.label.defs#selfLabels',
        values: [
          { val: 'ai-generated' },
          { val: '!no-unauthenticated' },
          { val: 'Sexual' },
          { val: 'sexual' },
          null,
        ],
      })
    ).toEqual(['ai-generated', 'sexual']);
  });

  it('is undefined for no labels or a malformed field', () => {
    expect(readSelfLabels(undefined)).toBeUndefined();
    expect(readSelfLabels({ values: 'ai-generated' })).toBeUndefined();
  });
});
