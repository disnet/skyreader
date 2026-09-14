/**
 * Renderer for app.offprint.content block-based documents
 * Converts Offprint blocks to HTML for display in ArticleCard
 *
 * Styling is carried on `op-*` classes and data-* attributes, never on inline
 * `style` — sanitizeHtml forbids the style attribute outright (a feed can
 * otherwise overlay the app shell), so anything written there is dropped before
 * it reaches the reader. The matching rules live in src/app.css beside the
 * Leaflet footnote rules, for the same reason: five reader surfaces render this
 * markup and none of them should have to carry a copy.
 */

import temml from 'temml';
import { allowedIframeSrc } from '$lib/utils/sanitize';
import type {
  OffprintContent,
  OffprintBlock,
  OffprintFacet,
  OffprintTextBlock,
  OffprintHeadingBlock,
  OffprintBlockquoteBlock,
  OffprintCalloutBlock,
  OffprintBulletListBlock,
  OffprintOrderedListBlock,
  OffprintTaskListBlock,
  OffprintCodeBlockBlock,
  OffprintImageBlock,
  OffprintImageGridBlock,
  OffprintImageCarouselBlock,
  OffprintImageDiffBlock,
  OffprintWebBookmarkBlock,
  OffprintWebEmbedBlock,
  OffprintBlueskyPostBlock,
  OffprintListItem,
  OffprintTaskItem,
  OffprintImageGridImage,
} from '$lib/types';

/**
 * Check if content is app.offprint.content format
 */
export function isOffprintContent(content: unknown): content is OffprintContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    '$type' in content &&
    (content as { $type: string }).$type === 'app.offprint.content'
  );
}

/**
 * Construct a CDN URL for an AT Protocol blob
 * Uses bsky.app CDN which serves blobs from any PDS
 */
function getBlobUrl(authorDid: string, blobCid: string): string {
  return `https://cdn.bsky.app/img/feed_fullsize/plain/${authorDid}/${blobCid}@jpeg`;
}

/**
 * Class for a block's horizontal alignment, or '' for the default (left).
 */
function alignClass(align?: string): string {
  if (align === 'center') return ' op-align-center';
  if (align === 'right') return ' op-align-right';
  return '';
}

/**
 * Offprint stores an image block's width as a percentage of its own content
 * column ('52%', '87%'). A percentage can only be expressed in CSS, and inline
 * style never survives sanitizing, so bucket it to the nearest 10% and let a
 * class carry it. The reader's measure is not Offprint's, so the author's exact
 * figure was already an approximation; what matters is that a portrait photo
 * they sized down stays sized down.
 */
function widthClass(width?: string): string {
  if (!width) return '';
  const pct = Number.parseFloat(width);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return '';
  const bucket = Math.max(30, Math.round(pct / 10) * 10);
  // Anything that rounds to full width is just the default.
  return bucket >= 100 ? '' : ` op-figure--w${bucket}`;
}

/**
 * Intrinsic dimensions as width/height attributes. The browser derives the
 * aspect ratio from them, which reserves the right box before the image loads
 * (no reflow mid-paragraph) and, unlike an inline `aspect-ratio` style, is not
 * stripped by the sanitizer.
 */
function sizeAttrs(aspectRatio?: { width: number; height: number }): string {
  if (!aspectRatio) return '';
  const { width, height } = aspectRatio;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '';
  }
  return ` width="${Math.round(width)}" height="${Math.round(height)}"`;
}

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Apply facets (rich text formatting) to plaintext
 * Facets use byte ranges, so we need to handle UTF-8 encoding properly
 */
