import Defuddle from 'defuddle';
import { api } from '$lib/services/api';

interface ExtractedArticle {
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  domain: string | null;
  image: string | null;
  published: string | null;
  wordCount: number;
}

function toValidISODate(value: string | undefined): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (isNaN(ms)) return null;
  // Reject dates before 1990 or in the future
  if (ms < 631152000000 || ms > Date.now() + 86400000) return null;
  return new Date(ms).toISOString();
}

/**
 * Fetch HTML via the proxy and extract article content client-side using Defuddle.
 */
export async function extractArticle(url: string): Promise<ExtractedArticle> {
  const html = await api.fetchHtml(url);

  const doc = new DOMParser().parseFromString(html, 'text/html');

  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Failed to parse HTML from URL');
  }

  // Set the base URL so relative URLs resolve correctly
  const base = doc.createElement('base');
  base.href = url;
  doc.head.prepend(base);

  const result = new Defuddle(doc, { url }).parse();

  return {
    title: result.title || null,
    author: result.author || null,
    description: result.description || null,
    content: result.content || null,
    domain: result.domain || null,
    image: result.image || null,
    published: toValidISODate(result.published),
    wordCount: result.wordCount || 0,
  };
}
