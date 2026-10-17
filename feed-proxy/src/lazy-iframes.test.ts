import { describe, expect, it } from 'bun:test';
import { Defuddle } from 'defuddle/node';
import { restoreLazyIframes } from './app';

const EMBED = 'https://www.youtube.com/embed/rH68ym3dCfk?si=QvkFj4ao1T8aO42R';
const PLACEHOLDER = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMSIgaGVpZ2h0PSIxIi8+';

describe('restoreLazyIframes', () => {
  it('gives a src-less lazy iframe its data-src', () => {
    const out = restoreLazyIframes(
      `<p><iframe title="v" data-src="${EMBED}" width="560"></iframe></p>`
    );
    expect(out).toContain(`<iframe src="${EMBED}" title="v"`);
  });

  it('replaces a placeholder src', () => {
    const out = restoreLazyIframes(
      `<iframe src="${PLACEHOLDER}" data-lazy-src="${EMBED}"></iframe>`
    );
    expect(out).toBe(`<iframe src="${EMBED}" data-lazy-src="${EMBED}"></iframe>`);
  });

  it('leaves an iframe with a real src alone', () => {
    const tag = `<iframe src="https://player.vimeo.com/video/1" data-src="${EMBED}"></iframe>`;
    expect(restoreLazyIframes(tag)).toBe(tag);
  });

  it('ignores non-URL data-src values', () => {
    const tag = '<iframe data-src="javascript:alert(1)"></iframe>';
    expect(restoreLazyIframes(tag)).toBe(tag);
  });

  // The reported page (bellacaledonia.org.uk, lazysizes): Defuddle drops the
  // placeholder src and keeps data-src, so the video was stripped downstream.
  it('restores the video in a lazysizes WordPress post after Defuddle', async () => {
    const html = `<html><head><title>Post</title></head><body><article>
      <p>Lara Bird MP joins Nish &amp; Coco to explain why Andy Burnham is inherently problematic.</p>
      <p><iframe title="YouTube video player" data-src="${EMBED}" width="560" height="315"
        src="${PLACEHOLDER}" class="lazyload" data-load-mode="0" allowfullscreen></iframe></p>
      </article></body></html>`;
    const result = await Defuddle(html, 'https://bellacaledonia.org.uk/x/', {
      url: 'https://bellacaledonia.org.uk/x/',
    });
    expect(result.content).not.toMatch(/<iframe[^>]*\ssrc=/);
    expect(restoreLazyIframes(result.content)).toContain(`<iframe src="${EMBED}"`);
  });
});
