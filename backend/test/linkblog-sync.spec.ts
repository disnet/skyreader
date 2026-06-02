import { describe, it, expect } from 'vitest';
import {
  buildLinkblogDocument,
  publicationUri,
  LINKBLOG_RKEY,
} from '../src/services/linkblog-sync';

const DID = 'did:plc:linkblogtest123';
const RKEY = '3kabcdefghijk';

// These assertions encode the contract with the feed-proxy parser
// (feed-proxy/src/standard-site.ts): it reads `site`, `title`, `path`,
// `description`, `textContent`, `tags`, `createdAt`, `content` from the raw
// record. If a field name drifts here, the linkblog stops round-tripping.
describe('buildLinkblogDocument', () => {
  const doc = buildLinkblogDocument(DID, RKEY, {
    articleUrl: 'https://example.com/the-article',
    articleTitle: 'The Article',
    excerpt: 'A generous first-paragraph excerpt.',
    note: 'Worth reading.',
    tags: ['design'],
  });

  it('is a site.standard.document scoped to the skyreader-links publication', () => {
    expect(doc.$type).toBe('site.standard.document');
    expect(doc.site).toBe(publicationUri(DID));
    expect(doc.site).toBe(`at://${DID}/site.standard.publication/${LINKBLOG_RKEY}`);
  });

  it('uses the rkey as its path for canonical-URL building', () => {
    expect(doc.path).toBe(`/${RKEY}`);
  });

  it('carries the external URL in the machine-readable links field', () => {
    expect(doc.links).toEqual([{ uri: 'https://example.com/the-article', rel: 'related' }]);
  });

  it('stores the excerpt as durable fallback copy', () => {
    expect(doc.description).toBe('A generous first-paragraph excerpt.');
    expect(doc.textContent).toContain('Worth reading.');
    expect(doc.textContent).toContain('A generous first-paragraph excerpt.');
  });

  it('builds a pub.leaflet body with a note text block and a website link-card', () => {
    const content = doc.content as {
      $type: string;
      pages: Array<{
        blocks: Array<{
          block: { $type: string; url?: string; plaintext?: string };
        }>;
      }>;
    };
    expect(content.$type).toBe('pub.leaflet.content');
    const blocks = content.pages[0].blocks.map((b) => b.block);
    const text = blocks.find((b) => b.$type === 'pub.leaflet.blocks.text');
    const website = blocks.find((b) => b.$type === 'pub.leaflet.blocks.website');
    expect(text?.plaintext).toBe('Worth reading.');
    expect(website?.url).toBe('https://example.com/the-article');
  });

  it('falls back to the URL as title and omits empty note block', () => {
    const bare = buildLinkblogDocument(DID, RKEY, {
      articleUrl: 'https://example.com/x',
    });
    expect(bare.title).toBe('https://example.com/x');
    const content = bare.content as {
      pages: Array<{ blocks: Array<{ block: { $type: string } }> }>;
    };
    const types = content.pages[0].blocks.map((b) => b.block.$type);
    expect(types).not.toContain('pub.leaflet.blocks.text');
    expect(types).toContain('pub.leaflet.blocks.website');
  });
});
