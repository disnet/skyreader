// The discussion's data layer, shared across surfaces (Phase 5).
//
// One URL's references across the Atmosphere — how many noted / posted /
// highlighted / saved it, and who. This is the wiring the feed card, the
// fullscreen reader, and any future surface have in common: fetching the
// per-lane counts, folding LANE_META into a render-ready row VM, resolving the
// people, and merging every lane into ONE chronological stream. The
// mode-specific bits — whether a lane can be created from this surface, and what
// "create" does — stay with the caller and are injected as getters.
//
// The merge is the point: an article's discussion is one conversation that
// happens to be spread across four networks, not four lists to click between.
// Lanes survive as filters over that stream. Resolving people is the expensive
// path (a PDS fetch per record), so nothing loads until the host calls
// `openStream()` — the card on its Discussion toggle, the reader when the
// section comes into view.
//
// Call it once at the top of a component's <script> (during init, so the
// internal $effect/$derived bind to that component's lifecycle). Read the
// returned getters in markup; they're reactive.
import type { IconName } from '$lib/components/Icon.svelte';
import type {
  LaneId,
  LaneRowVM,
  DiscussionEntryVM,
  DiscussionFilterId,
  DiscussionFilterVM,
  DiscussionStreamVM,
  SembleContextVM,
} from '$lib/components/articleCardView.types';
import { articleMentionsStore } from '$lib/stores/articleMentions.svelte';
import { mentionLaneItemsStore } from '$lib/stores/mentionLaneItems.svelte';
import { preferences } from '$lib/stores/preferences.svelte';
import { cleanDiscussionNote } from '$lib/utils/discussionNote';
import { formatRelativeDate } from '$lib/utils/date';

// Per-lane display metadata. The count + verb come from the network breakdown;
// this fixes the icon, name, and the create-affordance label per lane.
export const LANE_META: Record<
  LaneId,
  { icon: IconName; label: string; verb: string; noun: string; createLabel: string }
> = {
  linkblog: {
    icon: 'standard-site',
    label: 'Blogs',
    verb: 'noted',
    noun: 'note',
    createLabel: 'Write a note',
  },
  bluesky: {
    icon: 'bluesky',
    label: 'Bluesky',
    verb: 'posted',
    noun: 'post',
    createLabel: 'Post on Bluesky',
  },
  margin: {
    icon: 'margin',
    label: 'margin.at',
    verb: 'saved',
    noun: 'save',
    createLabel: 'Save to Margin',
  },
  semble: {
    icon: 'semble',
    label: 'Semble',
    verb: 'referenced',
    noun: 'save',
    createLabel: 'Save to Semble',
  },
};
export const LANE_ORDER: LaneId[] = ['linkblog', 'bluesky', 'margin', 'semble'];

export interface UseAtmosphereOptions {
  /** The URL whose Atmosphere references we resolve (reactive getter). */
  itemUrl: () => string;
  /**
   * Whether the item is shared to the user's own linkblog. Drives the "mine"
   * tint and keeps the Blogs lane visible the moment you share, before the
   * mention is indexed.
   */
  isShared: () => boolean;
  /**
   * Whether the user can contribute to a lane from this surface (mode-specific).
   * A zero-count lane shows only when it can be created, so we never render a
   * dead "add yours" row the user can't act on.
   */
  canCreate: (id: LaneId) => boolean;
  /**
   * The article's own title, used to strip the headline that bridges and bots
   * reprint as their entire post. Optional — without it those entries just keep
   * their duplicated text.
   */
  itemTitle?: () => string | undefined;
  /**
   * The publication's name, which a bridge posts just as often as the headline
   * ("Armin Ronacher's Thoughts and Writings <link>"). Stripped the same way.
   */
  sourceTitle?: () => string | undefined;
}

export interface AtmosphereApi {
  /** Lanes to render, in priority order, with LANE_META + "mine" tint folded in. */
  readonly laneRow: LaneRowVM[];
  /** The filter chips over the merged stream: All, then each lane with people. */
  readonly filters: DiscussionFilterVM[];
  /** The chip currently in effect. */
  readonly activeFilter: DiscussionFilterId;
  /** The merged, filtered, newest-first discussion. */
  readonly stream: DiscussionStreamVM;
  readonly sembleContext: SembleContextVM | undefined;
  /** Total references across lanes — the headline count on the Discussion button. */
  readonly total: number;
  /** Whether any lane hit its lookup cap (renders the count as "N+"). */
  readonly capped: boolean;
  /** Whether one of the references is the user's own (tints the count). */
  readonly mine: boolean;
  /** Start resolving people. Idempotent; call when the discussion becomes visible. */
  openStream: () => void;
  /** Re-resolve the lanes whose lookup failed. */
  retry: () => void;
  /** Narrow the stream to one lane, or back to `all`. */
  setFilter: (id: DiscussionFilterId) => void;
}

