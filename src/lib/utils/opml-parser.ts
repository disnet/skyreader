export interface OPMLFeed {
	feedUrl: string;
	title: string;
	siteUrl?: string;
	category?: string;
}

export interface OPMLParseResult {
	feeds: OPMLFeed[];
	errors: string[];
}

/**
 * Parse an OPML file and extract feed subscriptions.
 * Handles nested outlines (folders) by extracting category from parent elements.
 */
export function parseOPML(xmlContent: string): OPMLParseResult {
	const feeds: OPMLFeed[] = [];
	const errors: string[] = [];

	let doc: Document;
	try {
		const parser = new DOMParser();
		doc = parser.parseFromString(xmlContent, 'application/xml');

		// Check for XML parsing errors
		const parseError = doc.querySelector('parsererror');
		if (parseError) {
			return { feeds: [], errors: ['Invalid XML: ' + parseError.textContent] };
		}
	} catch (e) {
		return { feeds: [], errors: ['Failed to parse XML'] };
	}

	// Find all outline elements with xmlUrl (actual feed subscriptions)
	const outlines = doc.querySelectorAll('outline[xmlUrl]');

	if (outlines.length === 0) {
		errors.push('No feeds found in OPML file');
		return { feeds, errors };
	}

	outlines.forEach((outline) => {
		const feedUrl = outline.getAttribute('xmlUrl')?.trim();
		if (!feedUrl) return;

		// Validate URL
		try {
			new URL(feedUrl);
		} catch {
			errors.push(`Invalid feed URL: ${feedUrl}`);
			return;
		}

		// Get title from text or title attribute
		const title =
			outline.getAttribute('text')?.trim() || outline.getAttribute('title')?.trim() || feedUrl;

		// Get site URL if available
		const siteUrl = outline.getAttribute('htmlUrl')?.trim() || undefined;

		// Get category from parent outline (folder)
		let category: string | undefined;
		const parent = outline.parentElement;
		if (parent && parent.tagName.toLowerCase() === 'outline') {
			category =
				parent.getAttribute('text')?.trim() || parent.getAttribute('title')?.trim() || undefined;
		}

		feeds.push({
			feedUrl,
			title,
			siteUrl,
			category,
		});
	});

	return { feeds, errors };
}

/**
 * Read a File object and parse it as OPML.
 */
export function parseOPMLFile(file: File): Promise<OPMLParseResult> {
	return new Promise((resolve) => {
		const reader = new FileReader();

		reader.onload = () => {
			const content = reader.result as string;
			resolve(parseOPML(content));
		};

		reader.onerror = () => {
			resolve({ feeds: [], errors: ['Failed to read file'] });
		};

		reader.readAsText(file);
	});
}
