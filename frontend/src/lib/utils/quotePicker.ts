import { queryTerms } from '$lib/utils/highlightLibrary';

/**
 * The Bluesky dialog's quote picker: which of the article's highlights to
 * list, and in what order.
 */

export interface QuoteCandidate {
  text: string;
  /** The reader's note on it, searched alongside the passage. */
  note: string;
}

/** Past this many highlights, the picker offers a filter. */
export const QUOTE_FILTER_AT = 6;

/**
 * The order to list in: what's chosen first, in post order, then the rest as
 * offered. Taken as a snapshot (on opening the list, or a new filter), so a
 * tick doesn't move the row out from under the pointer.
 */
export function quoteOrder(candidates: QuoteCandidate[], chosen: string[]): string[] {
  const offered = new Set(candidates.map((c) => c.text));
  return [
    ...chosen.filter((q) => offered.has(q)),
    ...candidates.map((c) => c.text).filter((q) => !chosen.includes(q)),
  ];
}

/**
 * The rows to show: `order`, then anything offered since it was taken, kept to
 * those matching every word of `query` (in the passage or the note). Chosen
 * passages always show, so one can be taken out whatever the filter.
 */
export function quoteRows(
  candidates: QuoteCandidate[],
  chosen: string[],
  order: string[],
  query: string
): QuoteCandidate[] {
  const byText = new Map(candidates.map((c) => [c.text, c]));
  const ordered = [
    ...order.filter((q) => byText.has(q)),
    ...candidates.map((c) => c.text).filter((q) => !order.includes(q)),
  ].map((q) => byText.get(q)!);
  const terms = queryTerms(query);
  if (terms.length === 0) return ordered;
  return ordered.filter((c) => {
    if (chosen.includes(c.text)) return true;
    const haystack = `${c.text}\n${c.note}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}
