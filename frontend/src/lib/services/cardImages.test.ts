import { describe, expect, it } from 'vitest';
import { cacheableImageUrls, MAX_CARD_IMAGES } from './cardImages';

describe('cacheableImageUrls', () => {
  const own = ['https://skyreader.app', 'https://api.skyreader.app'];

  it('keeps https pictures from other sites, normalized and deduped', () => {
    expect(
      cacheableImageUrls(
        [
          'https://img.example.com/a b.jpg',
          'https://img.example.com/a%20b.jpg#frag',
          'https://cdn.example.org/c.png',
        ],
        own
      )
    ).toEqual(['https://img.example.com/a%20b.jpg', 'https://cdn.example.org/c.png']);
  });

  it('leaves out our own origins, plain http and anything unparseable', () => {
    expect(
      cacheableImageUrls(
        [
          'https://api.skyreader.app/api/saved/rk/asset?path=cover.jpg',
          'https://skyreader.app/icons/icon.png',
          'http://insecure.example.com/a.jpg',
          'data:image/png;base64,AAAA',
          'not a url',
        ],
        own
      )
    ).toEqual([]);
  });

  it('caps the set', () => {
    const urls = Array.from({ length: MAX_CARD_IMAGES + 20 }, (_, i) => `https://e.com/${i}.jpg`);
    expect(cacheableImageUrls(urls, own)).toHaveLength(MAX_CARD_IMAGES);
  });
});
