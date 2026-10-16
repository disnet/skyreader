/**
 * What a reader types into search, turned into quoted FTS5 terms.
 *
 * FTS5's query syntax is a small language: bare `AND`/`OR`/`NOT`/`NEAR`, `:` column
 * filters, `^`, parentheses and unbalanced quotes are all operators or errors. A
 * reader's query must never be able to throw (a stray `"` would make every search
 * fail) or reach a column or operator by accident, so every term is emitted as a
 * quoted string and only the few forms below are interpreted:
 *
 *   word        must appear (terms are ANDed)
 *   "a phrase"  must appear as a phrase
 *   word*       prefix match (2+ characters before the star)
 *   -word       must not appear (also -"a phrase"); needs at least one positive term
 *
 * The same forms the client-side Saved search accepts (frontend savedSearch.ts),
 * so a reader's habits carry over.
 */

/**
 * The query as quoted FTS5 terms. The index matches each against the item's own
 * text and its notes separately (they're two FTS5 tables), so it needs the terms
 * rather than one expression.
 */
export interface SearchTerms {
  /** Every one must appear, in the item's text or its notes. */
  positives: string[];
  /** None may appear, in either. */
  negatives: string[];
}

export interface ParsedSearchQuery extends SearchTerms {
  /** The positive words/phrases, unquoted, for the client to highlight. */
  terms: string[];
}

const MAX_QUERY_CHARS = 200;
const MAX_TERMS = 16;
const MIN_PREFIX_CHARS = 2;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

function quote(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/** Null when nothing searchable is left (empty, only punctuation, or only exclusions). */
export function parseSearchQuery(raw: string): ParsedSearchQuery | null {
  const input = raw.slice(0, MAX_QUERY_CHARS);
  const positives: string[] = [];
  const negatives: string[] = [];
  const terms: string[] = [];

  // -?"phrase" (closing quote optional, so an unfinished phrase still searches) | -?word
  const tokenPattern = /(-?)"([^"]*)"?|(-?)(\S+)/g;
  for (const match of input.matchAll(tokenPattern)) {
    if (positives.length + negatives.length >= MAX_TERMS) break;
    const isPhrase = match[2] !== undefined;
    const negated = (isPhrase ? match[1] : match[3]) === '-';
    let text = (isPhrase ? match[2] : match[4]).trim();
    let prefix = false;
    if (!isPhrase) {
      // A word may carry quotes from mid-word input (it"s); they're just noise.
      text = text.replace(/"/g, '');
      if (text.endsWith('*')) {
        text = text.replace(/\*+$/, '');
        prefix = text.length >= MIN_PREFIX_CHARS;
      }
      text = text.replace(/\*/g, '');
    }
    if (!text || !HAS_WORD_CHAR.test(text)) continue;
    const expr = prefix ? `${quote(text)}*` : quote(text);
    if (negated) {
      negatives.push(expr);
    } else {
      positives.push(expr);
      terms.push(text);
    }
  }

  if (positives.length === 0) return null;
  return { terms, positives, negatives };
}
