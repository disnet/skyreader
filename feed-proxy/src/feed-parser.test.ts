import { describe, expect, it } from 'bun:test';
import { parseFeed } from './feed-parser';

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
		it('limits items to MAX_ITEMS_TO_PARSE (30)', () => {
			const items = Array.from({ length: 50 }, (_, i) => `
        <item>
          <title>Post ${i + 1}</title>
          <link>https://example.com/post-${i + 1}</link>
          <guid>post-${i + 1}</guid>
        </item>
      `).join('');

			const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Big Feed</title>
    <link>https://example.com</link>
    ${items}
  </channel>
</rss>`;

			const result = parseFeed(rss, 'https://example.com/feed.xml');

			expect(result.items).toHaveLength(30);
			expect(result.items[0].title).toBe('Post 1');
			expect(result.items[29].title).toBe('Post 30');
		});
	});
});
