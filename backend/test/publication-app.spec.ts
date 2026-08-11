import { describe, expect, it } from 'vitest';
import { appForContentType, appForUrl } from '../src/services/publication-app';
import { summarizeDocuments } from '../src/routes/linkblog';

// The settings picker describes each of the user's publications — which app it
// belongs to, and which content format to write there. Both come from inference,
// so the inference has to be conservative: a wrong app label sends a user's links
// into a publication that renders them as nothing.
describe('appForContentType', () => {
  it('names the app that owns a content lexicon', () => {
    expect(appForContentType('pub.leaflet.content')).toEqual({
      id: 'leaflet',
      label: 'Leaflet',
      format: 'leaflet',
    });
    expect(appForContentType('blog.pckt.content')?.format).toBe('pckt');
    expect(appForContentType('app.offprint.content')?.format).toBe('offprint');
    expect(appForContentType('at.markpub.markdown')?.format).toBe('markpub');
  });

  it('labels an app Skyreader can read but not write, with no format', () => {
    expect(appForContentType('app.greengale.document')).toEqual({
      id: 'greengale',
      label: 'Greengale',
      format: null,
    });
  });

  it('returns nothing for unknown or missing content types', () => {
    expect(appForContentType('com.example.content')).toBeNull();
    expect(appForContentType(undefined)).toBeNull();
  });
});

describe('appForUrl', () => {
  it('recognizes an app by the domain its lexicons are named for', () => {
    expect(appForUrl('https://leaflet.pub/lish/alice')?.id).toBe('leaflet');
    expect(appForUrl('https://alice.pckt.blog/')?.id).toBe('pckt');
  });

  it('ignores unrecognized hosts and unparseable urls', () => {
    expect(appForUrl('https://alice.example.com/blog')).toBeNull();
    expect(appForUrl('not a url')).toBeNull();
    expect(appForUrl(undefined)).toBeNull();
  });
});

describe('summarizeDocuments', () => {
  const site = 'at://did:plc:alice/site.standard.publication/mine';

  it('counts posts per publication and picks the dominant content type', () => {
    const evidence = summarizeDocuments([
      { site, content: { $type: 'blog.pckt.content' } },
      { site, content: { $type: 'blog.pckt.content' } },
      // A stray Skyreader-written leaflet post doesn't make this a Leaflet
      // publication.
      { site, content: { $type: 'pub.leaflet.content' } },
      { site: 'at://did:plc:alice/site.standard.publication/other', content: undefined },
      { content: { $type: 'pub.leaflet.content' } },
    ]);

    expect(evidence.get(site)?.posts).toBe(3);
    expect(evidence.get(site)?.contentTypes.get('blog.pckt.content')).toBe(2);
    expect(evidence.get('at://did:plc:alice/site.standard.publication/other')?.posts).toBe(1);
    // A document with no `site` belongs to no publication.
    expect(evidence.size).toBe(2);
  });
});
