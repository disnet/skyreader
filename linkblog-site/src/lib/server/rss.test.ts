import { describe, expect, it } from 'vitest';
import { renderFeed } from './rss';
import type { ProxyDocument } from '$lib/types';

const DID = 'did:plc:linkblogger';

function doc(links?: ProxyDocument['links']): ProxyDocument {
  return {
    authorDid: DID,
    recordUri: `at://${DID}/site.standard.document/3abc`,
    siteUri: `at://${DID}/site.standard.publication/self`,
    title: 'On reading slowly',
    publishedAt: '2026-11-01T00:00:00Z',
    createdAt: '2026-11-01T00:00:00Z',
    links,
  };
}

describe('renderFeed', () => {
  it("links each shared article's read page from the entry body", () => {
    const xml = renderFeed('https://linkblogs.skyreader.app', DID, null, null, [
      doc([{ uri: 'https://example.com/essay?id=7' }]),
    ]);
    expect(xml).toContain(
      '<a href="https://read.skyreader.app/https://example.com/essay?id=7">See the conversation across the Atmosphere</a>'
    );
  });

  it('points a staging feed at the staging read host', () => {
    const xml = renderFeed('https://staging-linkblogs.skyreader.app', DID, null, null, [
      doc([{ uri: 'https://example.com/essay' }]),
    ]);
    expect(xml).toContain('https://staging-read.skyreader.app/https://example.com/essay');
  });

  it('leaves it out of a note with no article', () => {
    const xml = renderFeed('https://linkblogs.skyreader.app', DID, null, null, [doc()]);
    expect(xml).not.toContain('See the conversation');
  });
});