export function useAtmosphere(opts: UseAtmosphereOptions): AtmosphereApi {
  // Always-on per-card call: fetch the lane counts whenever the URL changes.
  // Batched + deduped + memoized inside the store, so this is cheap to fire.
  $effect(() => {
    const url = opts.itemUrl();
    if (url) articleMentionsStore.fetch(url);
  });

  const mentionLaneMap = $derived.by(() => {
    const url = opts.itemUrl();
    const lanes = (url ? articleMentionsStore.get(url) : undefined)?.lanes ?? [];
    return new Map(lanes.map((l) => [l.lane as LaneId, l]));
  });

  // The lanes to render. Bluesky — whose compose intent is always available —
  // always appears, guaranteeing at least one lane (so the Discussion affordance
  // is a first-class control everywhere). Other lanes show only with a count or a
  // working create affordance.
  const laneRow = $derived.by<LaneRowVM[]>(() => {
    const shared = opts.isShared();
    const rows: LaneRowVM[] = [];
    for (const id of LANE_ORDER) {
      if (id === 'linkblog' && preferences.linkblogDisabled) continue;
      const data = mentionLaneMap.get(id);
      const count = data?.count ?? 0;
      const canCreate = opts.canCreate(id);
      const isMine = id === 'linkblog' && shared;
      // Keep the Blogs lane visible the moment you share, even before the mention
      // is indexed (count still 0), so you see yourself in the discussion.
      if (id !== 'bluesky' && count === 0 && !canCreate && !isMine) continue;
      const meta = LANE_META[id];
      const capped = data?.capped ?? false;
      rows.push({
        id,
        count,
        capped,
        canCreate,
        icon: meta.icon,
        label: meta.label,
        verb: meta.verb,
        title:
          count > 0
            ? `${count}${capped ? '+' : ''} ${meta.verb} this · ${meta.label}`
            : `${meta.label} — add yours`,
        isMine,
        createLabel: meta.createLabel,
        // Once shared, the Blogs lane drops its [+] (canCreate=false) and the
        // Share control owns editing — so the create button is never "edit".
        createIsEdit: false,
      });
    }
    return rows;
  });

  // Resolving people costs a PDS fetch per record, so it stays off until the
  // host says the discussion is actually on screen. Once open, every lane that
  // has people resolves in parallel — the stream is the whole conversation, so
  // waiting for a lane to be picked would be waiting for nothing.
  let streamOpen = $state(false);

  function openStream() {
    streamOpen = true;
  }

  $effect(() => {
    if (!streamOpen) return;
    const url = opts.itemUrl();
    if (!url) return;
    for (const lane of laneRow) {
      if (lane.count > 0) mentionLaneItemsStore.load(url, lane.id);
    }
  });

  // Per-lane resolved people, keyed by lane. Reading through the store here (not
  // in the merge) keeps the derivation cheap to invalidate.
  const laneItems = $derived.by(() => {
    const url = opts.itemUrl();
    const out = new Map<LaneId, ReturnType<typeof mentionLaneItemsStore.get>>();
    if (!url || !streamOpen) return out;
    for (const lane of laneRow) {
      if (lane.count > 0) out.set(lane.id, mentionLaneItemsStore.get(url, lane.id));
    }
    return out;
  });

  let activeFilter = $state<DiscussionFilterId>('all');

  const sembleContext = $derived(laneItems.get('semble')?.sembleContext);

  let previousUrl = $state('');
  $effect(() => {
    const url = opts.itemUrl();
    if (previousUrl && url !== previousUrl) activeFilter = 'all';
    previousUrl = url;
  });

  // Only lanes that actually have people can filter anything, so the chip row
  // never offers a filter that empties the stream. `All` leads and carries the
  // total; a single populated lane needs no chips at all (the panel hides them).
  const filters = $derived.by<DiscussionFilterVM[]>(() => {
    const populated = laneRow.filter((lane) => lane.count > 0);
    if (populated.length === 0) return [];
    const all: DiscussionFilterVM = {
      id: 'all',
      label: 'All',
      count: populated.reduce((sum, lane) => sum + lane.count, 0),
      capped: populated.some((lane) => lane.capped),
      icon: null,
    };
    return [
      all,
      ...populated.map((lane) => ({
        id: lane.id,
        label: lane.label,
        count: lane.count,
        capped: lane.capped,
        icon: lane.icon,
      })),
    ];
  });

  // A filter whose lane drops out from under it (the counts refreshed, the user
  // moved to another article) falls back to the whole stream rather than showing
  // an empty panel.
  $effect(() => {
    if (activeFilter !== 'all' && !filters.some((f) => f.id === activeFilter)) {
      activeFilter = 'all';
    }
  });

  function setFilter(id: DiscussionFilterId) {
    activeFilter = id;
    // Picking a lane is also a request to see it: make sure it is resolving.
    if (id !== 'all') {
      const url = opts.itemUrl();
      const lane = laneRow.find((l) => l.id === id);
      if (url && lane && lane.count > 0) mentionLaneItemsStore.load(url, id);
    }
  }

  // The merge: every lane's people in one newest-first list, each entry told
  // which lane it came from and cleaned of the titles and links the article
  // already shows, then split into what people SAID and what merely relinked.
  const stream = $derived.by<DiscussionStreamVM>(() => {
    // Nothing has been asked for yet. Distinct from loading: with no request in
    // flight, skeletons would promise people who aren't coming, and an empty
    // state would claim nobody wrote about this. The surface renders neither.
    if (!streamOpen) return { idle: true, loading: false, entries: [], linkOnly: [] };

    const titles = [opts.itemTitle?.(), opts.sourceTitle?.()];
    const entries: DiscussionEntryVM[] = [];
    let loading = false;
    let failed = false;
    for (const lane of laneRow) {
      if (lane.count === 0) continue;
      if (activeFilter !== 'all' && activeFilter !== lane.id) continue;
      const state = laneItems.get(lane.id);
      if (!state || state.loading) {
        loading = true;
        continue;
      }
      if (state.failed) {
        failed = true;
        continue;
      }
      for (const entry of state.entries) {
        entries.push({
          ...entry,
          key: `${lane.id}|${entry.did}|${entry.url ?? ''}`,
          lane: lane.id,
          laneLabel: lane.label,
          laneIcon: lane.icon,
          // margin.at's own motivation beats the lane's generic verb; a Semble
          // save says what it did in its collection line, so its head stays bare.
          headVerb: entry.verb ?? (entry.collections?.length ? null : lane.verb),
          relativeTime: entry.createdAt ? formatRelativeDate(entry.createdAt) : null,
          isoTime: entry.createdAt,
          cleanNote: cleanDiscussionNote(entry.note, titles),
        });
      }
    }
    entries.sort(newestFirst);

    // Split the conversation from the distribution. An entry with no words, no
    // quoted passage and no named collection is a bare link drop — a bridge or a
    // bot that reposted the headline and the URL. Each of those took a full row
    // that read as broken; collected into one line, they stop competing with the
    // people who actually said something.
    const said: DiscussionEntryVM[] = [];
    const linkOnly: DiscussionEntryVM[] = [];
    // One person, one name in that line. A bot that drops the same URL twice, or
    // an account whose post the bridge mirrors into a second lane, is still one
    // linker — and the line says who linked, not how many times.
    const linkers = new Set<string>();
    for (const entry of entries) {
      const saidSomething = Boolean(entry.cleanNote || entry.quote || entry.collections?.length);
      if (saidSomething) {
        said.push(entry);
        continue;
      }
      const who = entry.did || entry.handle || entry.url || entry.key;
      if (linkers.has(who)) continue;
      linkers.add(who);
      linkOnly.push(entry);
    }

    // A lane that failed only matters while nothing else came back — one dead
    // network shouldn't put an error over the people who did show up.
    return {
      loading,
      failed: failed && entries.length === 0,
      entries: said,
      linkOnly,
    };
  });

  // Newest first; an undated reference (a record with no timestamp we could
  // parse) sorts to the end rather than pretending to be new.
  function newestFirst(a: DiscussionEntryVM, b: DiscussionEntryVM): number {
    const at = a.createdAt ? Date.parse(a.createdAt) : NaN;
    const bt = b.createdAt ? Date.parse(b.createdAt) : NaN;
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return bt - at;
  }

  function retry() {
    const url = opts.itemUrl();
    if (!url) return;
    streamOpen = true;
    for (const lane of laneRow) {
      if (lane.count > 0) mentionLaneItemsStore.load(url, lane.id, { force: true });
    }
  }

  const total = $derived(laneRow.reduce((sum, l) => sum + l.count, 0));
  const capped = $derived(laneRow.some((l) => l.capped));
  const mine = $derived(laneRow.some((l) => l.isMine));

  return {
    get laneRow() {
      return laneRow;
    },
    get filters() {
      return filters;
    },
    get activeFilter() {
      return activeFilter;
    },
    get stream() {
      return stream;
    },
    get sembleContext() {
      return sembleContext;
    },
    get total() {
      return total;
    },
    get capped() {
      return capped;
    },
    get mine() {
      return mine;
    },
    openStream,
    setFilter,
    retry,
  };
}
