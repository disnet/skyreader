import { describe, expect, it } from 'vitest';
import {
  BLUESKY_MAX_GRAPHEMES,
  discussionLinkText,
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

  it('drops a URL the cut would land inside, rather than link half of it', () => {
    const long = `See https://example.com/${'a'.repeat(40)} for more`;
    expect(fitGraphemes(long, 30)).toEqual({ text: 'See…', trimmed: true });
  });

  it('drops a hashtag the cut would land inside, rather than tag half of it', () => {
    const long = `See #${'a'.repeat(40)} for more`;
    expect(fitGraphemes(long, 30)).toEqual({ text: 'See…', trimmed: true });
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
    // The uncut length, so the count ring can show how far over it is.
    expect(plan.length).toBeGreaterThan(BLUESKY_MAX_GRAPHEMES);
  });

  it('without text shots: quotes read inline, in draft order, and no link text', () => {
    const plan = planBlueskyPost([quote('A line\nbroken.'), text('My take.')], URL, {
      textShots: false,
    });
    expect(plan).toEqual({
      text: '“A line broken.”\n\nMy take.',
      shots: [],
      trimmed: false,
      length: 26,
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

describe('the Discussion link', () => {
  const PAGE = `https://read.skyreader.app/${URL}`;

  it('shows the read host whole, then the article without its scheme, shortened', () => {
    expect(discussionLinkText(PAGE, URL)).toBe('read.skyreader.app/example.com/essays/…');
    expect(
      discussionLinkText(`https://staging-read.skyreader.app/${URL}`, URL).startsWith(
        'staging-read.skyreader.app/example.com/'
      )
    ).toBe(true);
    expect(discussionLinkText('https://read.skyreader.app/https://a.io/', 'https://a.io/')).toBe(
      'read.skyreader.app/a.io'
    );
  });

  it("keeps a dev host's /link prefix", () => {
    expect(discussionLinkText('http://127.0.0.1:5175/link/https://a.io/x', 'https://a.io/x')).toBe(
      '127.0.0.1:5175/link/a.io/x'
    );
  });

  it('ends a link-card post on the Discussion line', () => {
    const plan = planBlueskyPost([text('My take.')], URL, {
      textShots: false,
      discussionUrl: PAGE,
    });
    const line = `Discussion: ${discussionLinkText(PAGE, URL)}`;
    expect(plan.text).toBe(`My take.\n\n${line}`);
    expect(plan.discussionText).toBe(discussionLinkText(PAGE, URL));
    expect(plan.length).toBe(graphemeLength(plan.text));
  });

  it('is the whole text of a post with nothing written', () => {
    const plan = planBlueskyPost([text('')], URL, { textShots: false, discussionUrl: PAGE });
    expect(plan.text).toBe(`Discussion: ${discussionLinkText(PAGE, URL)}`);
  });

  it('follows the article link in a post with text shots', () => {
    const plan = planBlueskyPost([quote('q'), text('Worth it.')], URL, {
      textShots: true,
      discussionUrl: PAGE,
    });
    expect(plan.text).toBe(
      `Worth it.\n\n${shortLink(URL)}\nDiscussion: ${discussionLinkText(PAGE, URL)}`
    );
  });

  it('survives a trim: the commentary is cut, never the links', () => {
    for (const textShots of [true, false]) {
      const plan = planBlueskyPost([quote('q'), text('word '.repeat(100))], URL, {
        textShots,
        discussionUrl: PAGE,
      });
      expect(plan.trimmed).toBe(true);
      expect(graphemeLength(plan.text)).toBeLessThanOrEqual(BLUESKY_MAX_GRAPHEMES);
      expect(plan.text.endsWith(`Discussion: ${discussionLinkText(PAGE, URL)}`)).toBe(true);
    }
  });
});
