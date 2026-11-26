// The other addresses one paper goes by, for finding what people wrote on it.
//
// A paper lives at several URLs: its doi.org link, the publisher page that link
// resolves to, an arXiv abstract page and that page's PDF. A note left on one
// of them is a note on the same paper, but Margin and Constellation look notes
// up by the exact page address. So for a page that names its DOI or arXiv id
// (in its URL, or in its <head>, which the backend passes as `doi`), these are
// the other addresses worth asking about too. Only addresses that follow from
// the identifier alone: the publisher page behind a DOI can't be known without
// resolving it.

import { normalizeArticleUrl } from './url-normalize';

// "10." + a registrant code, "/", then a suffix. A suffix can hold almost
// anything; this only has to be good enough to build a lookup address, since a
// wrong one costs a lookup that finds nothing.
const DOI = /^10\.\d{4,9}\/\S+$/;
const ARXIV_NEW = /^(\d{4}\.\d{4,5})(?:v\d+)?$/;
const ARXIV_OLD = /^([a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/;
const ARXIV_HOSTS = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org']);
const DOI_HOSTS = new Set(['doi.org', 'dx.doi.org', 'www.doi.org']);
const PREPRINT_HOSTS = new Set([
  'biorxiv.org',
  'www.biorxiv.org',
  'medrxiv.org',
  'www.medrxiv.org',
]);

/** At most this many extra addresses per page: each is a lookup or two. */
export const MAX_VARIANTS = 3;

function cleanDoi(raw: string): string | undefined {
  const doi = raw.trim().replace(/[.,;:]+$/, '');
  // A # or ? would end the doi.org link's path, asking about a shorter DOI:
  // someone else's paper. Such DOIs exist but are rare; they get no variants.
  return DOI.test(doi) && !/[#?]/.test(doi) ? doi : undefined;
}

function arxivId(raw: string): string | undefined {
  const match = raw.match(ARXIV_NEW) ?? raw.match(ARXIV_OLD);
  return match?.[1];
}

/** The DOI or arXiv id a page's address names, if it's one of the well-known shapes. */
export function idsFromUrl(rawUrl: string): { doi?: string; arxivId?: string } {
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
    const id = match ? arxivId(match[1]) : undefined;
    return id ? { arxivId: id } : {};
  }
  if (DOI_HOSTS.has(host)) {
    const doi = cleanDoi(path.slice(1));
    return doi ? { doi } : {};
  }
  // bioRxiv and medRxiv paths are their DOI plus a version: /content/10.1101/2020.01.01.123456v2.
  if (PREPRINT_HOSTS.has(host)) {
    const match = path.match(/^\/content\/(10\.1101\/(?:\d{4}\.\d{2}\.\d{2}\.)?\d+)/);
    const doi = match ? cleanDoi(match[1]) : undefined;
    return doi ? { doi } : {};
  }
  // ACM, Wiley, Taylor & Francis, SAGE, PNAS, Science, …: /doi/[abs|full|pdf|epdf/]10.xxxx/…
  const match = path.match(/\/doi\/(?:[a-z]+\/)?(10\.\d{4,9}\/.+)$/i);
  if (!match) return {};
  let doi = cleanDoi(match[1]);
  if (doi && /\/doi\/(?:e?pdf)\//i.test(path)) doi = doi.replace(/\.pdf$/i, '');
  return doi ? { doi } : {};
}

/**
 * The normalized addresses, other than the page's own, that the same paper
 * goes by: its doi.org link, and for an arXiv paper its abstract page and PDF.
 * `declaredDoi` is the DOI the page named in its <head>, when the caller has it;
 * a DOI in the address itself wins over it.
 */
export function paperVariantUrls(rawUrl: string, declaredDoi?: string | null): string[] {
  const self = normalizeArticleUrl(rawUrl);
  if (!self) return [];
  const fromUrl = idsFromUrl(rawUrl);
  const doi = fromUrl.doi ?? (declaredDoi ? cleanDoi(declaredDoi) : undefined);
  // arXiv mints a DOI for every paper (10.48550/arXiv.<id>).
  const arxiv =
    fromUrl.arxivId ??
    (doi?.match(/^10\.48550\/arxiv\.(.+)$/i)
      ? arxivId(doi.slice('10.48550/arXiv.'.length))
      : undefined);

  const candidates: string[] = [];
  if (arxiv) {
    candidates.push(`https://arxiv.org/abs/${arxiv}`, `https://arxiv.org/pdf/${arxiv}`);
  }
  const doiForLink = doi ?? (arxiv ? `10.48550/arXiv.${arxiv}` : undefined);
  if (doiForLink) candidates.push(`https://doi.org/${doiForLink}`);

  const out: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeArticleUrl(candidate);
    if (!normalized || normalized === self || out.includes(normalized)) continue;
    out.push(normalized);
    if (out.length >= MAX_VARIANTS) break;
  }
  return out;
}
