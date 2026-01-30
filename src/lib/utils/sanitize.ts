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
 * Rewrites srcset attribute to use absolute URLs
 */
function rewriteSrcset(srcset: string, base: URL): string {
	return srcset
		.split(',')
		.map((entry) => {
			const parts = entry.trim().split(/\s+/);
			if (parts.length >= 1) {
				const absoluteUrl = resolveUrl(parts[0], base);
				if (absoluteUrl) {
					parts[0] = absoluteUrl;
				}
			}
			return parts.join(' ');
		})
		.join(', ');
}
