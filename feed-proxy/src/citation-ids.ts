// The DOI a page names for itself in its <head>. Publishers declare it for
// Google Scholar and Zotero in Highwire Press tags (citation_doi), Dublin Core
// (dc.identifier) or PRISM (prism.doi). None of it survives into the article
// body, so it's read off the page at extraction or not at all. The extension's
// live-DOM extractor (extension/src/extract-entry.js) reads the same tags.

export interface MetaTag {
  name?: string | null;
  property?: string | null;
  content: string | null;
}

// In order of preference: citation_doi is the one a scholarly page is built to
// carry; dc.identifier can name anything (an ISBN, a URL), so it only counts
// when its value is a DOI.
const DOI_META_NAMES = [
  'citation_doi',
  'bepress_citation_doi',
  'prism.doi',
  'dc.identifier.doi',
  'dc.identifier',
];

// A bare DOI, or one written as doi:…, info:doi/… or a doi.org link.
const DOI_VALUE = /^(?:doi:\s*|info:doi\/|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i;

export function doiFromMetaTags(tags: readonly MetaTag[] | null | undefined): string | null {
  if (!tags) return null;
  for (const wanted of DOI_META_NAMES) {
    for (const tag of tags) {
      const key = (tag.name || tag.property || '').trim().toLowerCase();
      if (key !== wanted) continue;
      const match = tag.content?.trim().match(DOI_VALUE);
      if (match) return match[1];
    }
  }
  return null;
}
