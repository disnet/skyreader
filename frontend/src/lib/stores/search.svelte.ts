import { api, ApiError, type SearchHit, type SearchKind } from '$lib/services/api';

// Full-text search over everything the reader has read, saved and highlighted
// (Supporter). The index lives on the server, one per reader — see
// docs/plans/FULL_TEXT_SEARCH.md — so unlike Saved search (savedSearch.svelte.ts,
// fully local) this needs a connection; offline, the page hands the query to
// Saved search instead.

const DEBOUNCE_MS = 250;
const PAGE_SIZE = 20;
// While the index is still building (a first sync of a long history), re-ask
// every few seconds so results fill in without the reader retyping.
const BUILDING_POLL_MS = 4_000;
const BUILDING_POLL_MAX = 30;

function createSearchStore() {
  let query = $state('');
  let kind = $state<SearchKind | null>(null);
  let results = $state<SearchHit[]>([]);
  let terms = $state<string[]>([]);
  let total = $state(0);
  let totalCapped = $state(false);
  let building = $state(false);
  let indexedItems = $state(0);
  let loading = $state(false);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  /** The query the shown results answer, so the page can tell "no hits" from "not asked yet". */
  let answeredQuery = $state('');
  /** Bumped to ask the input to take focus (opening via `/`). */
  let focusRequest = $state(0);
  /** The search page is mounted; polling stops when it isn't. */
  let surfaceActive = false;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polls = 0;
  let controller: AbortController | null = null;
  // Every request takes a ticket; a response whose ticket isn't the latest is
  // stale (the reader kept typing) and is dropped.
  let ticket = 0;

  function clearTimers() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pollTimer) clearTimeout(pollTimer);
    debounceTimer = null;
    pollTimer = null;
  }

  function reset() {
    controller?.abort();
    controller = null;
    results = [];
    terms = [];
    total = 0;
    totalCapped = false;
    loading = false;
    error = null;
    answeredQuery = '';
  }

  async function run(opts: { poll?: boolean } = {}) {
    const q = query.trim();
    if (!q) {
      reset();
      return;
    }
    if (!opts.poll) polls = 0;
    const mine = ++ticket;
    controller?.abort();
    controller = new AbortController();
    loading = !opts.poll;
    error = null;
    try {
      const response = await api.search({
        q,
        kinds: kind ? [kind] : undefined,
        // A poll re-asks for everything already shown, so "More results" survives it.
        limit: opts.poll ? Math.min(Math.max(PAGE_SIZE, results.length), 50) : PAGE_SIZE,
        signal: controller.signal,
      });
      if (mine !== ticket) return;
      results = response.results;
      terms = response.terms;
      total = response.total;
      totalCapped = response.totalCapped;
      building = response.index.building;
      indexedItems = response.index.items;
      answeredQuery = q;
      schedulePoll();
    } catch (e) {
      if (mine !== ticket || (e instanceof DOMException && e.name === 'AbortError')) return;
      // The server's 400 for a query with nothing searchable left ("-only")
      // isn't an error worth showing: it's simply no results.
      if (e instanceof ApiError && e.status === 400) {
        results = [];
        total = 0;
        totalCapped = false;
        answeredQuery = q;
      } else {
        error = 'Search isn’t available right now.';
      }
    } finally {
      if (mine === ticket) loading = false;
    }
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!building || !surfaceActive || polls >= BUILDING_POLL_MAX) return;
    pollTimer = setTimeout(() => {
      polls++;
      void run({ poll: true });
    }, BUILDING_POLL_MS);
  }

  return {
    get query() {
      return query;
    },
    get kind() {
      return kind;
    },
    get results() {
      return results;
    },
    get terms() {
      return terms;
    },
    get total() {
      return total;
    },
    get totalCapped() {
      return totalCapped;
    },
    get building() {
      return building;
    },
    get indexedItems() {
      return indexedItems;
    },
    get loading() {
      return loading;
    },
    get loadingMore() {
      return loadingMore;
    },
    get error() {
      return error;
    },
    get answeredQuery() {
      return answeredQuery;
    },
    get focusRequest() {
      return focusRequest;
    },
    get hasMore() {
      return results.length > 0 && results.length < total;
    },

    /** Debounced: typing fires one request once the reader pauses. */
    setQuery(next: string) {
      query = next;
      clearTimers();
      if (!next.trim()) {
        reset();
        return;
      }
      debounceTimer = setTimeout(() => void run(), DEBOUNCE_MS);
    },

    /** Immediate, for Enter and for a query restored from the URL. */
    submit() {
      clearTimers();
      void run();
    },

    setKind(next: SearchKind | null) {
      if (kind === next) return;
      kind = next;
      clearTimers();
      void run();
    },

    async loadMore() {
      const q = query.trim();
      if (!q || loadingMore || results.length >= total) return;
      const mine = ticket;
      loadingMore = true;
      try {
        const response = await api.search({
          q,
          kinds: kind ? [kind] : undefined,
          limit: PAGE_SIZE,
          offset: results.length,
        });
        if (mine !== ticket) return;
        const seen = new Set(results.map((r) => r.itemKey));
        results = [...results, ...response.results.filter((r) => !seen.has(r.itemKey))];
      } catch {
        // Keep what's shown; the button stays for another try.
      } finally {
        loadingMore = false;
      }
    },

    requestFocus() {
      focusRequest++;
    },

    setSurfaceActive(active: boolean) {
      surfaceActive = active;
      if (!active && pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      } else if (active) {
        schedulePoll();
      }
    },

    clear() {
      query = '';
      clearTimers();
      reset();
    },
  };
}

export const searchStore = createSearchStore();
