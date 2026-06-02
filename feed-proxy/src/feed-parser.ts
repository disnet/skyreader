import { XMLParser } from 'fast-xml-parser';
import type { ParsedFeed, FeedItem } from './types';

// Pre-compiled regex patterns for XML entity decoding
// IMPORTANT: &amp; must be decoded LAST to avoid double-decoding
// (e.g., &amp;lt; should become &lt;, not <)
const HTML_ENTITY_PATTERNS: Array<[RegExp, string]> = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&apos;/g, "'"],
  [/&nbsp;/g, ' '],
  [/&amp;/g, '&'],
];
const NUMERIC_ENTITY_PATTERN = /&#(\d+);/g;
const HEX_ENTITY_PATTERN = /&#x([0-9a-f]+);/gi;

const MAX_ITEMS_TO_PARSE = 30;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  trimValues: true,
  parseTagValue: false,
  processEntities: false,
  isArray: (name) => ['item', 'entry', 'link', 'category'].includes(name),
});

export function parseFeed(content: string, feedUrl: string): ParsedFeed {
  const trimmed = content.trim();

  // Check if it's JSON Feed
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
  if (
    trimmed.toLowerCase().startsWith('<!doctype html') ||
    trimmed.toLowerCase().startsWith('<html')
  ) {
    throw new Error(`URL returned HTML instead of a feed: ${feedUrl}`);
  }

  const doc = parser.parse(content);

  if (doc.feed) {
    return parseAtomFeed(doc.feed, feedUrl);
  }
  if (doc.rss?.channel) {
    return parseRssFeed(doc.rss.channel, feedUrl);
  }
  if (doc['rdf:RDF']) {
    return parseRdfFeed(doc['rdf:RDF'], feedUrl);
  }

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
    const author = item.author?.name || item.authors?.[0]?.name;
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
      title,
      author,
      content,
      summary,
      imageUrl,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }

  const description = getText(channel.description);
  return {
    title: getText(channel.title) || 'Untitled Feed',
    description,
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
      title,
      author,
      content,
      summary,
      publishedAt: updated ? new Date(updated).toISOString() : new Date().toISOString(),
    });
  }

  const subtitle = getText(feed.subtitle);
  return {
    title: getText(feed.title) || 'Untitled Feed',
    description: subtitle,
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
      title,
      author,
      content,
      summary,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }

  const rdfDescription = getText(channel.description);
  return {
    title: getText(channel.title) || 'Untitled Feed',
    description: rdfDescription,
    siteUrl: getText(channel.link),
    imageUrl: rdf.image?.url ? getText(rdf.image.url) : undefined,
    items,
    fetchedAt: Date.now(),
  };
}

function getTextRaw(node: any): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.length > 0 ? getTextRaw(node[0]) : undefined;
  if (typeof node === 'object') {
    if (node['#cdata'] !== undefined) return getTextRaw(node['#cdata']);
    if (node['#text'] !== undefined) return getTextRaw(node['#text']);
    for (const key of Object.keys(node)) {
      const val = getTextRaw(node[key]);
      if (val) return val;
    }
  }
  return undefined;
}

function getText(node: any): string | undefined {
  const raw = getTextRaw(node);
  return raw !== undefined ? decodeHtmlEntities(raw) : undefined;
}

function getAtomLink(links: any, rel: string): string | undefined {
  if (!links) return undefined;
  const linkArray = Array.isArray(links) ? links : [links];

  for (const link of linkArray) {
    const linkRel = link['@_rel'] || 'alternate';
    if (linkRel === rel && link['@_href']) return decodeHtmlEntities(link['@_href']);
  }

  for (const link of linkArray) {
    if (link['@_href']) return decodeHtmlEntities(link['@_href']);
  }

  return undefined;
}

function extractRssItemImage(item: any): string | undefined {
  if (item['media:content']) {
    const media = Array.isArray(item['media:content'])
      ? item['media:content'][0]
      : item['media:content'];
    if (media['@_url']) return decodeHtmlEntities(media['@_url']);
  }

  if (item['media:thumbnail']) {
    const thumb = Array.isArray(item['media:thumbnail'])
      ? item['media:thumbnail'][0]
      : item['media:thumbnail'];
    if (thumb['@_url']) return decodeHtmlEntities(thumb['@_url']);
  }

  if (item.enclosure) {
    const enc = Array.isArray(item.enclosure) ? item.enclosure[0] : item.enclosure;
    if (enc['@_type']?.startsWith('image') && enc['@_url']) return decodeHtmlEntities(enc['@_url']);
  }

  return undefined;
}

function generateGuid(title: string): string {
  return `guid-${title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .substring(0, 50)}`;
}

function decodeHtmlEntities(text: string): string {
  if (typeof text !== 'string') return String(text ?? '');

  let decoded = text;
  for (const [pattern, replacement] of HTML_ENTITY_PATTERNS) {
    decoded = decoded.replace(pattern, replacement);
  }

  decoded = decoded.replace(NUMERIC_ENTITY_PATTERN, (_, num) => {
    try {
      return String.fromCodePoint(parseInt(num, 10));
    } catch {
      return `&#${num};`;
    }
  });
  decoded = decoded.replace(HEX_ENTITY_PATTERN, (_, hex) => {
    try {
      return String.fromCodePoint(parseInt(hex, 16));
    } catch {
      return `&#x${hex};`;
    }
  });

  return decoded;
}
