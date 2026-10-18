// Scholarly identifiers for a saved item: its DOI and arXiv id, for citing it.
//
// Nothing stores these. They're read off what a save already has, at export
// time: the URL (doi.org links, publisher /doi/ paths, arXiv and bioRxiv pages),
// and for a PDF its first page, where publishers print the DOI and arXiv prints
// its id. An article page's body is never searched: a blog post that links to
// a paper would otherwise be cited as that paper.

import { htmlToText } from '../../utils/html-text';

export interface ScholarlyIds {
  doi?: string;
  arxivId?: string;
}

// The DOI Handbook's syntax: "10." + a registrant code, "/", then any suffix.
// The suffix can hold almost anything; the end of one in running text is found
// by trimming what can't be its last character.
const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s"'<>]+/;

// New-style ids (2007 on): YYMM.NNNN (to 2014) or YYMM.NNNNN. Old style:
// archive(.SUBJ)/YYMMNNN, e.g. hep-th/9901001 or math.GT/0309136.
const ARXIV_NEW = /(?<![\d.])(\d{4}\.\d{4,5})(?:v\d+)?(?![\d.]*\d)/;
const ARXIV_OLD = /\b([a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?\b/;

/** `raw` as a DOI, its trailing sentence punctuation trimmed, or undefined. */
export function normalizeDoi(raw: string): string | undefined {
  const match = raw.match(DOI_PATTERN);
  if (!match) return undefined;
  // Cut at a < it can't hold: an old Wiley SICI DOI runs on through <…>, and a
  // DOI cut short is someone else's DOI or none, worse than no DOI.
  if (raw[match.index! + match[0].length] === '<') return undefined;
  let doi = match[0];
  // Trailing punctuation belongs to the sentence, and a closing bracket only
  // to the DOI when it opened one inside it (10.1002/(SICI)1097-…).
  for (;;) {
    const last = doi.at(-1)!;
    if ('.,;:!?'.includes(last)) {
      doi = doi.slice(0, -1);
      continue;
    }
    const open = { ')': '(', ']': '[', '}': '{' }[last];
    if (open && doi.split(open).length <= doi.split(last).length - 1) {
      doi = doi.slice(0, -1);
      continue;
    }
    break;
  }
  return doi.length > '10.1234/'.length - 1 && !doi.endsWith('/') ? doi : undefined;
}

function arxivIdIn(text: string): string | undefined {
  return (text.match(ARXIV_NEW) ?? text.match(ARXIV_OLD))?.[1];
}

// arXiv mints a DOI for every paper (10.48550/arXiv.<id>), which is also its id.
function arxivIdFromDoi(doi: string): string | undefined {
  const match = doi.match(/^10\.48550\/arxiv\.(.+)$/i);
  return match ? arxivIdIn(match[1]) : undefined;
}

const ARXIV_HOSTS = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org']);
const DOI_HOSTS = new Set(['doi.org', 'dx.doi.org', 'www.doi.org']);
// bioRxiv and medRxiv paths are their DOI plus a version: /content/10.1101/2020.01.01.123456v2.
const PREPRINT_HOSTS = new Set([
  'biorxiv.org',
  'www.biorxiv.org',
  'medrxiv.org',
  'www.medrxiv.org',
]);

/** The identifiers a URL names, if it's a DOI link or an arXiv, bioRxiv or publisher page. */
export function idsFromUrl(rawUrl: string): ScholarlyIds {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {};
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return {};
  const host = url.hostname.toLowerCase();
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }

  if (ARXIV_HOSTS.has(host)) {
    const match = path.match(/^\/(?:abs|pdf|html|format)\/(.+?)(?:\.pdf)?\/?$/);
    const arxivId = match ? arxivIdIn(match[1]) : undefined;
    return arxivId ? { arxivId, doi: `10.48550/arXiv.${arxivId}` } : {};
  }

  let doi: string | undefined;
  if (DOI_HOSTS.has(host)) {
    doi = normalizeDoi(path.slice(1));
  } else if (PREPRINT_HOSTS.has(host)) {
    const match = path.match(/^\/content\/(10\.1101\/(?:\d{4}\.\d{2}\.\d{2}\.)?\d+)/);
    doi = match ? normalizeDoi(match[1]) : undefined;
  } else {
    // ACM, Wiley, Taylor & Francis, SAGE, PNAS, Science, … all serve a paper at
    // /doi/[abs|full|pdf|epdf|book/]10.xxxx/…
    const match = path.match(/\/doi\/(?:[a-z]+\/)?(10\.\d{4,9}\/.+)$/i);
    doi = match ? normalizeDoi(match[1]) : undefined;
    // Publishers append the format to the DOI's path: /doi/pdf/10.1145/3290605.3300233.pdf
    if (doi && /\/doi\/(?:e?pdf)\//i.test(path)) doi = doi.replace(/\.pdf$/i, '');
  }
  if (!doi) return {};
  const arxivId = arxivIdFromDoi(doi);
  return arxivId ? { doi, arxivId } : { doi };
}

// A DOI on a first page is introduced as one: "DOI: 10.…", "doi:10.…",
// "https://doi.org/10.…". A bare 10.xxxx/… in the text could be anything,
// a reference among them.
const LABELLED_DOI =
  /(?:\bdoi\s*:?\s*|\bhttps?:\/\/(?:dx\.)?doi\.org\/|\bdoi\.org\/)(10\.\d{4,9}\/[^\s"'<>]+)/i;
// arXiv's own stamp ("arXiv:2401.12345v2 [cs.CL] 3 Jan 2024") and the way a
// paper names itself ("arXiv preprint arXiv:…" is how it cites others, so only
// the stamp's bracketed category counts).
const ARXIV_STAMP =
  /\barXiv:\s*(\d{4}\.\d{4,5}|[a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?\s*\[[a-z-]+(?:\.[A-Za-z-]+)?\]/;

// How much of a PDF's text counts as its first page when the extractor's page
// sections are missing (an older save).
const FIRST_PAGE_FALLBACK_CHARS = 6000;

/** The text of a saved PDF's first page, from the extractor's reader HTML. */
export function firstPdfPageText(html: string): string {
  const start = html.indexOf('<section data-pdf-page="1"');
  if (start === -1)
    return htmlToText(html.slice(0, FIRST_PAGE_FALLBACK_CHARS * 2)).slice(
      0,
      FIRST_PAGE_FALLBACK_CHARS
    );
  const end = html.indexOf('</section>', start);
  return htmlToText(html.slice(start, end === -1 ? undefined : end));
}

/** The identifiers printed on a PDF's first page. */
export function idsFromFirstPage(text: string): ScholarlyIds {
  const ids: ScholarlyIds = {};
  const labelled = text.match(LABELLED_DOI);
  const doi = labelled ? normalizeDoi(labelled[1]) : undefined;
  if (doi) ids.doi = doi;
  const stamp = text.match(ARXIV_STAMP);
  const arxivId = stamp?.[1] ?? (doi ? arxivIdFromDoi(doi) : undefined);
  if (arxivId) ids.arxivId = arxivId;
  return ids;
}

/**
 * A save's identifiers: from its URL first, which names the thing saved, then
 * (for a PDF) its first page. `firstPageHtml` is the head of the save's body.
 */
export function scholarlyIds(save: {
  url: string;
  contentType?: string | null;
  firstPageHtml?: string | null;
}): ScholarlyIds {
  const fromUrl = idsFromUrl(save.url);
  if (fromUrl.doi && fromUrl.arxivId) return fromUrl;
  if (save.contentType !== 'pdf' || !save.firstPageHtml) return fromUrl;
  const fromPage = idsFromFirstPage(firstPdfPageText(save.firstPageHtml));
  // The URL's id wins; the page only fills what the URL didn't name. An arXiv
  // PDF's page DOI is usually the journal version's, which is worth having.
  return {
    ...(fromPage.doi || fromUrl.doi ? { doi: fromUrl.doi ?? fromPage.doi } : {}),
    ...(fromPage.arxivId || fromUrl.arxivId
      ? { arxivId: fromUrl.arxivId ?? fromPage.arxivId }
      : {}),
  };
}
