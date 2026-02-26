/**
 * Renderer for pub.leaflet.content block-based documents
 * Converts Leaflet blocks to HTML for display in ArticleCard
 */

import type {
  LeafletContent,
  LeafletBlock,
  LeafletFacet,
  LeafletTextBlock,
  LeafletHeaderBlock,
  LeafletCodeBlock,
  LeafletBlockquoteBlock,
  LeafletUnorderedListBlock,
  LeafletOrderedListBlock,
  LeafletImageBlock,
  LeafletListItemBlock,
  LeafletWebsiteBlock,
  LeafletBskyPostBlock,
  LeafletPageBlock,
} from '$lib/types';

/**
 * Check if content is pub.leaflet.content format
 */
export function isLeafletContent(content: unknown): content is LeafletContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    '$type' in content &&
    (content as { $type: string }).$type === 'pub.leaflet.content'
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
function applyFacets(plaintext: string, facets?: LeafletFacet[]): string {
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
        case 'pub.leaflet.richtext.facet#bold':
        case 'app.bsky.richtext.facet#bold':
          wrappedText = `<strong>${wrappedText}</strong>`;
          break;
        case 'pub.leaflet.richtext.facet#italic':
        case 'app.bsky.richtext.facet#italic':
          wrappedText = `<em>${wrappedText}</em>`;
          break;
        case 'pub.leaflet.richtext.facet#strikethrough':
        case 'app.bsky.richtext.facet#strikethrough':
          wrappedText = `<del>${wrappedText}</del>`;
          break;
        case 'pub.leaflet.richtext.facet#underline':
          wrappedText = `<u>${wrappedText}</u>`;
          break;
        case 'pub.leaflet.richtext.facet#code':
          wrappedText = `<code>${wrappedText}</code>`;
          break;
        case 'pub.leaflet.richtext.facet#highlight':
          wrappedText = `<mark>${wrappedText}</mark>`;
          break;
        case 'pub.leaflet.richtext.facet#link':
        case 'app.bsky.richtext.facet#link':
          if (feature.uri) {
            wrappedText = `<a href="${escapeHtml(feature.uri)}" target="_blank" rel="noopener">${wrappedText}</a>`;
          }
          break;
        case 'pub.leaflet.richtext.facet#mention':
        case 'app.bsky.richtext.facet#mention':
          if (feature.did) {
            // Link to Bluesky profile
            wrappedText = `<a href="https://bsky.app/profile/${escapeHtml(feature.did)}" target="_blank" rel="noopener">${wrappedText}</a>`;
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
function renderTextBlock(block: LeafletTextBlock): string {
  if (!block.plaintext) {
    return '';
  }
  const content = applyFacets(block.plaintext, block.facets);

  // Apply text size styling
  let sizeClass = '';
  if (block.textSize === 'small') {
    sizeClass = ' style="font-size: 0.875em"';
  } else if (block.textSize === 'large') {
    sizeClass = ' style="font-size: 1.25em"';
  }

  return `<p${sizeClass}>${content}</p>`;
}

/**
 * Render a header block
 */
function renderHeaderBlock(block: LeafletHeaderBlock): string {
  if (!block.plaintext) {
    return '';
  }
  const content = applyFacets(block.plaintext, block.facets);
  const level = block.level || 2; // Default to h2
  const tag = `h${Math.min(Math.max(level, 1), 6)}`;
  return `<${tag}>${content}</${tag}>`;
}

/**
 * Render a code block
 */
function renderCodeBlock(block: LeafletCodeBlock): string {
  if (!block.plaintext) {
    return '';
  }
  const escaped = escapeHtml(block.plaintext);
  const langClass = block.language ? ` class="language-${escapeHtml(block.language)}"` : '';
  return `<pre><code${langClass}>${escaped}</code></pre>`;
}

/**
 * Render a blockquote block
 */
function renderBlockquoteBlock(block: LeafletBlockquoteBlock): string {
  if (!block.plaintext) {
    return '';
  }
  const content = applyFacets(block.plaintext, block.facets);
  return `<blockquote>${content}</blockquote>`;
}

/**
 * Render a horizontal rule block
 */
function renderHorizontalRuleBlock(): string {
  return '<hr />';
}

/**
 * Render list items recursively
 * @param children - List item children to render
 * @param listTag - Tag for nested lists ('ul' or 'ol')
 */
function renderListItems(
  children: LeafletListItemBlock[] | undefined,
  listTag: 'ul' | 'ol' = 'ul'
): string {
  if (!children || children.length === 0) {
    return '';
  }

  return children
    .map((item) => {
      // Extract plaintext and facets from the content block
      const plaintext = item.content?.plaintext || '';
      const facets = item.content?.facets;
      const content = applyFacets(plaintext, facets);
      let html = `<li>${content}`;

      // Handle nested lists (inherit parent list type)
      if (item.children && item.children.length > 0) {
        html += `<${listTag}>${renderListItems(item.children, listTag)}</${listTag}>`;
      }

      html += '</li>';
      return html;
    })
    .join('');
}

/**
 * Render an unordered list block
 */
function renderUnorderedListBlock(block: LeafletUnorderedListBlock): string {
  const itemsHtml = renderListItems(block.children, 'ul');
  if (!itemsHtml) {
    return '';
  }
  return `<ul>${itemsHtml}</ul>`;
}

/**
 * Render an ordered list block
 */
function renderOrderedListBlock(block: LeafletOrderedListBlock): string {
  const itemsHtml = renderListItems(block.children, 'ol');
  if (!itemsHtml) {
    return '';
  }
  return `<ol>${itemsHtml}</ol>`;
}

/**
 * Render an image block
 */
function renderImageBlock(block: LeafletImageBlock, authorDid: string): string {
  const blobCid = block.image?.ref?.$link;
  if (!blobCid) {
    return '';
  }

  const url = getBlobUrl(authorDid, blobCid);
  const alt = block.alt ? escapeHtml(block.alt) : '';

  // Apply aspect ratio if available
  let style = '';
  if (block.aspectRatio) {
    const { width, height } = block.aspectRatio;
    style = ` style="aspect-ratio: ${width} / ${height}; width: 100%; height: auto; object-fit: cover"`;
  }

  return `<img src="${url}" alt="${alt}"${style} loading="lazy" />`;
}

/**
 * Render a website preview block
 */
function renderWebsiteBlock(block: LeafletWebsiteBlock, authorDid: string): string {
  const url = block.url;
  if (!url) {
    return '';
  }

  const title = block.title || url;
  const description = block.description || '';
  const thumbCid = block.thumb?.ref?.$link;

  let html =
    '<div class="website-preview" style="border: 1px solid var(--border, #e5e5e5); border-radius: 8px; overflow: hidden; margin: 1em 0">';

  if (thumbCid) {
    const thumbUrl = getBlobUrl(authorDid, thumbCid);
    html += `<img src="${thumbUrl}" alt="" style="width: 100%; max-height: 200px; object-fit: cover" loading="lazy" />`;
  }

  html += '<div style="padding: 12px">';
  html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="font-weight: 600; text-decoration: none">${escapeHtml(title)}</a>`;

  if (description) {
    html += `<p style="margin: 4px 0 0; font-size: 0.875em; color: var(--text-secondary, #666)">${escapeHtml(description)}</p>`;
  }

  html += '</div></div>';

  return html;
}

/**
 * Render a Bluesky post embed block
 * Returns a placeholder div that gets hydrated by the bskyEmbed action
 */
function renderBskyPostBlock(block: LeafletBskyPostBlock): string {
  const postUri = block.postRef?.uri;
  if (!postUri) {
    return '';
  }

  // Return placeholder that will be hydrated by Svelte action
  return `<div class="bsky-post-embed" data-uri="${escapeHtml(postUri)}"></div>`;
}

/**
 * Render a page reference block (sub-page)
 */
function renderPageBlock(block: LeafletPageBlock): string {
  const pageId = block.pageId;
  if (!pageId) {
    return '';
  }

  // Page blocks reference other pages in the same document
  // For now, render as a placeholder since we'd need the full document context
  return `<div class="page-reference" style="border: 1px solid var(--border, #e5e5e5); border-radius: 8px; padding: 12px; margin: 1em 0; background: var(--bg-secondary, #f5f5f5)">
		<em>[Sub-page: ${escapeHtml(pageId)}]</em>
	</div>`;
}

/**
 * Render a single block based on its type
 */
function renderBlock(block: LeafletBlock, authorDid: string): string {
  switch (block.$type) {
    case 'pub.leaflet.blocks.text':
      return renderTextBlock(block as LeafletTextBlock);
    case 'pub.leaflet.blocks.header':
      return renderHeaderBlock(block as LeafletHeaderBlock);
    case 'pub.leaflet.blocks.code':
      return renderCodeBlock(block as LeafletCodeBlock);
    case 'pub.leaflet.blocks.blockquote':
      return renderBlockquoteBlock(block as LeafletBlockquoteBlock);
    case 'pub.leaflet.blocks.horizontalRule':
      return renderHorizontalRuleBlock();
    case 'pub.leaflet.blocks.unorderedList':
      return renderUnorderedListBlock(block as LeafletUnorderedListBlock);
    case 'pub.leaflet.blocks.orderedList':
      return renderOrderedListBlock(block as LeafletOrderedListBlock);
    case 'pub.leaflet.blocks.image':
      return renderImageBlock(block as LeafletImageBlock, authorDid);
    case 'pub.leaflet.blocks.website':
      return renderWebsiteBlock(block as LeafletWebsiteBlock, authorDid);
    case 'pub.leaflet.blocks.bskyPost':
      return renderBskyPostBlock(block as LeafletBskyPostBlock);
    case 'pub.leaflet.blocks.page':
      return renderPageBlock(block as LeafletPageBlock);
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
 * Main entry point: render Leaflet content to HTML
 */
export function renderLeafletContent(content: LeafletContent, authorDid: string): string {
  if (!content.pages || content.pages.length === 0) {
    return '';
  }

  const htmlParts: string[] = [];

  for (const page of content.pages) {
    if (page.$type !== 'pub.leaflet.pages.linearDocument' || !page.blocks) {
      continue;
    }

    for (const wrapper of page.blocks) {
      const blockHtml = renderBlock(wrapper.block, authorDid);
      if (blockHtml) {
        // Apply alignment if specified
        if (wrapper.alignment && wrapper.alignment !== 'left') {
          const alignStyle =
            wrapper.alignment === 'center' ? 'text-align: center' : 'text-align: right';
          htmlParts.push(`<div style="${alignStyle}">${blockHtml}</div>`);
        } else {
          htmlParts.push(blockHtml);
        }
      }
    }
  }

  return htmlParts.join('\n');
}
