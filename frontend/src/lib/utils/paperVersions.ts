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
// The backend's DOI_PATTERN: "10." + a registrant code, "/", then any suffix.
const DOI = /\b10\.\d{4,9}\/[^\s"'<>]+/;
// New-style ids (YYMM.NNNN[N]) and old-style (archive/YYMMNNN), version dropped.
const ARXIV_ID = /^(\d{4}\.\d{4,5}|[a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/;
const MAX_DOI_LENGTH = 300;

/** The backend's `normalizeDoi`: the DOI in `raw`, sentence punctuation trimmed. */
function cleanDoi(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(DOI);
  if (!match) return undefined;
  // A DOI running on through < is cut short, someone else's DOI or none.
  if (raw[match.index! + match[0].length] === '<') return undefined;
  let doi = match[0];
  for (;;) {
    const last = doi.at(-1)!;
    if ('.,;:!?'.includes(last)) {
      doi = doi.slice(0, -1);
      continue;
    }
    // A closing bracket belongs to the DOI only when it opened one inside it.
    const open = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[last];
    if (open && doi.split(open).length <= doi.split(last).length - 1) {
      doi = doi.slice(0, -1);
      continue;
    }
    break;
  }
  return doi.length > 7 && !doi.endsWith('/') && doi.length <= MAX_DOI_LENGTH ? doi : undefined;
}

/** The backend's `exactDoi`: a declared DOI counts only when it's a DOI and nothing else. */
function exactDoi(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_DOI_LENGTH) return undefined;
  const doi = value.trim();
  return doi && cleanDoi(doi) === doi ? doi : undefined;
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
  const doi = doiFromUrl(save.url) ?? exactDoi(save.doi);
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
