import { describe, it, expect } from 'vitest';
import {
  ASK_AGENTS,
  askPrompt,
  askUrl,
  coerceAskAgentChoice,
  isValidCustomTemplate,
  resolveAskAgent,
} from './askAgent';

const claude = ASK_AGENTS.find((a) => a.id === 'claude')!;

describe('askPrompt', () => {
  it('names a save by its rkey, for the article and its highlights', () => {
    const prompt = askPrompt({
      title: 'How cities remember',
      url: 'https://essays.example/cities',
      rkey: '3abc',
      feedUrl: 'https://essays.example/feed.xml',
      guid: 'g1',
    });
    expect(prompt).toBe(
      "I'm reading “How cities remember” in Skyreader and want to talk it through with you.\n\n" +
        'https://essays.example/cities\n\n' +
        'If you have the Skyreader connector: get_saved_article with rkey "3abc" reads it, and ' +
        'list_highlights with that rkey has my highlights and notes.'
    );
  });

  it('names a feed item by its feed and guid, and its highlights by url', () => {
    const prompt = askPrompt({
      title: 'Post',
      url: 'https://blog.example/p',
      feedUrl: 'https://blog.example/feed.xml',
      guid: 'urn:1',
    });
    expect(prompt).toContain(
      'get_feed_item with feedUrl "https://blog.example/feed.xml" and guid "urn:1" reads it, and ' +
        'list_highlights with that url has my highlights and notes.'
    );
  });

  it('leaves out an address that is not a web link, and a missing title', () => {
    const prompt = askPrompt({ url: 'at://did:plc:x/app.bsky.feed.post/1' });
    expect(prompt).toBe("I'm reading this in Skyreader and want to talk it through with you.");
  });
});

describe('askUrl', () => {
  it('puts the encoded prompt where the agent takes it', () => {
    expect(askUrl(claude, 'a & b\nc')).toBe('https://claude.ai/new?q=a%20%26%20b%0Ac');
  });
});

describe('custom links', () => {
  it('takes only https links with a {prompt}', () => {
    expect(isValidCustomTemplate('https://kagi.com/assistant?q={prompt}')).toBe(true);
    expect(isValidCustomTemplate('https://kagi.com/assistant')).toBe(false);
    expect(isValidCustomTemplate('javascript:alert({prompt})')).toBe(false);
    expect(isValidCustomTemplate('http://insecure.example/?q={prompt}')).toBe(false);
  });

  it('resolves a custom favorite only when its link works', () => {
    expect(resolveAskAgent('custom', '')).toBeNull();
    expect(resolveAskAgent('custom', ' https://x.example/?q={prompt} ')?.template).toBe(
      'https://x.example/?q={prompt}'
    );
    expect(resolveAskAgent('chatgpt', '')?.name).toBe('ChatGPT');
  });
});

describe('coerceAskAgentChoice', () => {
  it('keeps a known choice and defaults anything else', () => {
    expect(coerceAskAgentChoice('perplexity')).toBe('perplexity');
    expect(coerceAskAgentChoice('off')).toBe('off');
    expect(coerceAskAgentChoice('gemini')).toBe('claude');
    expect(coerceAskAgentChoice(undefined)).toBe('claude');
  });
});