function applyFacets(plaintext: string, facets?: OffprintFacet[]): string {
  if (!facets || facets.length === 0) {
    return escapeHtml(plaintext);
  }

  // Convert string to UTF-8 bytes for proper indexing
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(plaintext);

  // Sort facets by byteStart in reverse order to apply from end to start
  // This ensures byte indices remain valid as we insert HTML tags
  const sortedFacets = [...facets].sort((a, b) => b.index.byteStart - a.index.byteStart);

  let result = bytes;

  for (const facet of sortedFacets) {
    const { byteStart, byteEnd } = facet.index;

    // Extract the text slice
    const beforeBytes = result.slice(0, byteStart);
    const facetBytes = result.slice(byteStart, byteEnd);
    const afterBytes = result.slice(byteEnd);

    const facetText = escapeHtml(decoder.decode(facetBytes));

    // Build the wrapped text based on facet features
    let wrappedText = facetText;

    for (const feature of facet.features) {
      switch (feature.$type) {
        case 'app.offprint.richtext.facet#bold':
          wrappedText = `<strong>${wrappedText}</strong>`;
          break;
        case 'app.offprint.richtext.facet#italic':
          wrappedText = `<em>${wrappedText}</em>`;
          break;
        case 'app.offprint.richtext.facet#underline':
          wrappedText = `<u>${wrappedText}</u>`;
          break;
        case 'app.offprint.richtext.facet#strikethrough':
          wrappedText = `<del>${wrappedText}</del>`;
          break;
        case 'app.offprint.richtext.facet#code':
          wrappedText = `<code>${wrappedText}</code>`;
          break;
        case 'app.offprint.richtext.facet#highlight':
          // feature.color is ignored for the same reason as a callout's: it is
          // author CSS, and an inline style would be stripped on the way out
          // anyway. A bare <mark> picks up the reader's own highlight color.
          wrappedText = `<mark>${wrappedText}</mark>`;
          break;
        case 'app.offprint.richtext.facet#link':
          if (feature.uri) {
            wrappedText = `<a href="${escapeHtml(feature.uri)}" target="_blank" rel="noopener">${wrappedText}</a>`;
          }
          break;
        case 'app.offprint.richtext.facet#mention':
          if (feature.did) {
            wrappedText = `<a href="https://bsky.app/profile/${escapeHtml(feature.did)}" target="_blank" rel="noopener">${wrappedText}</a>`;
          }
          break;
        case 'app.offprint.richtext.facet#webMention':
          if (feature.uri) {
            const title = feature.title ? escapeHtml(feature.title) : escapeHtml(feature.uri);
            wrappedText = `<a href="${escapeHtml(feature.uri)}" target="_blank" rel="noopener" title="${title}">${wrappedText}</a>`;
          }
          break;
      }
    }

    // Reconstruct the byte array with the HTML-wrapped text
    const wrappedBytes = encoder.encode(wrappedText);
    const newResult = new Uint8Array(beforeBytes.length + wrappedBytes.length + afterBytes.length);
    newResult.set(beforeBytes, 0);
    newResult.set(wrappedBytes, beforeBytes.length);
    newResult.set(afterBytes, beforeBytes.length + wrappedBytes.length);
    result = newResult;
  }

  return decoder.decode(result);
}

/**
 * Render a text block
 */
function renderTextBlock(block: OffprintTextBlock): string {
  if (!block.plaintext) {
    return '';
  }
  const content = applyFacets(block.plaintext, block.facets);
  const align = alignClass(block.textAlign);
  return `<p${align ? ` class="${align.trim()}"` : ''}>${content}</p>`;
}

/**
 * Render a heading block
 */
function renderHeadingBlock(block: OffprintHeadingBlock): string {
  if (!block.plaintext) {
    return '';
  }
  const content = applyFacets(block.plaintext, block.facets);
  const level = block.level || 2;
  const tag = `h${Math.min(Math.max(level, 1), 3)}`;
  const align = alignClass(block.textAlign);
  return `<${tag}${align ? ` class="${align.trim()}"` : ''}>${content}</${tag}>`;
}

/**
 * Render a blockquote block with nested text/heading content
 */
function renderBlockquoteBlock(block: OffprintBlockquoteBlock): string {
  if (!block.content || block.content.length === 0) {
    return '';
  }

  const innerHtml = block.content
    .map((inner) => {
      if (inner.$type === 'app.offprint.block.text') {
        return renderTextBlock(inner as OffprintTextBlock);
      }
      if (inner.$type === 'app.offprint.block.heading') {
        return renderHeadingBlock(inner as OffprintHeadingBlock);
      }
      return '';
    })
    .join('\n');

  return `<blockquote>${innerHtml}</blockquote>`;
}

/**
 * Render a callout block
 */
function renderCalloutBlock(block: OffprintCalloutBlock): string {
  if (!block.plaintext) {
    return '';
  }
  const content = applyFacets(block.plaintext, block.facets);
  const emoji = block.emoji
    ? `<span class="op-callout__emoji">${escapeHtml(block.emoji)}</span>`
    : '';
  // block.color is deliberately ignored. It is author-supplied CSS, and the
  // reader's own quiet surface holds up better across both themes than an
  // arbitrary background does.
  return `<div class="op-callout">${emoji}<div class="op-callout__body">${content}</div></div>`;
}

/**
 * Render list items recursively (bullet/ordered lists)
 */
