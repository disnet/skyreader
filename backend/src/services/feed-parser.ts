import { XMLParser } from 'fast-xml-parser';
import type { ParsedFeed, FeedItem } from '../types';

// Pre-compiled regex patterns for HTML entity decoding (avoid creating on each call)
const HTML_ENTITY_PATTERNS: Array<[RegExp, string]> = [
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&apos;/g, "'"],
  [/&nbsp;/g, ' '],
];
const NUMERIC_ENTITY_PATTERN = /&#(\d+);/g;
const HEX_ENTITY_PATTERN = /&#x([0-9a-f]+);/gi;

// Limit items parsed to prevent CPU exhaustion on large feeds
const MAX_ITEMS_TO_PARSE = 100;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => ['item', 'entry', 'link', 'category'].includes(name),
});

export function parseFeed(content: string, feedUrl: string): ParsedFeed {
  // Check if it's JSON Feed
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(content);
      if (json.version && json.version.startsWith('https://jsonfeed.org/')) {
        return parseJsonFeed(json, feedUrl);
      }
    } catch {
      // Not valid JSON, continue to XML parsing
    }
  }

  // Check if it looks like HTML instead of XML
  if (trimmed.toLowerCase().startsWith('<!doctype html') || trimmed.toLowerCase().startsWith('<html')) {
    throw new Error(`URL returned HTML instead of a feed: ${feedUrl}`);
  }

  const doc = parser.parse(content);

  // Detect feed type
  if (doc.feed) {
    return parseAtomFeed(doc.feed, feedUrl);
  }
  if (doc.rss?.channel) {
    return parseRssFeed(doc.rss.channel, feedUrl);
  }
  if (doc['rdf:RDF']) {
    return parseRdfFeed(doc['rdf:RDF'], feedUrl);
  }

  // Log what we got for debugging
  const keys = Object.keys(doc).join(', ');
  throw new Error(`Unknown feed format. Root elements: ${keys || 'none'}`);
}

