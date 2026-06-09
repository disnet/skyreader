import { describe, it, expect } from 'vitest';
import {
  parseHandleTokens,
  buildMentionFacet,
  MENTION_FACET_TYPE,
} from '../src/utils/mention-facets';
import { buildLinkblogDocument } from '../src/services/linkblog-sync';

// The facet byte spans index UTF-8 bytes (atproto convention), and the feature
// type must match what Leaflet writes, or the mention stops being interoperable.
describe('parseHandleTokens', () => {
  it('finds an @handle with its byte span (span includes the @)', () => {
    const tokens = parseHandleTokens('hi @alice.bsky.social!');
    expect(tokens).toEqual([{ handle: 'alice.bsky.social', byteStart: 3, byteEnd: 21 }]);
  });

  it('uses UTF-8 byte offsets, not UTF-16 string indices', () => {
    // 'é' is 2 bytes in UTF-8 but 1 JS char — the @ that follows must shift by 2.
    const tokens = parseHandleTokens('é @bob.test');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ handle: 'bob.test', byteStart: 3 });
  });

  it('requires a dotted domain (ignores a bare @name)', () => {
    expect(parseHandleTokens('hey @bob, look')).toEqual([]);
  });

  it('does not match an email local-part (@ not on a word boundary)', () => {
    expect(parseHandleTokens('mail me at contact@foo.com')).toEqual([]);
  });

  it('finds multiple mentions', () => {
    const tokens = parseHandleTokens('@a.com and @b.org');
    expect(tokens.map((t) => t.handle)).toEqual(['a.com', 'b.org']);
  });
});

describe('buildMentionFacet', () => {
  it('emits a pub.leaflet.richtext.facet#didMention feature', () => {
    expect(buildMentionFacet(0, 6, 'did:plc:abc')).toEqual({
      index: { byteStart: 0, byteEnd: 6 },
      features: [{ $type: MENTION_FACET_TYPE, did: 'did:plc:abc' }],
    });
  });
});

describe('buildLinkblogDocument with mention facets', () => {
  it('attaches passed facets to the note text block', () => {
    const facet = buildMentionFacet(0, 6, 'did:plc:xyz');
    const doc = buildLinkblogDocument(
      'did:plc:author',
      '3kabcdefghijk',
      { articleUrl: 'https://example.com/a', note: '@a.com hi' },
      [facet]
    );
    const content = doc.content as {
      pages: Array<{ blocks: Array<{ block: Record<string, unknown> }> }>;
    };
    const textBlock = content.pages[0].blocks[0].block;
    expect(textBlock.$type).toBe('pub.leaflet.blocks.text');
    expect(textBlock.facets).toEqual([facet]);
  });

  it('omits facets when none are passed', () => {
    const doc = buildLinkblogDocument(
      'did:plc:author',
      '3kabcdefghijk',
      { articleUrl: 'https://example.com/a', note: 'no mentions' },
      []
    );
    const content = doc.content as {
      pages: Array<{ blocks: Array<{ block: Record<string, unknown> }> }>;
    };
    expect(content.pages[0].blocks[0].block.facets).toBeUndefined();
  });
});