function renderListItems(children: OffprintListItem[], listTag: 'ul' | 'ol'): string {
  return children
    .map((item) => {
      const content = applyFacets(item.content?.plaintext || '', item.content?.facets);
      let html = `<li>${content}`;
      if (item.children && item.children.length > 0) {
        html += `<${listTag}>${renderListItems(item.children, listTag)}</${listTag}>`;
      }
      html += '</li>';
      return html;
    })
    .join('');
}

/**
 * Render a bullet list block
 */
function renderBulletListBlock(block: OffprintBulletListBlock): string {
  if (!block.children || block.children.length === 0) {
    return '';
  }
  return `<ul>${renderListItems(block.children, 'ul')}</ul>`;
}

/**
 * Render an ordered list block
 */
function renderOrderedListBlock(block: OffprintOrderedListBlock): string {
  if (!block.children || block.children.length === 0) {
    return '';
  }
  const start = block.start && block.start !== 1 ? ` start="${block.start}"` : '';
  return `<ol${start}>${renderListItems(block.children, 'ol')}</ol>`;
}

/**
 * Render task items recursively
 */
function renderTaskItems(children: OffprintTaskItem[]): string {
  return children
    .map((item) => {
      const content = applyFacets(item.content?.plaintext || '', item.content?.facets);
      const checked = item.checked ? ' checked disabled' : ' disabled';
      let html = `<li class="op-tasklist__item"><input type="checkbox"${checked} /> ${content}`;
      if (item.children && item.children.length > 0) {
        html += `<ul class="op-tasklist">${renderTaskItems(item.children)}</ul>`;
      }
      html += '</li>';
      return html;
    })
    .join('');
}

/**
 * Render a task list block
 */
function renderTaskListBlock(block: OffprintTaskListBlock): string {
  if (!block.children || block.children.length === 0) {
    return '';
  }
  return `<ul class="op-tasklist">${renderTaskItems(block.children)}</ul>`;
}

/**
 * Render a code block
 */
function renderCodeBlock(block: OffprintCodeBlockBlock): string {
  if (!block.code) {
    return '';
  }

  const langClass = block.language ? ` class="language-${escapeHtml(block.language)}"` : '';

  if (block.showLineNumbers) {
    const lines = block.code.split('\n');
    const numberedLines = lines
      .map((line, i) => `<span class="op-linenum">${i + 1}</span>${escapeHtml(line)}`)
      .join('\n');
    return `<pre><code${langClass}>${numberedLines}</code></pre>`;
  }

  return `<pre><code${langClass}>${escapeHtml(block.code)}</code></pre>`;
}

/**
 * Render a horizontal rule block
 */
function renderHorizontalRuleBlock(): string {
  return '<hr />';
}

/**
 * Render an image block
 */
function renderImageBlock(block: OffprintImageBlock, authorDid: string): string {
  const blobCid = block.image?.ref?.$link;
  if (!blobCid) {
    return '';
  }

  const url = getBlobUrl(authorDid, blobCid);
  const alt = block.alt ? escapeHtml(block.alt) : '';
  const cls = `op-figure${widthClass(block.width)}${alignClass(block.alignment)}`;

  let html = `<figure class="${cls}">`;
  html += `<img src="${url}" alt="${alt}"${sizeAttrs(block.aspectRatio)} loading="lazy" />`;

  if (block.caption) {
    const captionContent = applyFacets(block.caption, block.captionFacets);
    html += `<figcaption class="op-caption">${captionContent}</figcaption>`;
  }

  html += '</figure>';
  return html;
}

/**
 * Render a single grid/carousel image
 */
function renderGridImage(image: OffprintImageGridImage, authorDid: string): string {
  const blobCid = (image.blob ?? image.image)?.ref?.$link;
  if (!blobCid) {
    return '';
  }
  const url = getBlobUrl(authorDid, blobCid);
  const alt = image.alt ? escapeHtml(image.alt) : '';
  return `<img class="op-media" src="${url}" alt="${alt}"${sizeAttrs(image.aspectRatio)} loading="lazy" />`;
}

/**
 * Render an image grid block
 */
function renderImageGridBlock(block: OffprintImageGridBlock, authorDid: string): string {
  if (!block.images || block.images.length === 0) {
    return '';
  }

  const rows = block.gridRows && block.gridRows > 0 ? Math.min(2, block.gridRows) : undefined;
  const cols = Math.min(rows ? Math.ceil(block.images.length / rows) : block.images.length, 3);
  const ratio = typeof block.aspectRatio === 'string' ? block.aspectRatio : '';

  let html = `<div class="op-grid op-grid--cols-${cols}${ratio ? ` op-grid--${escapeHtml(ratio)}` : ''}">`;

  for (const image of block.images) {
    html += `<div class="op-grid__cell">${renderGridImage(image, authorDid)}</div>`;
  }

  html += '</div>';

  if (block.caption) {
    html += `<p class="op-caption">${escapeHtml(block.caption)}</p>`;
  }

  return html;
}

