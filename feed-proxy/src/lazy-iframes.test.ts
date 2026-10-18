import { describe, expect, it } from 'bun:test';
import { extractArticle, promoteLazyIframes } from './app';

const EMBED = 'https://www.youtube.com/embed/rH68ym3dCfk?si=QvkFj4ao1T8aO42R';
const PLACEHOLDER = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMSIgaGVpZ2h0PSIxIi8+';
const INTRO =
  '<p>Lara Bird MP joins Nish &amp; Coco to explain why Andy Burnham is inherently problematic.</p>';

function page(iframe: string): string {
  return `<html><head><title>Post</title></head><body><article>${INTRO}<p>${iframe}</p></article></body></html>`;
}

async function extractedIframe(iframe: string): Promise<string | undefined> {
  const { content } = await extractArticle(page(iframe), 'https://example.org/post/');
  return content?.match(/<iframe\b[^>]*>/)?.[0];
}

describe('promoteLazyIframes', () => {
  it('gives a src-less lazy iframe its data-src', () => {
    const out = promoteLazyIframes(`<iframe title="v" data-src="${EMBED}" width="560"></iframe>`);
    expect(out).toContain(`<iframe src="${EMBED}" title="v"`);
  });

  it('replaces a placeholder src', () => {
    const out = promoteLazyIframes(
      `<iframe src="${PLACEHOLDER}" data-lazy-src="${EMBED}"></iframe>`
    );
    expect(out).toBe(`<iframe src="${EMBED}" data-lazy-src="${EMBED}"></iframe>`);
  });

  it('leaves an iframe with a real src alone', () => {
    const tag = `<iframe src="https://player.vimeo.com/video/1" data-src="${EMBED}"></iframe>`;
    expect(promoteLazyIframes(tag)).toBe(tag);
  });

  it('ignores non-URL data-src values', () => {
    const tag = '<iframe data-src="javascript:alert(1)"></iframe>';
    expect(promoteLazyIframes(tag)).toBe(tag);
  });

  it('reads past a > or src= inside another attribute value', () => {
    const out = promoteLazyIframes(
      `<iframe title="a > b src='x'" src="about:blank" data-src="${EMBED}"></iframe>`
    );
    expect(out).toBe(`<iframe src="${EMBED}" title="a > b src='x'" data-src="${EMBED}"></iframe>`);
  });

  it('makes a protocol-relative URL https', () => {
    const out = promoteLazyIframes('<iframe data-src="//player.vimeo.com/video/1"></iframe>');
    expect(out).toContain('<iframe src="https://player.vimeo.com/video/1"');
  });
});

// Defuddle drops an iframe with no real src and strips every lazy attribute but
// data-src, so the URL has to be in place before it runs.
describe('extractArticle keeps lazy-loaded embeds', () => {
  for (const attr of ['data-src', 'data-lazy-src', 'data-litespeed-src', 'data-original']) {
    for (const [label, src] of [
      ['no src', ''],
      ['about:blank', ' src="about:blank"'],
      ['a data: placeholder', ` src="${PLACEHOLDER}"`],
    ]) {
      it(`${attr} with ${label}`, async () => {
        const iframe = await extractedIframe(
          `<iframe title="YouTube video player" ${attr}="${EMBED}"${src} width="560" height="315" class="lazyload" allowfullscreen></iframe>`
        );
        expect(iframe).toContain(`src="${EMBED}"`);
      });
    }
  }

  // The reported page (bellacaledonia.org.uk, lazysizes).
  it('restores the video in a lazysizes WordPress post', async () => {
    const iframe = await extractedIframe(
      `<iframe title="YouTube video player" data-src="${EMBED}" width="560" height="315"
        src="${PLACEHOLDER}" class="lazyload" data-load-mode="0" allowfullscreen></iframe>`
    );
    expect(iframe).toContain(`src="${EMBED}"`);
  });
});
