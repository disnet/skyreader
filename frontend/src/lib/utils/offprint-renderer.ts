/**
 * Renderer for app.offprint.content block-based documents
 * Converts Offprint blocks to HTML for display in ArticleCard
 */

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
          if (feature.color) {
            wrappedText = `<mark style="background-color: ${escapeHtml(feature.color)}">${wrappedText}</mark>`;
          } else {
            wrappedText = `<mark>${wrappedText}</mark>`;
          }
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
  const style =
    block.textAlign && block.textAlign !== 'left' ? ` style="text-align: ${block.textAlign}"` : '';
  return `<p${style}>${content}</p>`;
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
  const style =
    block.textAlign && block.textAlign !== 'left' ? ` style="text-align: ${block.textAlign}"` : '';
  return `<${tag}${style}>${content}</${tag}>`;
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
    ? `<span style="margin-right: 0.5em">${escapeHtml(block.emoji)}</span>`
    : '';
  const bgColor = block.color
    ? `background-color: ${escapeHtml(block.color)}; `
    : 'background-color: var(--bg-secondary, #f5f5f5); ';
  return `<div style="${bgColor}border-radius: 8px; padding: 12px 16px; margin: 1em 0">${emoji}${content}</div>`;
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
      let html = `<li style="list-style: none"><input type="checkbox"${checked} /> ${content}`;
      if (item.children && item.children.length > 0) {
        html += `<ul>${renderTaskItems(item.children)}</ul>`;
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
  return `<ul style="padding-left: 0">${renderTaskItems(block.children)}</ul>`;
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
      .map(
        (line, i) =>
          `<span style="user-select: none; opacity: 0.5; padding-right: 1em">${i + 1}</span>${escapeHtml(line)}`
      )
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
  const blobCid = block.blob?.ref?.$link;
  if (!blobCid) {
    return '';
  }

  const url = getBlobUrl(authorDid, blobCid);
  const alt = block.alt ? escapeHtml(block.alt) : '';

  let imgStyle = 'max-width: 100%; height: auto';
  if (block.width) {
    imgStyle = `width: ${block.width}px; max-width: 100%; height: auto`;
  }
  if (block.aspectRatio) {
    imgStyle += `; aspect-ratio: ${block.aspectRatio.width} / ${block.aspectRatio.height}; object-fit: cover`;
  }

  let figureStyle = 'margin: 1em 0';
  if (block.alignment === 'center') {
    figureStyle += '; text-align: center';
  } else if (block.alignment === 'right') {
    figureStyle += '; text-align: right';
  }

  let html = `<figure style="${figureStyle}">`;
  html += `<img src="${url}" alt="${alt}" style="${imgStyle}" loading="lazy" />`;

  if (block.caption) {
    const captionContent = applyFacets(block.caption, block.captionFacets);
    html += `<figcaption style="font-size: 0.875em; color: var(--text-secondary, #666); margin-top: 0.5em">${captionContent}</figcaption>`;
  }

  html += '</figure>';
  return html;
}

/**
 * Render a single grid/carousel image
 */
function renderGridImage(image: OffprintImageGridImage, authorDid: string): string {
  const blobCid = image.blob?.ref?.$link;
  if (!blobCid) {
    return '';
  }
  const url = getBlobUrl(authorDid, blobCid);
  const alt = image.alt ? escapeHtml(image.alt) : '';
  return `<img src="${url}" alt="${alt}" style="width: 100%; height: 100%; object-fit: cover" loading="lazy" />`;
}

/**
 * Render an image grid block
 */
