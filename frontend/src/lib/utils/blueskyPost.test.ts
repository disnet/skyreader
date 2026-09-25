import { describe, expect, it } from 'vitest';
import {
  BLUESKY_MAX_GRAPHEMES,
  fitGraphemes,
  graphemeLength,
  planBlueskyPost,
  shortLink,
} from './blueskyPost';
import type { ShareDraftBlock } from '$lib/types';

const URL = 'https://www.example.com/essays/2026/on-reading-slowly';
const text = (t: string): ShareDraftBlock => ({ kind: 'text', text: t });
const quote = (t: string): ShareDraftBlock => ({ kind: 'quote', text: t });

describe('shortLink', () => {
  it('drops the scheme and www, and shortens a long path', () => {
    const link = shortLink(URL);
    expect(link.startsWith('example.com/essays/')).toBe(true);
    expect(link.endsWith('…')).toBe(true);
    expect(graphemeLength(link)).toBe(32);
  });

  it('leaves a short link whole', () => {
    expect(shortLink('https://example.com/')).toBe('example.com');
  });
});

describe('fitGraphemes', () => {
  it('leaves text that fits alone', () => {
    expect(fitGraphemes('hello', 10)).toEqual({ text: 'hello', trimmed: false });
  });

  it('cuts at a word boundary and adds an ellipsis', () => {
    const result = fitGraphemes('the quick brown fox jumps', 18);
    expect(result).toEqual({ text: 'the quick brown…', trimmed: true });
  });

  it('counts emoji as one character', () => {
    expect(fitGraphemes('👩‍👩‍👧👩‍👩‍👧', 2).trimmed).toBe(false);
  });
});

describe('planBlueskyPost', () => {
  it('with text shots: commentary + link in the text, quotes as images', () => {
    const plan = planBlueskyPost(
      [quote('First passage.'), text('Worth reading.'), quote('Second.'), text('')],
      URL,
      { textShots: true }
    );
    expect(plan.shots).toEqual(['First passage.', 'Second.']);
    expect(plan.linkText).toBe(shortLink(URL));
    expect(plan.text).toBe(`Worth reading.\n\n${shortLink(URL)}`);
    expect(plan.trimmed).toBe(false);
  });

  it('with text shots and no commentary, the text is just the link', () => {
    const plan = planBlueskyPost([quote('Only a quote.')], URL, { textShots: true });
    expect(plan.text).toBe(shortLink(URL));
  });

  it('keeps at most four images and says how many were left out', () => {
    const plan = planBlueskyPost(['a', 'b', 'c', 'd', 'e', 'f'].map(quote), URL, {
      textShots: true,
    });
    expect(plan.shots).toEqual(['a', 'b', 'c', 'd']);
    expect(plan.droppedQuotes).toBe(2);
  });

  it('trims long commentary but always keeps the link', () => {
    const plan = planBlueskyPost([quote('q'), text('word '.repeat(100))], URL, {
      textShots: true,
    });
    expect(plan.trimmed).toBe(true);
    expect(graphemeLength(plan.text)).toBeLessThanOrEqual(BLUESKY_MAX_GRAPHEMES);
    expect(plan.text.endsWith(shortLink(URL))).toBe(true);
  });

  it('without text shots: quotes read inline, in draft order, and no link text', () => {
    const plan = planBlueskyPost([quote('A line\nbroken.'), text('My take.')], URL, {
      textShots: false,
    });
    expect(plan).toEqual({
      text: '“A line broken.”\n\nMy take.',
      shots: [],
      trimmed: false,
      droppedQuotes: 0,
    });
  });

  it('without quotes, text shots change nothing', () => {
    const plan = planBlueskyPost([text('Just commentary.')], URL, { textShots: true });
    expect(plan.text).toBe('Just commentary.');
    expect(plan.shots).toEqual([]);
    expect(plan.linkText).toBeUndefined();
  });
});
