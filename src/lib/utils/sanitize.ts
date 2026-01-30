import DOMPurify from 'dompurify';

/**
 * Sanitizes HTML content and rewrites relative URLs to be absolute
 * based on the article's source URL.
 */
export function sanitizeHtml(html: string, baseUrl?: string): string {
	if (!html) return '';

	// If no base URL, just sanitize without URL rewriting
	if (!baseUrl) {
		return DOMPurify.sanitize(html);
	}

	let base: URL;
	try {
		base = new URL(baseUrl);
	} catch {
		// Invalid base URL, just sanitize without rewriting
		return DOMPurify.sanitize(html);
	}

	// Add hook to rewrite URLs before sanitization
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		// Rewrite img src
		if (node.tagName === 'IMG' && node.hasAttribute('src')) {
			const src = node.getAttribute('src');
			if (src) {
				const absoluteUrl = resolveUrl(src, base);
				if (absoluteUrl) {
					node.setAttribute('src', absoluteUrl);
				}
			}
		}

		// Rewrite srcset
		if (node.hasAttribute('srcset')) {
			const srcset = node.getAttribute('srcset');
			if (srcset) {
				const rewritten = rewriteSrcset(srcset, base);
				node.setAttribute('srcset', rewritten);
			}
		}

		// Rewrite anchor href
		if (node.tagName === 'A' && node.hasAttribute('href')) {
			const href = node.getAttribute('href');
			if (href) {
				const absoluteUrl = resolveUrl(href, base);
				if (absoluteUrl) {
					node.setAttribute('href', absoluteUrl);
				}
			}
		}

		// Rewrite video/audio src and poster
		if ((node.tagName === 'VIDEO' || node.tagName === 'AUDIO') && node.hasAttribute('src')) {
			const src = node.getAttribute('src');
			if (src) {
				const absoluteUrl = resolveUrl(src, base);
				if (absoluteUrl) {
					node.setAttribute('src', absoluteUrl);
				}
			}
		}
		if (node.tagName === 'VIDEO' && node.hasAttribute('poster')) {
			const poster = node.getAttribute('poster');
			if (poster) {
				const absoluteUrl = resolveUrl(poster, base);
				if (absoluteUrl) {
					node.setAttribute('poster', absoluteUrl);
				}
			}
		}

		// Rewrite source src
		if (node.tagName === 'SOURCE' && node.hasAttribute('src')) {
			const src = node.getAttribute('src');
			if (src) {
				const absoluteUrl = resolveUrl(src, base);
				if (absoluteUrl) {
					node.setAttribute('src', absoluteUrl);
				}
			}
		}
	});

	const sanitized = DOMPurify.sanitize(html);

	// Remove hook to avoid affecting other calls
	DOMPurify.removeHook('afterSanitizeAttributes');

	return sanitized;
}

/**
 * Resolves a URL against a base URL.
 * Returns the absolute URL or null if resolution fails.
 */
function resolveUrl(url: string, base: URL): string | null {
	// Skip data: and blob: URLs
	if (url.startsWith('data:') || url.startsWith('blob:')) {
		return null;
	}

	// Skip already absolute URLs
	if (url.startsWith('http://') || url.startsWith('https://')) {
		return null;
	}

	// Skip javascript: and other protocol URLs
	if (url.includes(':')) {
		return null;
	}

	// Skip anchor-only links
	if (url.startsWith('#')) {
		return null;
	}

	try {
		return new URL(url, base).href;
	} catch {
		return null;
	}
}

/**
 * Rewrites srcset attribute to use absolute URLs.
 * Handles URLs that contain commas (like Cloudflare image URLs).
 */
function rewriteSrcset(srcset: string, base: URL): string {
	// Parse srcset entries. Each entry is a URL followed by whitespace and a descriptor.
	// Entries are separated by commas, but URLs can contain commas (e.g., /image/format=auto,width=500/photo.jpg).
	// The descriptor is a width (e.g., 500w) or pixel density (e.g., 2x).
	// We match: URL (anything), then whitespace, then descriptor, then comma or end.
	const entryRegex = /\s*(.+?)\s+(\d+(?:\.\d+)?[wx])\s*(?:,|$)/gi;

	const entries: string[] = [];
	let match;

	while ((match = entryRegex.exec(srcset)) !== null) {
		const url = match[1].trim();
		const descriptor = match[2];
		const absoluteUrl = resolveUrl(url, base) || url;
		entries.push(`${absoluteUrl} ${descriptor}`);
	}

	if (entries.length === 0) {
		// Fallback: maybe there's no descriptor, treat as single URL
		const trimmed = srcset.trim();
		if (trimmed) {
			const absoluteUrl = resolveUrl(trimmed, base);
			return absoluteUrl || trimmed;
		}
		return srcset;
	}

	return entries.join(', ');
}
