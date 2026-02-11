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
 * Parse a newline-delimited list of feed URLs.
 */
export function parseTextFeedList(text: string): OPMLParseResult {
  const feeds: OPMLFeed[] = [];
  const errors: string[] = [];

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (lines.length === 0) {
    errors.push('No URLs found in file');
    return { feeds, errors };
  }

  for (const line of lines) {
    try {
      new URL(line);
    } catch {
      errors.push(`Invalid URL: ${line}`);
      continue;
    }
    feeds.push({ feedUrl: line, title: line });
  }

  return { feeds, errors };
}

/**
 * Read a File object and parse it as OPML or a newline-delimited URL list.
 * Auto-detects format based on file extension and content.
 */
export function parseImportFile(file: File): Promise<OPMLParseResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = () => {
      const content = (reader.result as string).trim();
      const isXml =
        file.name.endsWith('.opml') ||
        file.name.endsWith('.xml') ||
        content.startsWith('<?xml') ||
        content.startsWith('<opml');
      resolve(isXml ? parseOPML(content) : parseTextFeedList(content));
    };

    reader.onerror = () => {
      resolve({ feeds: [], errors: ['Failed to read file'] });
    };

    reader.readAsText(file);
  });
}

/**
 * Read a File object and parse it as OPML.
 * @deprecated Use parseImportFile instead.
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
