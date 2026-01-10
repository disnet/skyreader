import type { ParsedFeed, FeedItem } from '../types';

// Simple XML parser for RSS/Atom feeds
export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  // Detect feed type
  const isAtom = xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"');

  if (isAtom) {
    return parseAtomFeed(xml, feedUrl);
  }
  return parseRssFeed(xml, feedUrl);
}

function parseRssFeed(xml: string, feedUrl: string): ParsedFeed {
  const items: FeedItem[] = [];

  // Extract channel info
  const channelMatch = xml.match(/<channel>([\s\S]*?)<\/channel>/);
  const channelContent = channelMatch ? channelMatch[1] : xml;

  const title = extractTag(channelContent, 'title') || 'Untitled Feed';
  const description = extractTag(channelContent, 'description');
  const siteUrl = extractTag(channelContent, 'link');
  const imageUrl = extractImageUrl(channelContent);

  // Extract items
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemContent = match[1];

    const itemTitle = extractTag(itemContent, 'title') || 'Untitled';
    const itemUrl = extractTag(itemContent, 'link') || '';
    const guid = extractTag(itemContent, 'guid') || itemUrl || generateGuid(itemTitle);
    const author = extractTag(itemContent, 'author') || extractTag(itemContent, 'dc:creator');
    const content = extractTag(itemContent, 'content:encoded') || extractTag(itemContent, 'description');
    const summary = extractTag(itemContent, 'description');
    const pubDate = extractTag(itemContent, 'pubDate');
    const itemImage = extractMediaContent(itemContent) || extractEnclosure(itemContent);

    items.push({
      guid,
      url: itemUrl,
      title: decodeHtmlEntities(itemTitle),
      author: author ? decodeHtmlEntities(author) : undefined,
      content: content ? decodeHtmlEntities(content) : undefined,
      summary: summary ? decodeHtmlEntities(summary) : undefined,
      imageUrl: itemImage,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }

  return {
    title: decodeHtmlEntities(title),
    description: description ? decodeHtmlEntities(description) : undefined,
    siteUrl,
    imageUrl,
    items,
    fetchedAt: Date.now(),
  };
}

function parseAtomFeed(xml: string, feedUrl: string): ParsedFeed {
  const items: FeedItem[] = [];

  const title = extractTag(xml, 'title') || 'Untitled Feed';
  const description = extractTag(xml, 'subtitle');
  const siteUrl = extractAtomLink(xml, 'alternate');
  const imageUrl = extractTag(xml, 'icon') || extractTag(xml, 'logo');

  // Extract entries
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryContent = match[1];

    const entryTitle = extractTag(entryContent, 'title') || 'Untitled';
    const entryUrl = extractAtomLink(entryContent, 'alternate') || '';
    const guid = extractTag(entryContent, 'id') || entryUrl || generateGuid(entryTitle);
    const author = extractAtomAuthor(entryContent);
    const content = extractTag(entryContent, 'content') || extractTag(entryContent, 'summary');
    const summary = extractTag(entryContent, 'summary');
    const updated = extractTag(entryContent, 'updated') || extractTag(entryContent, 'published');

    items.push({
      guid,
      url: entryUrl,
      title: decodeHtmlEntities(entryTitle),
      author: author ? decodeHtmlEntities(author) : undefined,
      content: content ? decodeHtmlEntities(content) : undefined,
      summary: summary ? decodeHtmlEntities(summary) : undefined,
      publishedAt: updated ? new Date(updated).toISOString() : new Date().toISOString(),
    });
  }

  return {
    title: decodeHtmlEntities(title),
    description: description ? decodeHtmlEntities(description) : undefined,
    siteUrl,
    imageUrl,
    items,
    fetchedAt: Date.now(),
  };
}

function extractTag(content: string, tagName: string): string | undefined {
  // Handle CDATA
  const cdataRegex = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`, 'i');
  const cdataMatch = content.match(cdataRegex);
  if (cdataMatch) {
    return cdataMatch[1].trim();
  }

  // Handle regular tags
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = content.match(regex);
  return match ? match[1].trim() : undefined;
}

function extractAtomLink(content: string, rel: string): string | undefined {
  const regex = new RegExp(`<link[^>]*rel=["']${rel}["'][^>]*href=["']([^"']+)["']`, 'i');
  const match = content.match(regex);
  if (match) return match[1];

  // Try alternate format
  const regex2 = new RegExp(`<link[^>]*href=["']([^"']+)["'][^>]*rel=["']${rel}["']`, 'i');
  const match2 = content.match(regex2);
  return match2 ? match2[1] : undefined;
}

function extractAtomAuthor(content: string): string | undefined {
  const authorMatch = content.match(/<author>([\s\S]*?)<\/author>/i);
  if (!authorMatch) return undefined;
  return extractTag(authorMatch[1], 'name');
}

function extractImageUrl(content: string): string | undefined {
  // Try image tag
  const imageMatch = content.match(/<image>([\s\S]*?)<\/image>/i);
  if (imageMatch) {
    return extractTag(imageMatch[1], 'url');
  }
  return undefined;
}

function extractMediaContent(content: string): string | undefined {
  const regex = /<media:content[^>]*url=["']([^"']+)["']/i;
  const match = content.match(regex);
  return match ? match[1] : undefined;
}

function extractEnclosure(content: string): string | undefined {
  const regex = /<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image/i;
  const match = content.match(regex);
  return match ? match[1] : undefined;
}

function generateGuid(title: string): string {
  return `guid-${title.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 50)}`;
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };

  let decoded = text;
  for (const [entity, char] of Object.entries(entities)) {
    decoded = decoded.replace(new RegExp(entity, 'g'), char);
  }

  // Handle numeric entities
  decoded = decoded.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  return decoded;
}

// Discover RSS feeds from a URL
export async function discoverFeeds(url: string): Promise<string[]> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'AT-RSS/1.0 (+https://at-rss.example.com)',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  const contentType = response.headers.get('Content-Type') || '';
  const text = await response.text();

  // If it's already a feed, return the URL
  if (contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom')) {
    return [url];
  }

  // Look for link tags in HTML
  const feeds: string[] = [];
  const linkRegex = /<link[^>]*type=["'](application\/rss\+xml|application\/atom\+xml)["'][^>]*>/gi;
  let match;

  while ((match = linkRegex.exec(text)) !== null) {
    const hrefMatch = match[0].match(/href=["']([^"']+)["']/i);
    if (hrefMatch) {
      let feedUrl = hrefMatch[1];
      // Handle relative URLs
      if (!feedUrl.startsWith('http')) {
        const baseUrl = new URL(url);
        feedUrl = new URL(feedUrl, baseUrl).toString();
      }
      feeds.push(feedUrl);
    }
  }

  // Try common feed paths if no links found
  if (feeds.length === 0) {
    const commonPaths = ['/feed', '/rss', '/atom.xml', '/feed.xml', '/rss.xml', '/index.xml'];
    const baseUrl = new URL(url);

    for (const path of commonPaths) {
      try {
        const feedUrl = new URL(path, baseUrl).toString();
        const feedResponse = await fetch(feedUrl, {
          method: 'HEAD',
          headers: { 'User-Agent': 'AT-RSS/1.0' },
        });
        if (feedResponse.ok) {
          const ct = feedResponse.headers.get('Content-Type') || '';
          if (ct.includes('xml') || ct.includes('rss') || ct.includes('atom')) {
            feeds.push(feedUrl);
          }
        }
      } catch {
        // Ignore failed attempts
      }
    }
  }

  return feeds;
}
