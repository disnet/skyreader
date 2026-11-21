import { describe, it, expect } from 'vitest';
import type { SavedItem } from '$lib/types';
import {
  savesFrom,
  savedFromLabel,
  savedFromLibraryHref,
  savedFromKey,
  webUrlOrNull,
} from './savedFrom';

function save(rkey: string, savedAt: string, from?: string, fromTitle?: string): SavedItem {
  return {
    rkey,
    uri: `at://did:plc:x/app.skyreader.feed.saved/${rkey}`,
    url: `https://cited.example/${rkey}`,
    title: rkey,
    author: null,
    description: null,
    content: null,
    contentType: 'webpage',
    domain: null,
    image: null,
    wordCount: null,
    publishedAt: null,
    savedAt,
    savedFromUrl: from ?? null,
    savedFromTitle: fromTitle ?? null,
  };
}

const SOURCE = 'https://essays.example/how-cities-remember';

describe('savesFrom', () => {
  it('lists the saves made out of one article, newest first, whatever its spelling', () => {
    const saves = [
      save('a', '2026-11-01T10:00:00Z', SOURCE),
      save('b', '2026-11-01T10:05:00Z', `${SOURCE}/?utm_source=rss`),
      save('c', '2026-11-01T10:06:00Z', 'https://elsewhere.example/post'),
      save('d', '2026-11-01T10:07:00Z'),
    ];
    expect(savesFrom(saves, SOURCE).map((s) => s.rkey)).toEqual(['b', 'a']);
    expect(savesFrom(saves, `${SOURCE}/`).map((s) => s.rkey)).toEqual(['b', 'a']);
  });

  it('is empty for an article with no link', () => {
    expect(savesFrom([save('a', '2026-11-01T10:00:00Z', SOURCE)], '')).toEqual([]);
    expect(savesFrom([save('a', '2026-11-01T10:00:00Z', SOURCE)], null)).toEqual([]);
    expect(savedFromKey(undefined)).toBeNull();
  });
});

describe('savedFromLabel', () => {
  it('names the source by its title, else its host', () => {
    expect(savedFromLabel({ savedFromUrl: SOURCE, savedFromTitle: 'How Cities Remember' })).toBe(
      'How Cities Remember'
    );
    expect(
      savedFromLabel({ savedFromUrl: 'https://www.essays.example/x', savedFromTitle: ' ' })
    ).toBe('essays.example');
  });
});

describe('savedFromLibraryHref', () => {
  it('points the Library at the article', () => {
    expect(savedFromLibraryHref('https://a.example/x?y=1&z=2')).toBe(
      '/saved?from=https%3A%2F%2Fa.example%2Fx%3Fy%3D1%26z%3D2'
    );
  });
});

describe('webUrlOrNull', () => {
  it('passes a web link and refuses the rest', () => {
    expect(webUrlOrNull('https://a.example/x')).toBe('https://a.example/x');
    expect(webUrlOrNull('http://a.example/x')).toBe('http://a.example/x');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'not a url', '', null]) {
      expect(webUrlOrNull(bad)).toBeNull();
    }
  });
});
