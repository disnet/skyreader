// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderOffprintContent } from './offprint-renderer';
import type { OffprintBlock, OffprintContent } from '$lib/types';

const AUTHOR_DID = 'did:plc:example';

function doc(...items: OffprintBlock[]): OffprintContent {
  return { $type: 'app.offprint.content', items };
}

// Offprint names the blob `image`, not `blob`. These fixtures copy the shape of
// real app.offprint.block.* records verbatim: a renderer that reads the wrong
// field drops the block silently rather than failing, so the field name is what
// these tests pin.
function blob(cid: string) {
  return { $type: 'blob', ref: { $link: cid }, mimeType: 'image/jpeg', size: 1234 };
}

describe('image blocks', () => {
  it('renders an image block from the `image` field', () => {
    const html = renderOffprintContent(
      doc({
        $type: 'app.offprint.block.image',
        image: blob('bafkreiimage'),
        caption: 'The plan',
        alignment: 'center',
        aspectRatio: { width: 626, height: 848 },
      } as OffprintBlock),
      AUTHOR_DID
    );

    expect(html).toContain(
      `https://cdn.bsky.app/img/feed_fullsize/plain/${AUTHOR_DID}/bafkreiimage@jpeg`
    );
    expect(html).toContain('The plan');
  });

  it('renders every image in a grid block', () => {
    const html = renderOffprintContent(
      doc({
        $type: 'app.offprint.block.imageGrid',
        images: [
          { alt: 'one', image: blob('bafkreione') },
          { alt: 'two', image: blob('bafkreitwo') },
        ],
        caption: 'Two shots',
      } as OffprintBlock),
      AUTHOR_DID
    );

    expect(html).toContain('bafkreione@jpeg');
    expect(html).toContain('bafkreitwo@jpeg');
    expect(html).toContain('alt="one"');
    expect(html).toContain('Two shots');
  });

  it('renders every image in a carousel block', () => {
    const html = renderOffprintContent(
      doc({
        $type: 'app.offprint.block.imageCarousel',
        images: [{ image: blob('bafkreione') }, { image: blob('bafkreitwo') }],
      } as OffprintBlock),
      AUTHOR_DID
    );

    expect(html).toContain('bafkreione@jpeg');
    expect(html).toContain('bafkreitwo@jpeg');
  });

  it('renders both sides of an image diff block', () => {
    const html = renderOffprintContent(
      doc({
        $type: 'app.offprint.block.imageDiff',
        images: [{ image: blob('bafkreibefore') }, { image: blob('bafkreiafter') }],
        labels: ['Before', 'After'],
      } as OffprintBlock),
      AUTHOR_DID
    );

    expect(html).toContain('bafkreibefore@jpeg');
    expect(html).toContain('bafkreiafter@jpeg');
    expect(html).toContain('Before');
  });

  it('renders a web bookmark preview, which is a bare blob', () => {
    const html = renderOffprintContent(
      doc({
        $type: 'app.offprint.block.webBookmark',
        href: 'https://example.com/post',
        title: 'A post',
        preview: blob('bafkreipreview'),
      } as OffprintBlock),
      AUTHOR_DID
    );

    expect(html).toContain('bafkreipreview@jpeg');
    expect(html).toContain('https://example.com/post');
  });

  it('skips an image block with no blob rather than emitting a broken img', () => {
    const html = renderOffprintContent(
      doc({ $type: 'app.offprint.block.image', caption: 'orphan' } as unknown as OffprintBlock),
      AUTHOR_DID
    );

    expect(html).not.toContain('<img');
  });
});
