import { db } from '$lib/services/db';
import { safePut } from '$lib/services/safeDb.svelte';
import { api } from '$lib/services/api';
import { syncStore } from './sync.svelte';
import { matchesTerms, parseQuery, toIndexText } from '$lib/services/savedSearch';
import type { SavedItem } from '$lib/types';

// Search over the saved library. Metadata (title/author/description/domain/url)
// is matched synchronously inside the saved-items pipeline; full article text is
// matched here, against a corpus built lazily from the bodies already cached in
// IndexedDB. Nothing goes to the server: the saved library — bodies included —
// is fully local by design, so search works offline like every other saved-view
// feature.

const DEBOUNCE_MS = 150;
const BUILD_CHUNK = 100;
const BODY_BATCH = 200;

function createSavedSearchStore() {
  // Raw input, and the debounced value the pipeline actually filters on.
  let query = $state('');
  let appliedQuery = $state('');
  // Whether the search row is showing. Cleared with the query.
  let open = $state(false);
  // Bumped to ask the input to take focus (opening via `/` or the toolbar button).
  let focusRequest = $state(0);

  // The corpus is deliberately NOT reactive: it can hold megabytes of text and
  // nothing should re-diff it on every keystroke. Keyed by BOTH rkey and
  // itemGuid, because the saved list can present the same save as a bookmark
  // (keyed by uri/rkey) or as a feed article (keyed by guid) depending on
  // dedup — either representation must be able to hit on the save's body.
  let corpus: Map<string, string> | null = null;
  let building: Promise<void> | null = null;

  // Terms matched by each body, keyed by rkey/itemGuid. Keeping the individual
  // terms lets the list satisfy an AND query across metadata and body text
  // (for example, one term in the title and another in the article). `null`
  // means no active search. Always reassigned so the pipeline re-derives.
  let bodyMatchTerms = $state<Map<string, Set<string>> | null>(null);

  let terms = $derived(parseQuery(appliedQuery));
  let active = $derived(terms.length > 0);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function indexItem(target: Map<string, string>, item: SavedItem) {
    const text = toIndexText(item.content);
    if (!text) {
      target.delete(item.rkey);
      if (item.itemGuid) target.delete(item.itemGuid);
      return;
    }
    target.set(item.rkey, text);
    if (item.itemGuid) target.set(item.itemGuid, text);
  }

  async function buildCorpus(): Promise<void> {
    const next = new Map<string, string>();
    const missingBodies: SavedItem[] = [];
    let rows: SavedItem[] = [];
    try {
      rows = await db.saved.toArray();
    } catch (err) {
      console.warn('Saved search: failed to read cached bodies:', err);
    }

    for (let i = 0; i < rows.length; i += BUILD_CHUNK) {
      for (const row of rows.slice(i, i + BUILD_CHUNK)) {
        if (row.content == null) {
          missingBodies.push(row);
          continue;
        }
        indexItem(next, row);
      }
      // Yield between chunks so a large library doesn't jank the main thread.
      if (i + BUILD_CHUNK < rows.length) await new Promise((r) => setTimeout(r, 0));
    }

    corpus = next;
    // Self-heal rows whose body never landed (failed hydration, an offline
    // save, a backed stub awaiting extraction) — same pattern savesStore's
    // getContent uses on demand.
    void repairMissingBodies(missingBodies);
  }

  function ensureCorpus(): Promise<void> {
    if (corpus) return Promise.resolve();
    if (!building) {
      building = buildCorpus().finally(() => {
        building = null;
      });
    }
    return building;
  }

  async function repairMissingBodies(rows: SavedItem[]) {
    if (rows.length === 0 || !syncStore.isOnline) return;
    let repaired = false;
    for (let i = 0; i < rows.length; i += BODY_BATCH) {
      const chunk = rows.slice(i, i + BODY_BATCH);
      try {
        const { bodies } = await api.getSavedBodies(chunk.map((r) => r.rkey));
        for (const row of chunk) {
          const body = bodies[row.rkey];
          if (body == null) continue;
          const filled = { ...row, content: body };
          await safePut(db.saved, filled);
          if (corpus) {
            indexItem(corpus, filled);
            repaired = true;
          }
        }
      } catch (err) {
        console.warn('Saved search: failed to backfill missing bodies:', err);
        return;
      }
    }
    if (repaired && active) void recomputeMatches();
  }

  async function recomputeMatches(): Promise<void> {
    const forQuery = appliedQuery;
    const forTerms = parseQuery(forQuery);
    if (forTerms.length === 0) {
      bodyMatchTerms = null;
      return;
    }
    await ensureCorpus();
    // A later keystroke already superseded this pass.
    if (appliedQuery !== forQuery) return;
    const matches = new Map<string, Set<string>>();
    if (corpus) {
      for (const [key, text] of corpus) {
        const matchedTerms = forTerms.filter((term) => matchesTerms(text, [term]));
        if (matchedTerms.length > 0) matches.set(key, new Set(matchedTerms));
      }
    }
    bodyMatchTerms = matches;
  }

  function apply(value: string) {
    appliedQuery = value;
    void recomputeMatches();
  }

  function setQuery(value: string) {
    query = value;
    if (debounceTimer) clearTimeout(debounceTimer);
    // Clearing is instant — waiting 150ms to restore the full list reads as lag.
    if (value.trim() === '') {
      apply('');
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      apply(value);
    }, DEBOUNCE_MS);
  }

  function clear() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    query = '';
    apply('');
  }

  /** Show the search row and ask the input for focus (toolbar button, `/`). */
  function openSearch() {
    open = true;
    focusRequest++;
    // Warm the corpus while the user is still typing the first character.
    void ensureCorpus();
  }

  /** Hide the search row and drop the query — closing means "stop filtering". */
  function closeSearch() {
    open = false;
    clear();
  }

  return {
    get query() {
      return query;
    },
    get appliedQuery() {
      return appliedQuery;
    },
    get terms() {
      return terms;
    },
    get active() {
      return active;
    },
    get bodyMatchTerms() {
      return bodyMatchTerms;
    },
    get open() {
      return open;
    },
    get focusRequest() {
      return focusRequest;
    },
    setQuery,
    clear,
    openSearch,
    close: closeSearch,
    toggle() {
      if (open) closeSearch();
      else openSearch();
    },
    /** Full reset, used when leaving the saved view. */
    reset: closeSearch,
    /**
     * Incremental cache maintenance, called from savesStore's write points. A
     * no-op until the corpus exists — the first search builds it from scratch.
     */
    upsert(item: SavedItem) {
      if (!corpus) return;
      indexItem(corpus, item);
      if (active) void recomputeMatches();
    },
    remove(rkey: string, itemGuid?: string | null) {
      if (!corpus) return;
      corpus.delete(rkey);
      if (itemGuid) corpus.delete(itemGuid);
      if (active) void recomputeMatches();
    },
    /** Drop the corpus wholesale; the next search rebuilds it. */
    invalidate() {
      corpus = null;
      if (active) void recomputeMatches();
    },
  };
}

export const savedSearchStore = createSavedSearchStore();
