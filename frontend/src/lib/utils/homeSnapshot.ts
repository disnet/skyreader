// Home's last painted lanes, kept so a cold start paints them on the first frame.
//
// Home is built from several stores that each hydrate asynchronously (saves and
// labels from IndexedDB, Shelf collections from Dexie metadata, rooms from their
// snapshots, follows from the network), so a cold launch used to paint the
// masthead over skeleton lanes and then fill the cards in. This is the rendered
// result instead: titles, sources and image URLs, small enough to read
// synchronously from localStorage while the component is being set up. HomePage
// shows it until the live lanes are ready, then swaps to them; the two are
// normally the same, so the swap doesn't show.
//
// Per account (a guest under `guest`), and removed with the rest of the local
// library (clearAllData), since it holds the titles of what this reader saved.

import type { IconName } from '$lib/components/Icon.svelte';
import type { LaneCardVM } from '$lib/components/feed/homeLane';

const STORAGE_PREFIX = 'skyreader-home-snapshot:';
const VERSION = 1;
/** An older snapshot is likely to show what the reader has long since moved on
 *  from, so a cold start waits for the live lanes instead. */
export const HOME_SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** A tile as painted. No `displayItem`: opening waits for the live lanes. */
export type SnapshotCard = Omit<LaneCardVM, 'displayItem'>;

export type SnapshotAction = { kind: 'link'; label: string; href: string } | { kind: 'shuffle' };

export interface SnapshotLane {
  title: string;
  icon: IconName;
  action?: SnapshotAction;
  items: SnapshotCard[];
}

/** One Home section, in order. Without `lane` it's a section that draws itself
 *  from its own store (the highlights card, the magazine rail), so the
 *  snapshot only keeps its place. */
export interface SnapshotSection {
  id: string;
  lane?: SnapshotLane;
}

export interface HomeSnapshot {
  v: typeof VERSION;
  savedAt: number;
  sections: SnapshotSection[];
  /** Random picks' rkeys for the next cold start, so the live lane draws the
   *  same tiles the snapshot painted. */
  sample: string[];
}

function storageKey(owner: string): string {
  return STORAGE_PREFIX + owner;
}

export function toSnapshotCard(vm: LaneCardVM): SnapshotCard {
  const card: SnapshotCard = {
    key: vm.key,
    title: vm.title,
    domain: vm.domain,
    image: vm.image,
    faviconUrl: vm.faviconUrl,
    metaLabel: vm.metaLabel,
    progress: vm.progress,
  };
  if (vm.read !== undefined) card.read = vm.read;
  return card;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isCard(v: unknown): v is SnapshotCard {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    isString(c.key) &&
    isString(c.title) &&
    (c.domain === null || isString(c.domain)) &&
    (c.image === null || isString(c.image)) &&
    isString(c.faviconUrl) &&
    (c.metaLabel === null || isString(c.metaLabel)) &&
    (c.progress === null || typeof c.progress === 'number') &&
    (c.read === undefined || typeof c.read === 'boolean')
  );
}

function isAction(v: unknown): v is SnapshotAction {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  if (a.kind === 'shuffle') return true;
  return a.kind === 'link' && isString(a.label) && isString(a.href);
}

function isSection(v: unknown): v is SnapshotSection {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (!isString(s.id)) return false;
  if (s.lane === undefined) return true;
  const lane = s.lane as Record<string, unknown> | null;
  return (
    !!lane &&
    typeof lane === 'object' &&
    isString(lane.title) &&
    isString(lane.icon) &&
    (lane.action === undefined || isAction(lane.action)) &&
    Array.isArray(lane.items) &&
    lane.items.every(isCard)
  );
}

/** Parse a stored snapshot. Anything malformed, from another version or too old
 *  reads as none: the snapshot is only ever a head start. */
export function parseHomeSnapshot(raw: string | null, now: number): HomeSnapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== VERSION || typeof p.savedAt !== 'number') return null;
  if (now - p.savedAt > HOME_SNAPSHOT_MAX_AGE_MS) return null;
  if (!Array.isArray(p.sections) || !p.sections.every(isSection)) return null;
  if (!Array.isArray(p.sample) || !p.sample.every(isString)) return null;
  // A snapshot with no tiles would only paint empty space.
  if (!p.sections.some((s) => (s as SnapshotSection).lane)) return null;
  return parsed as HomeSnapshot;
}

export function readHomeSnapshot(owner: string, now = Date.now()): HomeSnapshot | null {
  try {
    return parseHomeSnapshot(localStorage.getItem(storageKey(owner)), now);
  } catch {
    return null;
  }
}

/** Store the snapshot, or drop it when Home has no lanes to paint (a new
 *  account's first run, or everything hidden): a cold start then shows what it
 *  does today rather than tiles that are gone. */
export function writeHomeSnapshot(owner: string, snapshot: HomeSnapshot | null): void {
  try {
    if (!snapshot || !snapshot.sections.some((s) => s.lane)) {
      localStorage.removeItem(storageKey(owner));
      return;
    }
    localStorage.setItem(storageKey(owner), JSON.stringify(snapshot));
  } catch {
    // Storage full or blocked: the next cold start just waits for the cache.
  }
}

/** Every account's snapshot, for clearAllData. */
export function clearHomeSnapshots(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // No storage to clear.
  }
}

/** The pictures a snapshot paints: covers, else favicons, as a tile shows them. */
export function snapshotImageUrls(snapshot: HomeSnapshot): string[] {
  const urls = new Set<string>();
  for (const section of snapshot.sections) {
    for (const card of section.lane?.items ?? []) {
      if (card.image) urls.add(card.image);
      else if (card.faviconUrl) urls.add(card.faviconUrl);
    }
  }
  return [...urls];
}
