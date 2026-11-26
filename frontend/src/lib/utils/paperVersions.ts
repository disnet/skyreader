// A paper's other versions in the reader's own saves: its arXiv page and PDF,
// a journal page and its doi.org link. Two saves are versions of one paper when
// they name the same DOI, in their URL or declared by the page when it was saved.
//
// Mirrors the backend's `workKey` (backend/src/services/export/identifiers.ts),
// which is what exports and the Obsidian and Zotero syncs merge versions by. This
// copy only decides what the reader is shown ("also saved as", the other
// version's highlights), so a rare DOI the two parse differently costs a hint,
// not a merge.

import type { SavedItem } from '$lib/types';

const ARXIV_HOSTS = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org']);
const DOI_HOSTS = new Set(['doi.org', 'dx.doi.org', 'www.doi.org']);
const PREPRINT_HOSTS = new Set([
  'biorxiv.org',
  'www.biorxiv.org',
  'medrxiv.org',
  'www.medrxiv.org',
]);
const DOI = /^10\.\d{4,9}\/\S+$/;
// New-style ids (YYMM.NNNN[N]) and old-style (archive/YYMMNNN), version dropped.
const ARXIV_ID = /^(\d{4}\.\d{4,5}|[a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/;

function cleanDoi(raw: string | null | undefined): string | undefined {
  const doi = raw?.trim().replace(/[.,;:!?]+$/, '');
  return doi && DOI.test(doi) && doi.length <= 300 ? doi : undefined;
}

/** The DOI a page's address names (arXiv papers by their arXiv DOI), if any. */
export function doiFromUrl(rawUrl: string | null | undefined): string | undefined {
  if (!rawUrl) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase();
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  if (ARXIV_HOSTS.has(host)) {
    const match = path.match(/^\/(?:abs|pdf|html|format)\/(.+?)(?:\.pdf)?\/?$/);
    const id = match?.[1].match(ARXIV_ID)?.[1];
    return id ? `10.48550/arXiv.${id}` : undefined;
  }
  if (DOI_HOSTS.has(host)) return cleanDoi(path.slice(1));
  if (PREPRINT_HOSTS.has(host)) {
    const match = path.match(/^\/content\/(10\.1101\/(?:\d{4}\.\d{2}\.\d{2}\.)?\d+)/);
    return cleanDoi(match?.[1]);
  }
  const match = path.match(/\/doi\/(?:[a-z]+\/)?(10\.\d{4,9}\/.+)$/i);
  let doi = cleanDoi(match?.[1]);
  if (doi && /\/doi\/(?:e?pdf)\//i.test(path)) doi = doi.replace(/\.pdf$/i, '');
  return doi;
}

/** The paper a save is a version of, `doi:<lowercased DOI>`, or undefined. */
export function paperKey(save: Pick<SavedItem, 'url' | 'doi'>): string | undefined {
  const doi = doiFromUrl(save.url) ?? cleanDoi(save.doi);
  return doi ? `doi:${doi.toLowerCase()}` : undefined;
}

/** The reader's other saves of the same paper as `save`, first saved first. */
export function otherVersions(save: SavedItem, saves: readonly SavedItem[]): SavedItem[] {
  const key = paperKey(save);
  if (!key) return [];
  return saves
    .filter((s) => s.rkey !== save.rkey && paperKey(s) === key)
    .sort((a, b) => Date.parse(a.savedAt) - Date.parse(b.savedAt));
}

/** How to name a version to the reader: "the PDF", "the arXiv page", else its site. */
export function versionLabel(save: SavedItem): string {
  if (save.contentType === 'pdf') return 'the PDF';
  let host = '';
  try {
    host = new URL(save.url).hostname.replace(/^www\./, '');
  } catch {
    host = save.domain ?? '';
  }
  if (DOI_HOSTS.has(host)) return 'the DOI link';
  if (ARXIV_HOSTS.has(host)) return 'the arXiv page';
  return host ? `the ${host} page` : 'another version';
}
