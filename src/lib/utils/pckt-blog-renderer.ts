/**
 * Renderer for blog.pckt.content block-based documents
 * Converts pckt.blog blocks to HTML for display in ArticleCard
 */

import type {
	PcktBlogContent,
	PcktBlogBlock,
	PcktBlogFacet,
	PcktBlogTextBlock,
	PcktBlogHeadingBlock,
	PcktBlogBlockquoteBlock,
	PcktBlogOrderedListBlock,
	PcktBlogListItemBlock,
	PcktBlogImageBlock,
	PcktBlogTableBlock,
	PcktBlogTableRowBlock,
	PcktBlogTableCellBlock,
	PcktBlogBlueskyEmbedBlock,
	PcktBlogIframeBlock,
	PcktBlogWebsiteBlock,
} from '$lib/types';

/**
 * Check if content is blog.pckt.content format
 */
export function isPcktBlogContent(content: unknown): content is PcktBlogContent {
	return (
		typeof content === 'object' &&
		content !== null &&
		'$type' in content &&
		(content as { $type: string }).$type === 'blog.pckt.content'
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
function applyFacets(plaintext: string, facets?: PcktBlogFacet[]): string {
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
				case 'blog.pckt.richtext.facet#bold':
					wrappedText = `<strong>${wrappedText}</strong>`;
					break;
				case 'blog.pckt.richtext.facet#italic':
					wrappedText = `<em>${wrappedText}</em>`;
					break;
				case 'blog.pckt.richtext.facet#code':
					wrappedText = `<code>${wrappedText}</code>`;
					break;
				case 'blog.pckt.richtext.facet#link':
					if (feature.uri) {
						wrappedText = `<a href="${escapeHtml(feature.uri)}" target="_blank" rel="noopener">${wrappedText}</a>`;
					}
					break;
				case 'blog.pckt.richtext.facet#didMention':
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
function renderTextBlock(block: PcktBlogTextBlock): string {
	if (!block.plaintext) {
		return '';
	}
	return `<p>${applyFacets(block.plaintext, block.facets)}</p>`;
}

/**
 * Render a heading block
 */
function renderHeadingBlock(block: PcktBlogHeadingBlock): string {
	if (!block.plaintext) {
		return '';
	}
	const level = block.level || 2;
	const tag = `h${Math.min(Math.max(level, 1), 6)}`;
	return `<${tag}>${escapeHtml(block.plaintext)}</${tag}>`;
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
function renderImageBlock(block: PcktBlogImageBlock, authorDid: string): string {
	const blobCid = block.attrs?.blob?.ref?.$link;
	if (!blobCid) {
		return '';
	}

	const url = getBlobUrl(authorDid, blobCid);
	const alt = block.attrs?.alt ? escapeHtml(block.attrs.alt) : '';
	const align = block.attrs?.align || 'left';

	let style = '';
	if (align === 'center') {
		style = ' style="display: block; margin: 0 auto"';
	} else if (align === 'right') {
		style = ' style="display: block; margin-left: auto"';
	}

	return `<img src="${url}" alt="${alt}"${style} loading="lazy" />`;
}

/**
 * Render blockquote content (nested blocks)
 */
function renderBlockquoteBlock(block: PcktBlogBlockquoteBlock, authorDid: string): string {
	if (!block.content || block.content.length === 0) {
		return '';
	}

	const innerHtml = block.content.map((inner) => renderBlock(inner, authorDid)).join('\n');
	return `<blockquote>${innerHtml}</blockquote>`;
}

/**
 * Render list item content
 */
function renderListItemContent(item: PcktBlogListItemBlock, authorDid: string): string {
	if (!item.content || item.content.length === 0) {
		return '<li></li>';
	}

	const innerHtml = item.content
		.map((inner) => {
			// Text blocks inside list items shouldn't be wrapped in <p>
			if (inner.$type === 'blog.pckt.block.text') {
				const textBlock = inner as PcktBlogTextBlock;
				return applyFacets(textBlock.plaintext || '', textBlock.facets);
			}
			return renderBlock(inner, authorDid);
		})
		.join('');

	return `<li>${innerHtml}</li>`;
}

/**
 * Render an ordered list block
 */
function renderOrderedListBlock(block: PcktBlogOrderedListBlock, authorDid: string): string {
	if (!block.content || block.content.length === 0) {
		return '';
	}

	const start = block.attrs?.start || 1;
	const itemsHtml = block.content
		.filter((item) => item.$type === 'blog.pckt.block.listItem')
		.map((item) => renderListItemContent(item as PcktBlogListItemBlock, authorDid))
		.join('');

	return `<ol start="${start}">${itemsHtml}</ol>`;
}

/**
 * Render a table cell
 */
function renderTableCell(
	cell: PcktBlogTableCellBlock,
	authorDid: string,
	isHeader: boolean
): string {
	const tag = isHeader ? 'th' : 'td';
	const colspan = cell.attrs?.colspan || 1;
	const rowspan = cell.attrs?.rowspan || 1;

	let attrs = '';
	if (colspan > 1) attrs += ` colspan="${colspan}"`;
	if (rowspan > 1) attrs += ` rowspan="${rowspan}"`;

	const innerHtml =
		cell.content
			?.map((inner) => {
				if (inner.$type === 'blog.pckt.block.text') {
					const textBlock = inner as PcktBlogTextBlock;
					return applyFacets(textBlock.plaintext || '', textBlock.facets);
				}
				return renderBlock(inner, authorDid);
			})
			.join('') || '';

	return `<${tag}${attrs}>${innerHtml}</${tag}>`;
}

/**
 * Render a table row
 */
function renderTableRow(row: PcktBlogTableRowBlock, authorDid: string): string {
	if (!row.content || row.content.length === 0) {
		return '';
	}

	const cellsHtml = row.content
		.map((cell) => {
			const isHeader = cell.$type === 'blog.pckt.block.tableHeader';
			return renderTableCell(cell as PcktBlogTableCellBlock, authorDid, isHeader);
		})
		.join('');

	return `<tr>${cellsHtml}</tr>`;
}

/**
 * Render a table block
 */
function renderTableBlock(block: PcktBlogTableBlock, authorDid: string): string {
	if (!block.content || block.content.length === 0) {
		return '';
	}

	const rowsHtml = block.content
		.filter((row) => row.$type === 'blog.pckt.block.tableRow')
		.map((row) => renderTableRow(row as PcktBlogTableRowBlock, authorDid))
		.join('');

	return `<table>${rowsHtml}</table>`;
}

/**
 * Render a Bluesky post embed
 */
function renderBlueskyEmbed(block: PcktBlogBlueskyEmbedBlock): string {
	const postUri = block.attrs?.postRef?.uri;
	if (!postUri) {
		return '';
	}

	// Convert AT URI to bsky.app URL
	// at://did:plc:xxx/app.bsky.feed.post/rkey -> https://bsky.app/profile/did:plc:xxx/post/rkey
	const match = postUri.match(/at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/(.+)/);
	if (!match) {
		return `<p><em>[Bluesky post embed]</em></p>`;
	}

	const [, did, rkey] = match;
	const url = `https://bsky.app/profile/${did}/post/${rkey}`;

	return `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="bsky-embed-link">[View Bluesky post]</a></p>`;
}

/**
 * Render an iframe embed
 */
function renderIframeBlock(block: PcktBlogIframeBlock): string {
	const url = block.attrs?.url;
	if (!url) {
		return '';
	}

	const height = block.attrs?.height || 315;

	// Security: only allow https URLs
	if (!url.startsWith('https://')) {
		return `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener">[View embedded content]</a></p>`;
	}

	return `<iframe src="${escapeHtml(url)}" height="${height}" style="width: 100%; border: none; border-radius: 8px" loading="lazy" allowfullscreen></iframe>`;
}

/**
 * Render a website preview card
 */
function renderWebsiteBlock(block: PcktBlogWebsiteBlock): string {
	const url = block.attrs?.src;
	if (!url) {
		return '';
	}

	const title = block.attrs?.title || url;
	const description = block.attrs?.description || '';
	const previewImage = block.attrs?.previewImage;

	let html =
		'<div class="website-preview" style="border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin: 1em 0">';

	if (previewImage) {
		html += `<img src="${escapeHtml(previewImage)}" alt="" style="width: 100%; max-height: 200px; object-fit: cover" loading="lazy" />`;
	}

	html += '<div style="padding: 12px">';
	html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="font-weight: 600; text-decoration: none">${escapeHtml(title)}</a>`;

	if (description) {
		html += `<p style="margin: 4px 0 0; font-size: 0.875em; color: var(--text-secondary)">${escapeHtml(description)}</p>`;
	}

	html += '</div></div>';

	return html;
}

/**
 * Render a single block based on its type
 */
function renderBlock(block: PcktBlogBlock, authorDid: string): string {
	switch (block.$type) {
		case 'blog.pckt.block.text':
			return renderTextBlock(block as PcktBlogTextBlock);
		case 'blog.pckt.block.heading':
			return renderHeadingBlock(block as PcktBlogHeadingBlock);
		case 'blog.pckt.block.horizontalRule':
			return renderHorizontalRuleBlock();
		case 'blog.pckt.block.image':
			return renderImageBlock(block as PcktBlogImageBlock, authorDid);
		case 'blog.pckt.block.blockquote':
			return renderBlockquoteBlock(block as PcktBlogBlockquoteBlock, authorDid);
		case 'blog.pckt.block.orderedList':
			return renderOrderedListBlock(block as PcktBlogOrderedListBlock, authorDid);
		case 'blog.pckt.block.table':
			return renderTableBlock(block as PcktBlogTableBlock, authorDid);
		case 'blog.pckt.block.blueskyEmbed':
			return renderBlueskyEmbed(block as PcktBlogBlueskyEmbedBlock);
		case 'blog.pckt.block.iframe':
			return renderIframeBlock(block as PcktBlogIframeBlock);
		case 'blog.pckt.block.website':
			return renderWebsiteBlock(block as PcktBlogWebsiteBlock);
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
 * Main entry point: render pckt.blog content to HTML
 */
export function renderPcktBlogContent(content: PcktBlogContent, authorDid: string): string {
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
