import { describe, expect, it } from 'bun:test';
import { excerptFromContent, parseFeed } from './feed-parser';

describe('parseFeed', () => {
  describe('RSS 2.0', () => {
    it('parses a basic RSS feed', () => {
      const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Blog</title>
    <link>https://example.com</link>
    <description>A test blog</description>
    <item>
      <title>First Post</title>
      <link>https://example.com/post-1</link>
      <guid>post-1</guid>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <description>This is the first post</description>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/post-2</link>
      <guid>post-2</guid>
      <pubDate>Tue, 02 Jan 2024 12:00:00 GMT</pubDate>
      <description>This is the second post</description>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.title).toBe('Test Blog');
      expect(result.description).toBe('A test blog');
      expect(result.siteUrl).toBe('https://example.com');
      expect(result.items).toHaveLength(2);
      expect(result.items[0].guid).toBe('post-1');
      expect(result.items[0].title).toBe('First Post');
      expect(result.items[0].url).toBe('https://example.com/post-1');
      expect(result.items[0].summary).toBe('This is the first post');
    });

    it('decodes HTML entities in titles', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test &amp; Blog</title>
    <link>https://example.com</link>
    <item>
      <title>Post with &quot;quotes&quot; &amp; more</title>
      <link>https://example.com/post</link>
      <guid>post-entities</guid>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.title).toBe('Test & Blog');
      expect(result.items[0].title).toBe('Post with "quotes" & more');
    });

    it('handles CDATA sections', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test Blog</title>
    <link>https://example.com</link>
    <item>
      <title><![CDATA[Post with <em>HTML</em>]]></title>
      <link>https://example.com/post</link>
      <guid>cdata-post</guid>
      <description><![CDATA[<p>Content with HTML</p>]]></description>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.items[0].title).toBe('Post with <em>HTML</em>');
      expect(result.items[0].summary).toBe('<p>Content with HTML</p>');
    });

    it('preserves entity-encoded markup inside CDATA content (does not turn &lt;select&gt; into a real element)', () => {
      // Real-world case: WebKit's WordPress feed wraps raw HTML in CDATA, where
      // code samples use entities like &lt;select&gt; to display literal markup.
      // These must stay encoded, not be decoded into actual <select> elements.
      const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Test Blog</title>
    <link>https://example.com</link>
    <item>
      <title>Post</title>
      <link>https://example.com/post</link>
      <guid>select-post</guid>
      <content:encoded><![CDATA[<p>Style any <code>&lt;select&gt;</code> element.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.items[0].content).toBe('<p>Style any <code>&lt;select&gt;</code> element.</p>');
    });

    it('extracts content:encoded over description', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Test Blog</title>
    <link>https://example.com</link>
    <item>
      <title>Post</title>
      <link>https://example.com/post</link>
      <guid>content-post</guid>
      <description>Short summary</description>
      <content:encoded><![CDATA[<p>Full content here</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.items[0].content).toBe('<p>Full content here</p>');
      expect(result.items[0].summary).toBe('Short summary');
    });

    it('converts arXiv dollar-delimited TeX to native MathML', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>hep-ex updates on arXiv.org</title>
    <link>http://rss.arxiv.org/rss/hep-ex</link>
    <item>
      <title>Proof of principle for nucleon polarization measurement at BESIII</title>
      <link>https://arxiv.org/abs/2607.19927</link>
      <guid>oai:arXiv.org:2607.19927v1</guid>
      <description>Using $10.09\\times10^{9}$ $J/\\psi$ events at BESIII.</description>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'http://rss.arxiv.org/rss/hep-ex');
      const summary = result.items[0].summary ?? '';

      expect(summary).toContain('<math');
      expect(summary).toContain('<mo>×</mo>');
      expect(summary).toContain('<mi>ψ</mi>');
      expect(summary).not.toContain('$10.09');
    });

    it('extracts dc:creator as author', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Test Blog</title>
    <link>https://example.com</link>
    <item>
      <title>Post</title>
      <link>https://example.com/post</link>
      <guid>author-post</guid>
      <dc:creator>John Doe</dc:creator>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.items[0].author).toBe('John Doe');
    });

    it('extracts media:content image', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Test Blog</title>
    <link>https://example.com</link>
    <item>
      <title>Post with Image</title>
      <link>https://example.com/post</link>
      <guid>image-post</guid>
      <media:content url="https://example.com/image.jpg" type="image/jpeg"/>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.items[0].imageUrl).toBe('https://example.com/image.jpg');
    });
  });

  describe('Atom', () => {
    it('parses a basic Atom feed', () => {
      const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Blog</title>
  <subtitle>A test blog</subtitle>
  <link href="https://example.com" rel="alternate"/>
  <link href="https://example.com/feed.xml" rel="self"/>
  <entry>
    <title>First Post</title>
    <link href="https://example.com/post-1" rel="alternate"/>
    <id>urn:uuid:post-1</id>
    <updated>2024-01-01T12:00:00Z</updated>
    <summary>This is the first post</summary>
    <author>
      <name>Jane Doe</name>
    </author>
  </entry>
</feed>`;

      const result = parseFeed(atom, 'https://example.com/feed.xml');

      expect(result.title).toBe('Test Blog');
      expect(result.description).toBe('A test blog');
      expect(result.siteUrl).toBe('https://example.com');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].guid).toBe('urn:uuid:post-1');
      expect(result.items[0].title).toBe('First Post');
      expect(result.items[0].url).toBe('https://example.com/post-1');
      expect(result.items[0].author).toBe('Jane Doe');
    });

    it('extracts content over summary', () => {
      const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Blog</title>
  <entry>
    <title>Post</title>
    <id>post-content</id>
    <updated>2024-01-01T12:00:00Z</updated>
    <summary>Short summary</summary>
    <content type="html">&lt;p&gt;Full content here&lt;/p&gt;</content>
  </entry>
</feed>`;

      const result = parseFeed(atom, 'https://example.com/feed.xml');

      expect(result.items[0].content).toBe('<p>Full content here</p>');
      expect(result.items[0].summary).toBe('Short summary');
    });
  });

  describe('JSON Feed', () => {
    it('parses a JSON Feed 1.1', () => {
      const json = JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'Test Blog',
        description: 'A test blog',
        home_page_url: 'https://example.com',
        items: [
          {
            id: 'post-1',
            url: 'https://example.com/post-1',
            title: 'First Post',
            content_html: '<p>Content here</p>',
            date_published: '2024-01-01T12:00:00Z',
            author: {
              name: 'John Doe',
            },
          },
        ],
      });

      const result = parseFeed(json, 'https://example.com/feed.json');

      expect(result.title).toBe('Test Blog');
      expect(result.description).toBe('A test blog');
      expect(result.siteUrl).toBe('https://example.com');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].guid).toBe('post-1');
      expect(result.items[0].title).toBe('First Post');
      expect(result.items[0].content).toBe('<p>Content here</p>');
      expect(result.items[0].author).toBe('John Doe');
    });

    it('uses content_text when content_html is absent', () => {
      const json = JSON.stringify({
        version: 'https://jsonfeed.org/version/1',
        title: 'Test',
        items: [
          {
            id: 'text-post',
            title: 'Text Post',
            content_text: 'Plain text content',
          },
        ],
      });

      const result = parseFeed(json, 'https://example.com/feed.json');

      expect(result.items[0].content).toBe('Plain text content');
    });
  });

  describe('RDF/RSS 1.0', () => {
    it('parses an RDF feed', () => {
      const rdf = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Test Blog</title>
    <link>https://example.com</link>
    <description>A test blog</description>
  </channel>
  <item>
    <title>First Post</title>
    <link>https://example.com/post-1</link>
    <description>This is the first post</description>
    <dc:creator>Author Name</dc:creator>
    <dc:date>2024-01-01T12:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

      const result = parseFeed(rdf, 'https://example.com/feed.rdf');

      expect(result.title).toBe('Test Blog');
      expect(result.description).toBe('A test blog');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('First Post');
      expect(result.items[0].author).toBe('Author Name');
    });
  });

  describe('entity decoding', () => {
    it('decodes entities in URLs with query parameters', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test</title>
    <link>https://example.com</link>
    <item>
      <title>Post</title>
      <link>https://example.com/post?a=1&amp;b=2&amp;c=3</link>
      <guid>https://example.com/post?a=1&amp;b=2&amp;c=3</guid>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.items[0].url).toBe('https://example.com/post?a=1&b=2&c=3');
      expect(result.items[0].guid).toBe('https://example.com/post?a=1&b=2&c=3');
    });

    it('decodes entities in Atom link href attributes', () => {
      const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test</title>
  <link href="https://example.com?x=1&amp;y=2" rel="alternate"/>
  <entry>
    <title>Post</title>
    <link href="https://example.com/post?a=1&amp;b=2" rel="alternate"/>
    <id>post-1</id>
    <updated>2024-01-01T12:00:00Z</updated>
  </entry>
</feed>`;

      const result = parseFeed(atom, 'https://example.com/feed.xml');

      expect(result.siteUrl).toBe('https://example.com?x=1&y=2');
      expect(result.items[0].url).toBe('https://example.com/post?a=1&b=2');
    });

    it('decodes entities in media:content image URLs', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Test</title>
    <link>https://example.com</link>
    <item>
      <title>Post</title>
      <link>https://example.com/post</link>
      <guid>post-1</guid>
      <media:content url="https://cdn.example.com/img?id=123&amp;w=800" type="image/jpeg"/>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.items[0].imageUrl).toBe('https://cdn.example.com/img?id=123&w=800');
    });

    it('handles feeds with many entities without hitting expansion limits', () => {
      // Simulate a content-heavy feed like Hugo generates with many &amp;rsquo; etc.
      const entityHeavyContent = Array.from(
        { length: 200 },
        (_, i) => `Item ${i} with &amp;rsquo; and &amp;ldquo;quotes&amp;rdquo; and &amp;hellip;`
      ).join(' ');

      const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Entity Heavy Feed</title>
    <link>https://example.com</link>
    <item>
      <title>Post with lots of entities</title>
      <link>https://example.com/post</link>
      <guid>entity-post</guid>
      <description>${entityHeavyContent}</description>
    </item>
  </channel>
</rss>`;

      // Should not throw "Entity expansion limit exceeded"
      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.items).toHaveLength(1);
      // &amp;rsquo; decodes to &rsquo; (XML entity &amp; → &, leaving the HTML entity name)
      expect(result.items[0].summary).toContain('&rsquo;');
      expect(result.items[0].summary).toContain('&ldquo;');
    });

    it('decodes numeric and hex entities', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test</title>
    <link>https://example.com</link>
    <item>
      <title>Caf&#233; &#x2014; Recipe</title>
      <link>https://example.com/post</link>
      <guid>numeric-post</guid>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.items[0].title).toBe('Caf\u00e9 \u2014 Recipe');
    });

    it('does not double-decode &amp;lt; into <', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test</title>
    <link>https://example.com</link>
    <item>
      <title>Use &amp;lt;div&amp;gt; for layout</title>
      <link>https://example.com/post</link>
      <guid>double-decode-post</guid>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.items[0].title).toBe('Use &lt;div&gt; for layout');
    });

    it('decodes high Unicode code points (emoji)', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test</title>
    <link>https://example.com</link>
    <item>
      <title>Hello &#128512; World &#x1F600;</title>
      <link>https://example.com/post</link>
      <guid>emoji-post</guid>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.items[0].title).toBe('Hello \u{1F600} World \u{1F600}');
    });

    it('decodes entities in RSS siteUrl', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test</title>
    <link>https://example.com/site?lang=en&amp;region=us</link>
    <item>
      <title>Post</title>
      <link>https://example.com/post</link>
      <guid>post-1</guid>
    </item>
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.siteUrl).toBe('https://example.com/site?lang=en&region=us');
    });
  });

  describe('error handling', () => {
    it('throws on HTML response', () => {
      const html = '<!DOCTYPE html><html><head><title>Not a feed</title></head></html>';

      expect(() => parseFeed(html, 'https://example.com/page')).toThrow('HTML instead of a feed');
    });

    it('throws on unknown format', () => {
      const xml = '<?xml version="1.0"?><unknown><data>test</data></unknown>';

      expect(() => parseFeed(xml, 'https://example.com/feed')).toThrow('Unknown feed format');
    });
  });

  describe('item limits', () => {
    it('limits items to MAX_ITEMS_TO_PARSE (100)', () => {
      const items = Array.from(
        { length: 120 },
        (_, i) => `
        <item>
          <title>Post ${i + 1}</title>
          <link>https://example.com/post-${i + 1}</link>
          <guid>post-${i + 1}</guid>
        </item>
      `
      ).join('');

      const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Big Feed</title>
    <link>https://example.com</link>
    ${items}
  </channel>
</rss>`;

      const result = parseFeed(rss, 'https://example.com/feed.xml');

      expect(result.items).toHaveLength(100);
      expect(result.items[0].title).toBe('Post 1');
      expect(result.items[99].title).toBe('Post 100');
    });
  });

  // The archive drops bodies over 8 KB and keeps "summary/title/url/image", so a
  // feed that ships a full body and no summary of its own used to reach the
  // reader with no text at all. See CONTENT_EXCERPT_THRESHOLD_BYTES.
  describe('summary fallback for over-cap bodies', () => {
    const longBody = (lead: string) => `<p>${lead}</p><p>${'padding words here. '.repeat(600)}</p>`;

    function atomWith(entry: string): string {
      return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Full Text Blog</title>
  ${entry}
</feed>`;
    }

    it('derives one for an Atom entry with a big content and no summary', () => {
      const feed = atomWith(`<entry>
        <title>Long Post</title>
        <link href="https://example.com/long"/>
        <id>https://example.com/long</id>
        <content type="html"><![CDATA[${longBody('The opening line of the post.')}]]></content>
      </entry>`);

      const [parsed] = parseFeed(feed, 'https://example.com/feed.xml').items;

      expect(parsed.content).toContain('padding words here.');
      expect(parsed.summary).toContain('The opening line of the post.');
      expect(parsed.summary).not.toContain('<p>');
      expect(parsed.summary!.endsWith('…')).toBe(true);
    });

    it('leaves a feed-supplied summary alone', () => {
      const feed = atomWith(`<entry>
        <title>Long Post</title>
        <link href="https://example.com/long"/>
        <id>https://example.com/long</id>
        <summary>The author's own blurb.</summary>
        <content type="html"><![CDATA[${longBody('The opening line.')}]]></content>
      </entry>`);

      const [parsed] = parseFeed(feed, 'https://example.com/feed.xml').items;

      expect(parsed.summary).toBe("The author's own blurb.");
    });

    it('derives nothing for a body the archive keeps in full', () => {
      const feed = atomWith(`<entry>
        <title>Short Post</title>
        <link href="https://example.com/short"/>
        <id>https://example.com/short</id>
        <content type="html"><![CDATA[<p>Just a couple of sentences.</p>]]></content>
      </entry>`);

      const [parsed] = parseFeed(feed, 'https://example.com/feed.xml').items;

      // Duplicating a body the reader already has would grow the archive and
      // re-hash (so re-push) an item that was never broken.
      expect(parsed.summary).toBeUndefined();
      expect(parsed.content).toContain('Just a couple of sentences.');
    });

    it('derives one for an RSS item carrying only content:encoded', () => {
      const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Full Text Blog</title>
    <link>https://example.com</link>
    <item>
      <title>Long Post</title>
      <link>https://example.com/long</link>
      <guid>long</guid>
      <content:encoded><![CDATA[${longBody('First sentence of the body.')}]]></content:encoded>
    </item>
  </channel>
</rss>`;

      const [parsed] = parseFeed(rss, 'https://example.com/feed.xml').items;

      expect(parsed.summary).toContain('First sentence of the body.');
    });
  });
});

describe('excerptFromContent', () => {
  it('strips tags without fusing the words either side', () => {
    expect(excerptFromContent('<p>one</p><p>two</p>')).toBe('one two');
  });

  it('drops script, style and comment bodies', () => {
    const html =
      '<p>Real text.</p><script>alert(1)</script><style>p{color:red}</style><!-- note -->';
    expect(excerptFromContent(html)).toBe('Real text.');
  });

  it('leaves entities encoded, since the excerpt is rendered as HTML', () => {
    expect(excerptFromContent('<p>Tom &amp; Jerry</p>')).toBe('Tom &amp; Jerry');
  });

  it('cuts on a word boundary', () => {
    expect(excerptFromContent(`alpha beta gamma ${'delta '.repeat(50)}`, 20)).toBe(
      'alpha beta gamma…'
    );
  });

  it('cuts mid-word only when the window holds no usable boundary', () => {
    expect(excerptFromContent('a'.repeat(50), 10)).toBe('aaaaaaaaaa…');
  });

  it('drops an entity the cut left half-written', () => {
    // Without the trim this reads `abcdefghij&am…` — a visible `&am` in the UI.
    expect(excerptFromContent('abcdefghij&amp;klmnopqrst', 13)).toBe('abcdefghij…');
  });

  it('returns empty for markup with no text', () => {
    expect(excerptFromContent('<img src="x.png"><br/>')).toBe('');
  });
});