/**
 * Render an image carousel block as a horizontal scrollable strip
 */
function renderImageCarouselBlock(block: OffprintImageCarouselBlock, authorDid: string): string {
  if (!block.images || block.images.length === 0) {
    return '';
  }

  let html = '<div class="op-carousel">';

  for (const image of block.images) {
    const blobCid = (image.blob ?? image.image)?.ref?.$link;
    if (!blobCid) continue;
    const url = getBlobUrl(authorDid, blobCid);
    const alt = image.alt ? escapeHtml(image.alt) : '';
    html += `<div class="op-carousel__item"><img class="op-media" src="${url}" alt="${alt}"${sizeAttrs(image.aspectRatio)} loading="lazy" /></div>`;
  }

  html += '</div>';

  if (block.caption) {
    html += `<p class="op-caption">${escapeHtml(block.caption)}</p>`;
  }

  return html;
}

/**
 * Render an image diff block as two images side-by-side with labels
 */
function renderImageDiffBlock(block: OffprintImageDiffBlock, authorDid: string): string {
  if (!block.images || block.images.length < 2) {
    return '';
  }

  let html = `<div class="op-diff${widthClass(block.width)}${alignClass(block.alignment)}">`;

  for (let i = 0; i < 2; i++) {
    const image = block.images[i];
    const blobCid = (image.blob ?? image.image)?.ref?.$link;
    if (!blobCid) continue;
    const url = getBlobUrl(authorDid, blobCid);
    const alt = image.alt ? escapeHtml(image.alt) : '';
    const label = block.labels?.[i]
      ? `<div class="op-diff__label">${escapeHtml(block.labels[i])}</div>`
      : '';
    html += `<div class="op-diff__side"><img class="op-media" src="${url}" alt="${alt}"${sizeAttrs(image.aspectRatio)} loading="lazy" />${label}</div>`;
  }

  html += '</div>';

  if (block.caption) {
    html += `<p class="op-caption op-align-center">${escapeHtml(block.caption)}</p>`;
  }

  return html;
}

/**
 * Render a web bookmark (link card) — the block a shared article becomes on an
 * Offprint publication, and the shape Offprint's own posts use for outbound links.
 */
function renderWebBookmarkBlock(block: OffprintWebBookmarkBlock, authorDid: string): string {
  return renderLinkCard(
    {
      href: block.href,
      title: block.title,
      siteName: block.siteName,
      description: block.description,
      previewCid: block.preview?.ref?.$link,
    },
    authorDid
  );
}

/**
 * The shared link-card markup. `website-preview` is the class the Leaflet and
 * pckt.blog renderers already emit for the same shape, so one set of rules in
 * app.css dresses all three.
 */
