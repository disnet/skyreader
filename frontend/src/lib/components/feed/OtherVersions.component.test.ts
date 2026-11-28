import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import OtherVersions from './OtherVersions.svelte';
import type { SavedItem } from '$lib/types';

const item = (rkey: string, url: string, extra: Partial<SavedItem> = {}): SavedItem => ({
  rkey,
  uri: `at://did:plc:me/app.skyreader.feed.saved/${rkey}`,
  url,
  title: rkey,
  author: null,
  description: null,
  content: null,
  contentType: 'webpage',
  domain: null,
  image: null,
  wordCount: null,
  publishedAt: null,
  savedAt: '2026-01-01T00:00:00Z',
  ...extra,
});

const abs = item('a', 'https://arxiv.org/abs/2401.12345');
const pdf = item('b', 'https://arxiv.org/pdf/2401.12345', { contentType: 'pdf' });
const other = item('c', 'https://blog.example/post');
let articles: SavedItem[] = [];
const highlights: Record<string, unknown[]> = {};

vi.mock('$lib/stores/saves.svelte', () => ({
  savesStore: {
    get articles() {
      return articles;
    },
  },
}));
vi.mock('$lib/stores/itemLabels.svelte', () => ({
  itemLabelsStore: { getHighlights: (key: string) => highlights[key] ?? [] },
}));
vi.mock('$lib/utils/openInReader', () => ({ openKeyInReader: vi.fn(() => true) }));

let host: HTMLElement;
let instance: ReturnType<typeof mount> | null = null;
function render(save: SavedItem, place: 'header' | 'end' = 'header') {
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(OtherVersions, { target: host, props: { save, place } });
  flushSync();
}

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host?.remove();
  for (const key of Object.keys(highlights)) delete highlights[key];
});

const noted = {
  id: 'h1',
  selector: { type: 'TextQuoteSelector', exact: 'a key result' },
  createdAt: 1,
  note: 'check this',
};

describe('OtherVersions', () => {
  it('names the other versions under the title, with their highlight counts', () => {
    articles = [abs, pdf, other];
    highlights[pdf.uri] = [noted];
    render(abs);
    const text = host.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    expect(text).toBe('You also saved this paper as the PDF (1 highlight).');
    expect(host.querySelector('a')?.getAttribute('href')).toBe(
      `/saved?read=${encodeURIComponent(pdf.uri)}`
    );
    expect(host.querySelector('blockquote')).toBeNull();
  });

  it('joins several versions into one sentence', () => {
    const link = item('d', 'https://doi.org/10.48550/arXiv.2401.12345');
    articles = [abs, pdf, link];
    render(abs);
    const text = host.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    expect(text).toBe('You also saved this paper as the PDF and the DOI link.');
  });

  it("shows the other versions' highlights at the end", () => {
    articles = [abs, pdf, other];
    highlights[pdf.uri] = [noted];
    render(abs, 'end');
    expect(host.querySelector('blockquote')?.textContent).toBe('a key result');
    expect(host.querySelector('.note')?.textContent).toBe('check this');
  });

  it('shows nothing at the end when the other versions have no highlights', () => {
    articles = [abs, pdf];
    render(abs, 'end');
    expect(host.querySelector('.other-versions')).toBeNull();
  });

  it('is absent for a save with no other version', () => {
    articles = [abs, other];
    render(other);
    expect(host.textContent?.trim()).toBe('');
  });
});
