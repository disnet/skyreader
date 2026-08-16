import { describe, expect, it } from 'vitest';
import { getSourceDisplay, isLinkblogPublication } from './sourceDisplay';

// A linkblog connected to an existing publication has an arbitrary rkey, so the
// publication URI alone can't identify it — the subscription's siteUrl (the
// author's public linkblog page, persisted server-side) is the durable tell. Get
// this wrong and a followed linkblog reads as a generic "Blog", with the raw
// at:// URI as its subtitle on /sources.
describe('isLinkblogPublication', () => {
  const DID = 'did:plc:someone';

  it('recognizes the default Skyreader publication by its fixed rkey', () => {
    expect(isLinkblogPublication(`at://${DID}/site.standard.publication/skyreader-links`)).toBe(
      true
    );
  });

  it('recognizes a connected publication by its linkblog page siteUrl', () => {
    expect(
      isLinkblogPublication(
        `at://${DID}/site.standard.publication/my-leaflet`,
        `https://linkblogs.skyreader.app/${DID}/`
      )
    ).toBe(true);
  });

  it('recognizes the DID-keyed page shape on a non-production origin', () => {
    expect(
      isLinkblogPublication(
        `at://${DID}/site.standard.publication/my-leaflet`,
        `http://127.0.0.1:5174/${DID}/`
      )
    ).toBe(true);
  });

  it('recognizes the legacy /blogs/<did>/ page path', () => {
    expect(
      isLinkblogPublication(
        `at://${DID}/site.standard.publication/my-leaflet`,
        `https://linkblogs.staging.example/blogs/${DID}/`
      )
    ).toBe(true);
  });

  it('does not label a DID-keyed page on some other app a linkblog', () => {
    // siteUrl is client-supplied on create, and plenty of Atmosphere apps key
    // their pages by DID — only the whole linkblog page path counts.
    expect(
      isLinkblogPublication(
        `at://${DID}/site.standard.publication/essays`,
        `https://leaflet.pub/lish/${DID}/essays`
      )
    ).toBe(false);
    expect(
      isLinkblogPublication(
        `at://${DID}/site.standard.publication/essays`,
        `https://pckt.example/u/${DID}`
      )
    ).toBe(false);
  });

  it('does not label an unrelated third-party host a linkblog', () => {
    expect(
      isLinkblogPublication(
        `at://${DID}/site.standard.publication/essays`,
        'https://linkblogs.example.com/alice/'
      )
    ).toBe(false);
    expect(
      isLinkblogPublication(
        `at://${DID}/site.standard.publication/essays`,
        'https://leaflet.pub/lish/abc'
      )
    ).toBe(false);
  });

  it('tolerates a malformed siteUrl', () => {
    expect(isLinkblogPublication(`at://${DID}/site.standard.publication/essays`, 'not a url')).toBe(
      false
    );
  });
});

describe('getSourceDisplay', () => {
  const DID = 'did:plc:someone';

  it('pills a connected linkblog as Linkblog, not Blog', () => {
    expect(
      getSourceDisplay(
        'atproto.documents',
        `at://${DID}/site.standard.publication/my-leaflet`,
        `https://linkblogs.skyreader.app/${DID}/`
      ).label
    ).toBe('Linkblog');
  });

  it('still pills an ordinary publication as Blog', () => {
    expect(
      getSourceDisplay(
        'atproto.documents',
        `at://${DID}/site.standard.publication/essays`,
        'https://leaflet.pub/lish/abc'
      ).label
    ).toBe('Blog');
  });
});