function renderLinkCard(
  card: {
    href?: string;
    title?: string;
    siteName?: string;
    description?: string;
    previewCid?: string;
  },
  authorDid: string
): string {
  const url = card.href;
  if (!url) {
    return '';
  }

  const title = card.title || url;

  let html = '<div class="website-preview">';

  if (card.previewCid) {
    html += `<div class="website-preview__media"><img class="op-media" src="${getBlobUrl(authorDid, card.previewCid)}" alt="" loading="lazy" /></div>`;
  }

  html += '<div>';
  html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`;

  if (card.siteName) {
    html += `<p class="website-preview__site">${escapeHtml(card.siteName)}</p>`;
  }
  if (card.description) {
    html += `<p>${escapeHtml(card.description)}</p>`;
  }

  html += '</div></div>';

  return html;
}

/**
 * Render an embedded video.
 *
 * Only the providers sanitizeHtml will keep get an iframe; every other host
 * would have its iframe stripped on the way out, leaving an empty box where a
 * video should be, so those fall back to the link card. `allowedIframeSrc` is
 * imported rather than reimplemented so there is one allowlist, not two.
 */
function renderWebEmbedBlock(block: OffprintWebEmbedBlock, authorDid: string): string {
  const embedSrc = allowedIframeSrc(block.embedUrl ?? null, null);

  if (embedSrc) {
    const title = block.title ? ` title="${escapeHtml(block.title)}"` : '';
    return `<div class="op-embed${alignClass(block.alignment)}"><iframe src="${escapeHtml(embedSrc)}"${title} loading="lazy"></iframe></div>`;
  }

  return renderLinkCard(
    {
      href: block.href,
      title: block.title,
      siteName: block.siteName,
      description: block.description,
      previewCid: block.preview?.ref?.$link,
    },
    authorDid
  );
}

/**
 * Render a Bluesky post embed as the placeholder the bskyEmbed action hydrates
 * (see lib/actions/bsky-embed.ts) — the same one the Leaflet renderer emits.
 */
function renderBlueskyPostBlock(block: OffprintBlueskyPostBlock): string {
  const postUri = block.post?.uri;
  if (!postUri) {
    return '';
  }
  return `<div class="bsky-post-embed" data-uri="${escapeHtml(postUri)}"></div>`;
}

function renderMath(tex: string): string {
  if (!tex) return '';
  try {
    return `<div class="op-math">${temml.renderToString(tex, { displayMode: true, throwOnError: true })}</div>`;
  } catch {
    return `<pre class="op-math-fallback"><code>${escapeHtml(tex)}</code></pre>`;
  }
}

/**
 * Render a single block based on its type
 */
function renderBlock(block: OffprintBlock, authorDid: string): string {
  switch (block.$type) {
    case 'app.offprint.block.text':
      return renderTextBlock(block as OffprintTextBlock);
    case 'app.offprint.block.heading':
      return renderHeadingBlock(block as OffprintHeadingBlock);
    case 'app.offprint.block.blockquote':
      return renderBlockquoteBlock(block as OffprintBlockquoteBlock);
    case 'app.offprint.block.callout':
      return renderCalloutBlock(block as OffprintCalloutBlock);
    case 'app.offprint.block.bulletList':
      return renderBulletListBlock(block as OffprintBulletListBlock);
    case 'app.offprint.block.orderedList':
      return renderOrderedListBlock(block as OffprintOrderedListBlock);
    case 'app.offprint.block.taskList':
      return renderTaskListBlock(block as OffprintTaskListBlock);
    case 'app.offprint.block.codeBlock':
      return renderCodeBlock(block as OffprintCodeBlockBlock);
    case 'app.offprint.block.horizontalRule':
      return renderHorizontalRuleBlock();
    case 'app.offprint.block.image':
      return renderImageBlock(block as OffprintImageBlock, authorDid);
    case 'app.offprint.block.imageGrid':
      return renderImageGridBlock(block as OffprintImageGridBlock, authorDid);
    case 'app.offprint.block.imageCarousel':
      return renderImageCarouselBlock(block as OffprintImageCarouselBlock, authorDid);
    case 'app.offprint.block.imageDiff':
      return renderImageDiffBlock(block as OffprintImageDiffBlock, authorDid);
    case 'app.offprint.block.webBookmark':
      return renderWebBookmarkBlock(block as OffprintWebBookmarkBlock, authorDid);
    case 'app.offprint.block.webEmbed':
      return renderWebEmbedBlock(block as OffprintWebEmbedBlock, authorDid);
    case 'app.offprint.block.blueskyPost':
      return renderBlueskyPostBlock(block as OffprintBlueskyPostBlock);
    case 'app.offprint.block.button': {
      const button = block as unknown as {
        text?: string;
        href?: string;
        caption?: string;
        alignment?: string;
      };
      if (!button.href) return '';
      const caption = button.caption
        ? `<p class="op-caption">${escapeHtml(button.caption)}</p>`
        : '';
      return `${caption}<p${alignClass(button.alignment) ? ` class="${alignClass(button.alignment).trim()}"` : ''}><a class="op-button" href="${escapeHtml(button.href)}">${escapeHtml(button.text || button.href)}</a></p>`;
    }
    case 'app.offprint.block.mathBlock':
      return renderMath(String((block as unknown as { tex?: string }).tex || ''));
    default: {
      // Unsupported block type - try to extract plaintext if available
      const unknownBlock = block as unknown as { plaintext?: string };
      if (unknownBlock.plaintext && typeof unknownBlock.plaintext === 'string') {
        return `<p>${escapeHtml(unknownBlock.plaintext)}</p>`;
      }
      return '';
    }
  }
}

/**
 * Main entry point: render Offprint content to HTML
 */
export function renderOffprintContent(content: OffprintContent, authorDid: string): string {
  if (!content.items || content.items.length === 0) {
    return '';
  }

  const htmlParts: string[] = [];
  let degraded = false;

  for (const block of content.items) {
    const blockHtml = renderBlock(block, authorDid);
    if (blockHtml) htmlParts.push(blockHtml);
    else degraded = true;
  }

  if (degraded)
    htmlParts.push('<p class="op-degraded">Some content can’t be shown · View original</p>');

  return htmlParts.join('\n');
}