function renderImageGridBlock(block: OffprintImageGridBlock, authorDid: string): string {
  if (!block.images || block.images.length === 0) {
    return '';
  }

  const cols = Math.min(block.images.length, 3);
  const rows = block.gridRows || Math.ceil(block.images.length / cols);
  let aspectStyle = '';
  if (block.aspectRatio) {
    aspectStyle = `aspect-ratio: ${block.aspectRatio.width} / ${block.aspectRatio.height};`;
  }

  let html = `<div style="display: grid; grid-template-columns: repeat(${cols}, 1fr); grid-template-rows: repeat(${rows}, 1fr); gap: 4px; margin: 1em 0; ${aspectStyle}">`;

  for (const image of block.images) {
    html += `<div style="overflow: hidden; border-radius: 4px">${renderGridImage(image, authorDid)}</div>`;
  }

  html += '</div>';

  if (block.caption) {
    html += `<p style="font-size: 0.875em; color: var(--text-secondary, #666); margin-top: 0.25em">${escapeHtml(block.caption)}</p>`;
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

  let html =
    '<div style="display: flex; gap: 4px; overflow-x: auto; margin: 1em 0; scroll-snap-type: x mandatory">';

  for (const image of block.images) {
    const blobCid = image.blob?.ref?.$link;
    if (!blobCid) continue;
    const url = getBlobUrl(authorDid, blobCid);
    const alt = image.alt ? escapeHtml(image.alt) : '';
    html += `<div style="flex: 0 0 auto; scroll-snap-align: start; border-radius: 4px; overflow: hidden"><img src="${url}" alt="${alt}" style="height: 300px; width: auto; object-fit: cover" loading="lazy" /></div>`;
  }

  html += '</div>';

  if (block.caption) {
    html += `<p style="font-size: 0.875em; color: var(--text-secondary, #666); margin-top: 0.25em">${escapeHtml(block.caption)}</p>`;
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

  let containerStyle = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 1em 0';
  if (block.width) {
    containerStyle += `; max-width: ${block.width}px`;
  }
  if (block.alignment === 'center') {
    containerStyle += '; margin-left: auto; margin-right: auto';
  } else if (block.alignment === 'right') {
    containerStyle += '; margin-left: auto';
  }

  let html = `<div style="${containerStyle}">`;

  for (let i = 0; i < 2; i++) {
    const image = block.images[i];
    const blobCid = image.blob?.ref?.$link;
    if (!blobCid) continue;
    const url = getBlobUrl(authorDid, blobCid);
    const alt = image.alt ? escapeHtml(image.alt) : '';
    const label = block.labels?.[i]
      ? `<div style="font-size: 0.75em; color: var(--text-secondary, #666); text-align: center; margin-top: 0.25em">${escapeHtml(block.labels[i])}</div>`
      : '';
    html += `<div><img src="${url}" alt="${alt}" style="width: 100%; height: auto; border-radius: 4px" loading="lazy" />${label}</div>`;
  }

  html += '</div>';

  if (block.caption) {
    html += `<p style="font-size: 0.875em; color: var(--text-secondary, #666); margin-top: 0.25em; text-align: center">${escapeHtml(block.caption)}</p>`;
  }

  return html;
}

/**
 * Render a web bookmark (link card) — the block a shared article becomes on an
 * Offprint publication, and the shape Offprint's own posts use for outbound links.
 */
function renderWebBookmarkBlock(block: OffprintWebBookmarkBlock, authorDid: string): string {
  const url = block.href;
  if (!url) {
    return '';
  }

  const title = block.title || url;
  const previewCid = block.preview?.ref?.$link;

  let html =
    '<div class="website-preview" style="border: 1px solid var(--border, #e5e5e5); border-radius: 8px; overflow: hidden; margin: 1em 0">';

  if (previewCid) {
    const previewUrl = getBlobUrl(authorDid, previewCid);
    html += `<img src="${previewUrl}" alt="" style="width: 100%; max-height: 200px; object-fit: cover" loading="lazy" />`;
  }

  html += '<div style="padding: 12px">';
  html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="font-weight: 600; text-decoration: none">${escapeHtml(title)}</a>`;

  if (block.siteName) {
    html += `<p style="margin: 2px 0 0; font-size: 0.75em; color: var(--text-secondary, #666)">${escapeHtml(block.siteName)}</p>`;
  }
  if (block.description) {
    html += `<p style="margin: 4px 0 0; font-size: 0.875em; color: var(--text-secondary, #666)">${escapeHtml(block.description)}</p>`;
  }

  html += '</div></div>';

  return html;
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

  for (const block of content.items) {
    const blockHtml = renderBlock(block, authorDid);
    if (blockHtml) {
      htmlParts.push(blockHtml);
    }
  }

  return htmlParts.join('\n');
}