function parseJsonFeed(json: any, feedUrl: string): ParsedFeed {
  const items: FeedItem[] = [];

  const jsonItems = json.items || [];
  for (const item of jsonItems) {
    if (items.length >= MAX_ITEMS_TO_PARSE) break;
    const title = item.title || 'Untitled';
    const url = item.url || item.external_url || '';
    const guid = item.id || url || generateGuid(title);
    const author = item.author?.name || (item.authors?.[0]?.name);
    const content = item.content_html || item.content_text;
    const summary = item.summary;
    const imageUrl = item.image || item.banner_image;
    const pubDate = item.date_published || item.date_modified;

    items.push({
      guid,
      url,
      title,
      author,
      content,
      summary,
      imageUrl,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }

  return {
    title: json.title || 'Untitled Feed',
    description: json.description,
    siteUrl: json.home_page_url,
    imageUrl: json.icon || json.favicon,
    items,
    fetchedAt: Date.now(),
  };
}

function parseRssFeed(channel: any, feedUrl: string): ParsedFeed {
  const items: FeedItem[] = [];

  const rawItems = channel.item || [];
  for (const item of rawItems) {
    if (items.length >= MAX_ITEMS_TO_PARSE) break;
    const title = getText(item.title) || 'Untitled';
    const url = getText(item.link) || '';
    const guid = getText(item.guid) || url || generateGuid(title);
    const author = getText(item.author) || getText(item['dc:creator']);
    const content = getText(item['content:encoded']) || getText(item.description);
    const summary = getText(item.description);
    const pubDate = getText(item.pubDate) || getText(item['dc:date']);
    const imageUrl = extractRssItemImage(item);

    items.push({
      guid,
      url,
      title: decodeHtmlEntities(title),
      author: author ? decodeHtmlEntities(author) : undefined,
      content: content ? decodeHtmlEntities(content) : undefined,
      summary: summary ? decodeHtmlEntities(summary) : undefined,
      imageUrl,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }

  const description = getText(channel.description);
  return {
    title: decodeHtmlEntities(getText(channel.title) || 'Untitled Feed'),
    description: description ? decodeHtmlEntities(description) : undefined,
    siteUrl: getText(channel.link),
    imageUrl: channel.image?.url ? getText(channel.image.url) : undefined,
    items,
    fetchedAt: Date.now(),
  };
}

function parseAtomFeed(feed: any, feedUrl: string): ParsedFeed {
  const items: FeedItem[] = [];

  const entries = feed.entry || [];
  for (const entry of entries) {
    if (items.length >= MAX_ITEMS_TO_PARSE) break;
    const title = getText(entry.title) || 'Untitled';
    const url = getAtomLink(entry.link, 'alternate') || '';
    const guid = getText(entry.id) || url || generateGuid(title);
    const author = entry.author?.name ? getText(entry.author.name) : undefined;
    const content = getText(entry.content) || getText(entry.summary);
    const summary = getText(entry.summary);
    const updated = getText(entry.updated) || getText(entry.published);

    items.push({
      guid,
      url,
      title: decodeHtmlEntities(title),
      author: author ? decodeHtmlEntities(author) : undefined,
      content: content ? decodeHtmlEntities(content) : undefined,
      summary: summary ? decodeHtmlEntities(summary) : undefined,
      publishedAt: updated ? new Date(updated).toISOString() : new Date().toISOString(),
    });
  }

  const subtitle = getText(feed.subtitle);
  return {
    title: decodeHtmlEntities(getText(feed.title) || 'Untitled Feed'),
    description: subtitle ? decodeHtmlEntities(subtitle) : undefined,
    siteUrl: getAtomLink(feed.link, 'alternate'),
    imageUrl: getText(feed.icon) || getText(feed.logo),
    items,
    fetchedAt: Date.now(),
  };
}

function parseRdfFeed(rdf: any, feedUrl: string): ParsedFeed {
  const items: FeedItem[] = [];
  const channel = rdf.channel || {};

  const rawItems = rdf.item || [];
  for (const item of rawItems) {
    if (items.length >= MAX_ITEMS_TO_PARSE) break;
    const title = getText(item.title) || 'Untitled';
    const url = getText(item.link) || '';
    const guid = url || generateGuid(title);
    const author = getText(item['dc:creator']);
    const content = getText(item['content:encoded']) || getText(item.description);
    const summary = getText(item.description);
    const pubDate = getText(item['dc:date']);

    items.push({
      guid,
      url,
      title: decodeHtmlEntities(title),
      author: author ? decodeHtmlEntities(author) : undefined,
      content: content ? decodeHtmlEntities(content) : undefined,
      summary: summary ? decodeHtmlEntities(summary) : undefined,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }

  const rdfDescription = getText(channel.description);
  return {
    title: decodeHtmlEntities(getText(channel.title) || 'Untitled Feed'),
    description: rdfDescription ? decodeHtmlEntities(rdfDescription) : undefined,
    siteUrl: getText(channel.link),
    imageUrl: rdf.image?.url ? getText(rdf.image.url) : undefined,
    items,
    fetchedAt: Date.now(),
  };
}

// Extract text from a node that may be a string, object with #text/#cdata, or nested
function getText(node: any): string | undefined {
  if (node === undefined || node === null) {
    return undefined;
  }
  if (typeof node === 'string') {
    return node;
  }
  if (typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    // Handle arrays (take first element)
    return node.length > 0 ? getText(node[0]) : undefined;
  }
  if (typeof node === 'object') {
    // Handle CDATA (recursively in case it's nested)
    if (node['#cdata'] !== undefined) {
      return getText(node['#cdata']);
    }
    // Handle text node
    if (node['#text'] !== undefined) {
      return getText(node['#text']);
    }
    // Try to find any string value in the object
    for (const key of Object.keys(node)) {
      const val = getText(node[key]);
      if (val) return val;
    }
  }
  return undefined;
}

function getAtomLink(links: any, rel: string): string | undefined {
  if (!links) return undefined;

  const linkArray = Array.isArray(links) ? links : [links];
  for (const link of linkArray) {
    const linkRel = link['@_rel'] || 'alternate';
    if (linkRel === rel && link['@_href']) {
      return link['@_href'];
    }
  }

  // Fallback: return first link with href
  for (const link of linkArray) {
    if (link['@_href']) {
      return link['@_href'];
    }
  }

  return undefined;
}

function extractRssItemImage(item: any): string | undefined {
  // media:content
  if (item['media:content']) {
    const media = Array.isArray(item['media:content']) ? item['media:content'][0] : item['media:content'];
    if (media['@_url']) {
      return media['@_url'];
    }
  }

  // media:thumbnail
  if (item['media:thumbnail']) {
    const thumb = Array.isArray(item['media:thumbnail']) ? item['media:thumbnail'][0] : item['media:thumbnail'];
    if (thumb['@_url']) {
      return thumb['@_url'];
    }
  }

  // enclosure with image type
  if (item.enclosure) {
    const enc = Array.isArray(item.enclosure) ? item.enclosure[0] : item.enclosure;
    if (enc['@_type']?.startsWith('image') && enc['@_url']) {
      return enc['@_url'];
    }
  }

  return undefined;
}

function generateGuid(title: string): string {
  return `guid-${title.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 50)}`;
}

function decodeHtmlEntities(text: string): string {
  if (typeof text !== 'string') {
    return String(text ?? '');
  }

  let decoded = text;
  for (const [pattern, replacement] of HTML_ENTITY_PATTERNS) {
    decoded = decoded.replace(pattern, replacement);
  }

  // Handle numeric entities
  decoded = decoded.replace(NUMERIC_ENTITY_PATTERN, (_, num) => String.fromCharCode(parseInt(num, 10)));
  decoded = decoded.replace(HEX_ENTITY_PATTERN, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  return decoded;
}

// Discover RSS feeds from a URL
export async function discoverFeeds(url: string): Promise<string[]> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)',
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

  // Parse HTML to find link tags
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
          headers: { 'User-Agent': 'Skyreader/1.0' },
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
