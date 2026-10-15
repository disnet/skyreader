// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { loadImagesThrough } from './pagedImages';

function images(pages: number[]) {
  return pages.map((page) => {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.dataset.page = String(page);
    return img;
  });
}
const pageOf = (img: HTMLImageElement) => Number(img.dataset.page);

describe('loadImagesThrough', () => {
  it('loads pictures up to the last page and holds back the rest', () => {
    const imgs = images([0, 1, 3, 5]);
    expect(loadImagesThrough(imgs, 0, 3, pageOf)).toBe(3);
    expect(imgs.map((img) => img.loading)).toEqual(['eager', 'eager', 'eager', 'lazy']);
  });

  it('picks up where the last call stopped', () => {
    const imgs = images([0, 4, 6]);
    const next = loadImagesThrough(imgs, 0, 2, pageOf);
    expect(next).toBe(1);
    imgs[0].loading = 'lazy'; // not revisited
    expect(loadImagesThrough(imgs, next, 6, pageOf)).toBe(3);
    expect(imgs.map((img) => img.loading)).toEqual(['lazy', 'eager', 'eager']);
  });

  it('leaves a picture that was never lazy as it is', () => {
    const [img] = images([0]);
    img.removeAttribute('loading');
    loadImagesThrough([img], 0, 0, pageOf);
    expect(img.hasAttribute('loading')).toBe(false);
  });
});
