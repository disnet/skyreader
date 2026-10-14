import { describe, expect, it } from 'bun:test';
import { siteSourceFor } from './site-sources';

const PAGE = 'https://attie.ai/@disnetdev.com/pages/f2a1e090-72aa-46c4-93fe-b487dbdb440a';

describe('siteSourceFor', () => {
  it('maps an attie.ai page to its shared-page JSON', () => {
    expect(siteSourceFor(PAGE)?.url).toBe(
      'https://attie.ai/api/shared-pages/f2a1e090-72aa-46c4-93fe-b487dbdb440a'
    );
  });

  it('leaves every other URL to the ordinary fetch', () => {
    expect(
      siteSourceFor('https://example.com/@a/pages/f2a1e090-72aa-46c4-93fe-b487dbdb440a')
    ).toBeNull();
    expect(siteSourceFor('https://attie.ai/@disnetdev.com')).toBeNull();
    expect(siteSourceFor('not a url')).toBeNull();
  });

  it('builds an article document from the page JSON', () => {
    const html = siteSourceFor(PAGE)!.toHtml(
      JSON.stringify({
        title: 'A <Title>',
        html: '<h1>Heading</h1><p>Body text.</p>',
        owner: { handle: 'disnetdev.com' },
        published_at: '2026-10-13T01:36:42Z',
      })
    )!;
    expect(html).toContain('<title>A &lt;Title&gt;</title>');
    expect(html).toContain('<meta name="author" content="disnetdev.com">');
    expect(html).toContain('<article><h1>Heading</h1><p>Body text.</p></article>');
  });

  it('keeps the lead out of a stripped <header> and Bluesky embeds as links', () => {
    const html = siteSourceFor(PAGE)!.toHtml(
      JSON.stringify({
        html: '<header class="pb-6"><h1>Lead</h1><p>Dek.</p></header><bsky-post uri="at://did:plc:abc/app.bsky.feed.post/3mt6"></bsky-post>',
      })
    )!;
    expect(html).toContain('<div class="pb-6"><h1>Lead</h1><p>Dek.</p></div>');
    expect(html).toContain('<a href="https://bsky.app/profile/did:plc:abc/post/3mt6">');
    expect(html).not.toContain('bsky-post');
  });

  it('holds no article for an error answer or a body that is not JSON', () => {
    const source = siteSourceFor(PAGE)!;
    expect(source.toHtml('{"error":"page not found"}')).toBeNull();
    expect(source.toHtml('<html></html>')).toBeNull();
  });
});
