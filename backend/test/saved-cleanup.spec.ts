import { describe, it, expect } from 'vitest';
import {
  isClickTrackingUrl,
  realTitle,
  saveDescription,
  saveDomain,
  withoutTrackingParams,
} from '../src/utils/saved-cleanup';

const strip = (url: string) => withoutTrackingParams(new URL(url)).href;

describe('withoutTrackingParams', () => {
  it('drops tracking and keeps the rest of the query as written', () => {
    expect(strip('https://a.com/p?utm_source=x&q=a%20b&UTM_Medium=y&mc_eid=1')).toBe(
      'https://a.com/p?q=a%20b'
    );
    expect(strip('https://a.com/p?utm_source=x#frag')).toBe('https://a.com/p#frag');
    expect(strip('https://a.com/p?flag&ref=home')).toBe('https://a.com/p?flag&ref=home');
    expect(strip('https://a.com/p?&utm_source=x')).toBe('https://a.com/p');
    expect(strip('https://a.com/p?a=1&&utm_source=x')).toBe('https://a.com/p?a=1');
    expect(strip('https://a.com/p?utm_source=x;id=5')).toBe('https://a.com/p?utm_source=x;id=5');
    expect(strip('https://a.com/p?view_token=abc&utm_medium=gift-link')).toBe(
      'https://a.com/p?view_token=abc'
    );
  });
});

describe('isClickTrackingUrl', () => {
  it('knows newsletter click links from article links', () => {
    expect(isClickTrackingUrl('https://link.mail.beehiiv.com/ss/c/u001.abc/4s4/x')).toBe(true);
    expect(isClickTrackingUrl('https://elink835.www.garbageday.email/ss/c/u001.x')).toBe(true);
    expect(isClickTrackingUrl('https://substack.com/redirect/2/eyJ1')).toBe(true);
    expect(isClickTrackingUrl('https://x.us1.list-manage.com/track/click?u=1')).toBe(true);
    expect(isClickTrackingUrl('https://example.substack.com/p/post')).toBe(false);
    expect(isClickTrackingUrl('https://example.com/ss/cats')).toBe(false);
    expect(isClickTrackingUrl('not a url')).toBe(false);
  });
});

describe('realTitle and saveDescription', () => {
  it('drops placeholder titles', () => {
    expect(realTitle(' Unnamed Document ')).toBeNull();
    expect(realTitle('Untitled')).toBeNull();
    expect(realTitle('Attention Is All You Need')).toBe('Attention Is All You Need');
  });

  it('keeps a body-less save’s description as it came', () => {
    const html = '<p>The <em>whole</em> post.</p>';
    expect(saveDescription(html, false)).toBe(html);
    expect(saveDescription(html, true)).toBe('The whole post.');
    expect(saveDescription('x < y', true)).toBe('x < y');
    expect(saveDescription('<p> </p>', true)).toBeNull();
  });
});

describe('saveDomain', () => {
  it("keeps the extractor's domain unless it's missing or a DOI resolver", () => {
    expect(saveDomain('https://academic.oup.com/p', 'dx.doi.org')).toBe('academic.oup.com');
    expect(saveDomain('https://www.todayintabs.com/p/x', null)).toBe('todayintabs.com');
    expect(saveDomain('https://feedproxy.google.com/~r/x', 'example.com')).toBe('example.com');
    expect(saveDomain('https://link.mail.beehiiv.com/ss/c/u001.x', null)).toBeNull();
    expect(saveDomain('', 'newsletter.example')).toBe('newsletter.example');
  });
});
