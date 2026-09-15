import { describe, expect, it } from 'vitest';
import { readerProvenance } from './saveProvenance';

describe('readerProvenance', () => {
  it('carries an absolute http(s) or at:// referrer', () => {
    expect(readerProvenance({ title: 'The article', url: 'https://example.com/post' })).toEqual({
      savedVia: 'reader',
      savedFromTitle: 'The article',
      savedFromUrl: 'https://example.com/post',
    });
    expect(
      readerProvenance({ title: 'A document', url: 'at://did:plc:abc/site.standard.document/xyz' })
        .savedFromUrl
    ).toBe('at://did:plc:abc/site.standard.document/xyz');
  });

  // The reading surfaces pass the hosting item unconditionally, and an item with
  // no web URL of its own sends '' (or a bare relative document path).
  it.each(['', '   ', '/relative/path', 'javascript:alert(1)', 'at://'])(
    'drops the unusable referrer %o and still names the channel',
    (url) => {
      expect(readerProvenance({ title: 'The article', url })).toEqual({
        savedVia: 'reader',
        savedFromTitle: 'The article',
        savedFromUrl: undefined,
      });
    }
  );

  it('survives a host with nothing to offer', () => {
    expect(readerProvenance()).toEqual({
      savedVia: 'reader',
      savedFromTitle: undefined,
      savedFromUrl: undefined,
    });
    expect(readerProvenance({ title: '  ', url: null })).toEqual({
      savedVia: 'reader',
      savedFromTitle: undefined,
      savedFromUrl: undefined,
    });
  });
});
