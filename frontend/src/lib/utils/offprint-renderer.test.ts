// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderOffprintContent } from './offprint-renderer';
import { sanitizeHtml } from './sanitize';
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

describe('image sizing', () => {
  it('carries the aspect ratio as width/height attributes, which survive sanitizing', () => {
    const html = renderOffprintContent(
      doc({
        $type: 'app.offprint.block.image',
        image: blob('bafkreiimage'),
        aspectRatio: { width: 626, height: 848 },
      } as OffprintBlock),
      AUTHOR_DID
    );

    expect(html).toContain('width="626" height="848"');
    expect(sanitizeHtml(html)).toContain('width="626" height="848"');
  });

  it('buckets a percentage width to the nearest 10% as a class', () => {
    const at = (width: string) =>
      renderOffprintContent(
        doc({
          $type: 'app.offprint.block.image',
          image: blob('bafkreiimage'),
          width,
        } as OffprintBlock),
        AUTHOR_DID
      );

    expect(at('52%')).toContain('op-figure--w50');
    expect(at('87%')).toContain('op-figure--w90');
    expect(at('37%')).toContain('op-figure--w40');
    // Full width is the default, so it gets no width class at all.
    expect(at('100%')).not.toContain('op-figure--w');
    expect(at('97%')).not.toContain('op-figure--w');
  });

  // A sized block is centered by its auto margins, so alignment has to reach the
  // box; `text-align` alone has nothing to move once the image fills the figure.
  it('carries alignment on the block a width class would otherwise center', () => {
    const aligned = (type: string, extra: Record<string, unknown>) =>
      renderOffprintContent(
        doc({ $type: type, alignment: 'right', width: '50%', ...extra } as OffprintBlock),
        AUTHOR_DID
      );

    expect(aligned('app.offprint.block.image', { image: blob('bafkreiimage') })).toContain(
      'op-figure--w50 op-align-right'
    );
    expect(
      aligned('app.offprint.block.imageDiff', {
        images: [{ image: blob('bafkreibefore') }, { image: blob('bafkreiafter') }],
      })
    ).toContain('op-diff op-figure--w50 op-align-right');
  });
});

describe('embeds', () => {
  const embed = (href: string, embedUrl?: string): OffprintBlock =>
    ({
      $type: 'app.offprint.block.webEmbed',
      href,
      embedUrl,
      title: 'A video',
      siteName: 'YouTube',
      description: 'Some description',
      preview: blob('bafkreipreview'),
    }) as OffprintBlock;

  it('frames a provider the sanitizer keeps', () => {
    const html = renderOffprintContent(
      doc(
        embed(
          'https://www.youtube.com/watch?v=6P7vZt-hrPg',
          'https://www.youtube.com/embed/6P7vZt-hrPg?feature=oembed'
        )
      ),
      AUTHOR_DID
    );

    expect(html).toContain('<iframe');
    expect(html).toContain('youtube.com/embed/6P7vZt-hrPg');
    // Survives the round trip rather than being stripped to an empty box.
    expect(sanitizeHtml(html)).toContain('<iframe');
  });

  it('falls back to a link card for a provider the sanitizer would strip', () => {
    const html = renderOffprintContent(
      doc(embed('https://example.com/video', 'https://example.com/embed/video')),
      AUTHOR_DID
    );

    expect(html).not.toContain('<iframe');
    expect(html).toContain('website-preview');
    expect(html).toContain('https://example.com/video');
    expect(html).toContain('A video');
  });

  it('falls back to a link card when there is no embed url at all', () => {
    const html = renderOffprintContent(doc(embed('https://example.com/video')), AUTHOR_DID);

    expect(html).not.toContain('<iframe');
    expect(html).toContain('website-preview');
  });

  it('renders a bluesky post as the placeholder the bskyEmbed action hydrates', () => {
    const uri = 'at://did:plc:3u2tgxbyvqbhltelbf6qu54w/app.bsky.feed.post/3ms2fkld6222x';
    const html = renderOffprintContent(
      doc({ $type: 'app.offprint.block.blueskyPost', post: { uri } } as OffprintBlock),
      AUTHOR_DID
    );

    expect(html).toContain('class="bsky-post-embed"');
    expect(html).toContain(`data-uri="${uri}"`);
    // The action reads both off the sanitized DOM.
    const clean = sanitizeHtml(html);
    expect(clean).toContain('bsky-post-embed');
    expect(clean).toContain(uri);
  });
});

describe('styling survives sanitizing', () => {
  // sanitizeHtml strips every style attribute, so a renderer that reaches for
  // inline style silently loses the layout it was trying to express. Classes
  // are the only channel that gets through; this fails if one creeps back in.
  it('emits no inline style on any block type', () => {
    const html = renderOffprintContent(
      doc(
        { $type: 'app.offprint.block.text', plaintext: 'hi', textAlign: 'center' } as OffprintBlock,
        { $type: 'app.offprint.block.heading', level: 2, plaintext: 'H' } as OffprintBlock,
        {
          $type: 'app.offprint.block.callout',
          emoji: 'ℹ️',
          plaintext: 'note',
          color: 'rgb(156 163 175 / 0.2)',
        } as OffprintBlock,
        {
          $type: 'app.offprint.block.image',
          image: blob('bafkreione'),
          width: '52%',
          alignment: 'center',
          caption: 'cap',
          aspectRatio: { width: 4, height: 3 },
        } as OffprintBlock,
        {
          $type: 'app.offprint.block.imageGrid',
          images: [{ image: blob('bafkreione') }, { image: blob('bafkreitwo') }],
          caption: 'grid',
        } as OffprintBlock,
        {
          $type: 'app.offprint.block.imageCarousel',
          images: [{ image: blob('bafkreione') }],
        } as OffprintBlock,
        {
          $type: 'app.offprint.block.imageDiff',
          images: [{ image: blob('bafkreione') }, { image: blob('bafkreitwo') }],
          labels: ['a', 'b'],
          width: '80%',
        } as OffprintBlock,
        {
          $type: 'app.offprint.block.taskList',
          children: [{ content: { plaintext: 'todo' }, checked: false }],
        } as OffprintBlock,
        {
          $type: 'app.offprint.block.codeBlock',
          code: 'a\nb',
          showLineNumbers: true,
        } as OffprintBlock,
        {
          $type: 'app.offprint.block.webBookmark',
          href: 'https://example.com',
          title: 'T',
        } as OffprintBlock
      ),
      AUTHOR_DID
    );

    expect(html).not.toContain('style=');
  });

  it('ignores the author-supplied callout background', () => {
    const html = renderOffprintContent(
      doc({
        $type: 'app.offprint.block.callout',
        plaintext: 'note',
        color: 'rgb(156 163 175 / 0.2)',
      } as OffprintBlock),
      AUTHOR_DID
    );

    expect(html).toContain('op-callout');
    expect(html).not.toContain('156 163 175');
  });
});
