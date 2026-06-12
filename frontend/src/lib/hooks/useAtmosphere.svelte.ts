// The Atmosphere row's data layer, shared across surfaces (Phase 5).
//
// One URL's references across the Atmosphere — how many noted / posted /
// highlighted / saved it, and (lazily, on expand) who. This is the wiring the
// feed card, the fullscreen reader, and any future surface have in common:
// fetching the per-lane counts, folding LANE_META into a render-ready row VM,
// and resolving a lane's people on demand. The mode-specific bits — whether a
// lane can be created from this surface, and what "create" does — stay with the
// caller and are injected as getters.
//
// Call it once at the top of a component's <script> (during init, so the
// internal $effect/$derived bind to that component's lifecycle). Read the
// returned getters in markup; they're reactive.
import type { IconName } from '$lib/components/Icon.svelte';
import type { LaneId, LaneRowVM, ExpandedLaneItemsVM } from '$lib/components/articleCardView.types';
import { articleMentionsStore } from '$lib/stores/articleMentions.svelte';
import { mentionLaneItemsStore } from '$lib/stores/mentionLaneItems.svelte';

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
    verb: 'saved',
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
}

export interface AtmosphereApi {
  /** Lanes to render, in priority order, with LANE_META + "mine" tint folded in. */
  readonly laneRow: LaneRowVM[];
  /** Which lane is expanded to show its people (one at a time). */
  readonly expandedLane: LaneId | null;
  /** The resolved people inside the expanded lane (undefined before first load). */
  readonly expandedLaneItems: ExpandedLaneItemsVM | undefined;
  /** Total references across lanes — the headline count on the Discussion button. */
  readonly total: number;
  /** Whether any lane hit its lookup cap (renders the count as "N+"). */
  readonly capped: boolean;
  /** Whether one of the references is the user's own (tints the count). */
  readonly mine: boolean;
  /** Expand a lane (or collapse it if already open), resolving its people lazily. */
  toggleLane: (id: LaneId) => void;
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
        // note box owns editing — so the create button is never "edit".
        createIsEdit: false,
      });
    }
    return rows;
  });

  let expandedLane = $state<LaneId | null>(null);
  const expandedLaneItems = $derived.by<ExpandedLaneItemsVM | undefined>(() => {
    const url = opts.itemUrl();
    return expandedLane && url ? mentionLaneItemsStore.get(url, expandedLane) : undefined;
  });

  function toggleLane(id: LaneId) {
    if (expandedLane === id) {
      expandedLane = null;
      return;
    }
    expandedLane = id;
    // Only resolve people for lanes that actually have references — a zero-count
    // lane (just a create affordance) has nobody to fetch.
    const url = opts.itemUrl();
    const hasPeople = (mentionLaneMap.get(id)?.count ?? 0) > 0;
    if (hasPeople && url) mentionLaneItemsStore.load(url, id);
  }

  const total = $derived(laneRow.reduce((sum, l) => sum + l.count, 0));
  const capped = $derived(laneRow.some((l) => l.capped));
  const mine = $derived(laneRow.some((l) => l.isMine));

  return {
    get laneRow() {
      return laneRow;
    },
    get expandedLane() {
      return expandedLane;
    },
    get expandedLaneItems() {
      return expandedLaneItems;
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
    toggleLane,
  };
}
