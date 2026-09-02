import { describe, expect, it } from 'vitest';
import { imageSource } from './useLinkInterception.svelte';

describe('imageSource', () => {
  it('prefers the image candidate selected by the browser', () => {
    expect(
      imageSource({
        currentSrc: 'https://images.example/chosen.jpg',
        src: 'https://images.example/fallback.jpg',
        srcset: 'https://images.example/small.jpg 500w',
      })
    ).toBe('https://images.example/chosen.jpg');
  });

  it('keeps commas inside descriptor-bearing image URLs', () => {
    expect(
      imageSource({
        currentSrc: '',
        src: 'https://images.example/fallback.jpg',
        srcset:
          'https://img.example/format=auto,width=500/a.jpg 500w, https://img.example/format=auto,width=1000/a.jpg 1000w',
      })
    ).toBe('https://img.example/format=auto,width=1000/a.jpg');
  });
});
