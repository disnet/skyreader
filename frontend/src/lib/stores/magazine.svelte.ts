import type { Magazine, MagazineItemSnapshot, MagazineParams, MagazinePosition } from '$lib/types';
import { db, getMetadata, setMetadata } from '$lib/services/db';
import { api } from '$lib/services/api';
import { syncStore } from './sync.svelte';
import { auth } from './auth.svelte';
import { syncQueue, type MagazinePayload } from '$lib/services/sync-queue';
import { savesStore } from './saves.svelte';
import { itemLabelsStore } from './itemLabels.svelte';
import { preferences } from './preferences.svelte';
import { generateTid } from '$lib/utils/tid';
import {
  buildDailyMagazine,
  savedItemDisplayKey,
  savedItemLabelKeys,
  savedItemMagazineKey,
} from '$lib/utils/dailyMagazine';

// Durable, cross-device magazines. A magazine is an explicitly-generated reading
// issue whose membership + order are frozen at generate time (immune to later
// saves) and synced via D1 (delta cursor + offline queue, no PDS record). The
// route/home surfaces render `current` (the newest issue) and resume from its
// stored position.
//
// Closure/factory pattern (matches preferences.svelte.ts) — not the class shape.

// Persisted delta cursor: max updated_at seen (unix seconds). Like the managed
// labels cursor, this is durable across sessions because the backend tombstones
// deletions, so a cold start resumes from the saved cursor instead of refetching
// the whole history. A brand-new client (no saved cursor) does one full snapshot.
const MAGAZINES_CURSOR_KEY = 'magazinesCursor';
const POSITION_DEBOUNCE_MS = 500;

/**
 * Whether magazine writes/reads can reach the backend at all. A guest has no
 * account to sync to, so every branch behaves exactly as it does offline: the
 * magazine is written to IndexedDB and the server-bound half is queued. The
 * held queue is also the sign-in migration (see syncStore.triggerSync).
 */
function canReachBackend(): boolean {
  return syncStore.isOnline && !auth.isGuest;
}

function createMagazineStore() {
  // Keyed by rkey. Holds live (non-deleted) magazines only; tombstones are
  // applied as removals and never enter this map. Non-reactive — the reactive
  // surface is the `$state` `list` rebuilt from it.
  const byRkey = new Map<string, Magazine>();
  let list = $state<Magazine[]>([]);
  let loading = $state(false);
  let generating = $state(false);

  let cursor = 0;
  let cursorLoaded = false;
  let cursorHasValue = false;

  // Debounced position writes, one timer per magazine rkey.
  const positionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function rebuildList() {
    // Newest first by createdAt so `current` = list[0].
    list = [...byRkey.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  function upsertLocal(mag: Magazine) {
    byRkey.set(mag.rkey, mag);
    rebuildList();
  }

  function removeLocal(rkey: string) {
    if (byRkey.delete(rkey)) rebuildList();
  }

  // Strip Svelte proxies before handing objects to Dexie / the network.
  function toPlain(mag: Magazine): Magazine {
    return {
      rkey: mag.rkey,
      params: { ...mag.params },
      items: mag.items.map((i) => ({ ...i })),
      position: mag.position ? { ...mag.position } : null,
      title: mag.title ?? null,
      createdAt: mag.createdAt,
      updatedAt: mag.updatedAt,
      deletedAt: mag.deletedAt ?? null,
    };
  }

  async function hydrateFromCache() {
    const rows = await db.magazines.toArray();
    byRkey.clear();
    for (const row of rows) {
      if (row.deletedAt) continue;
      byRkey.set(row.rkey, row);
    }
    rebuildList();
  }

  async function loadFromBackend() {
    if (!cursorLoaded) {
      const persisted = await getMetadata<number>(MAGAZINES_CURSOR_KEY);
      if (typeof persisted === 'number') {
        cursor = persisted;
        cursorHasValue = true;
      }
      cursorLoaded = true;
    }

    const isFull = !cursorHasValue;
    const fetched = await api.getAllMagazines(isFull ? {} : { since: cursor });

    let maxUpdatedAt = cursor;
    for (const mag of fetched) {
      if (mag.updatedAt > maxUpdatedAt) maxUpdatedAt = mag.updatedAt;
      if (mag.deletedAt != null) {
        // Tombstone (only present in deltas): remove locally + from cache.
        removeLocal(mag.rkey);
        await db.magazines.delete(mag.rkey);
        continue;
      }
      upsertLocal(mag);
      await db.magazines.put(toPlain(mag));
    }

    if (maxUpdatedAt > cursor || !cursorHasValue) {
      cursor = maxUpdatedAt;
      cursorHasValue = true;
      await setMetadata(MAGAZINES_CURSOR_KEY, cursor);
    }
  }

  async function load() {
    loading = true;
    try {
      await hydrateFromCache();
      if (canReachBackend()) {
        try {
          await loadFromBackend();
        } catch (e) {
          console.error('Failed to load magazines from backend:', e);
        }
      }
    } finally {
      loading = false;
    }
  }

  // Build the frozen item snapshot from the current saved-articles pile, honoring
  // the daily-magazine controls (minutes/order). Mirrors the candidate loop the
  // /daily route used to run live — but the result is persisted, not re-derived.
  function buildSnapshot(): { items: MagazineItemSnapshot[]; params: MagazineParams } {
    const order = preferences.dailyMagazineOrder;
    const targetMinutes = preferences.dailyMagazineMinutes;

    const candidates = [];
    for (const item of savesStore.articles) {
      const labelKeys = savedItemLabelKeys(item);
      if (labelKeys.some((key) => itemLabelsStore.isArchived(key))) continue;
      const key = savedItemMagazineKey(item);
      candidates.push({
        item,
        key,
        wordCount: item.wordCount,
        // Never-opened items sort first in 'shuffle'; frozen at generate time.
        opened: itemLabelsStore.getReadActivity(labelKeys) !== null,
        sortValue: Date.parse(item.savedAt),
      });
    }

    const issue = buildDailyMagazine(candidates, targetMinutes, new Date(), order);
    const items: MagazineItemSnapshot[] = issue.items.map((entry) => ({
      key: savedItemMagazineKey(entry.item),
      displayKey: savedItemDisplayKey(entry.item),
      rkey: entry.item.rkey,
      title: entry.item.title,
      author: entry.item.author,
      url: entry.item.url,
      domain: entry.item.domain,
      image: entry.item.image,
      wordCount: entry.item.wordCount,
      minutes: entry.minutes,
      savedAt: entry.item.savedAt ?? null,
    }));

    return {
      items,
      params: { order, targetMinutes: issue.targetMinutes, totalMinutes: issue.totalMinutes },
    };
  }

  // Mint a new magazine (Generate / New issue). Newest becomes `current`.
  async function generate(): Promise<Magazine | null> {
    generating = true;
    try {
      const { items, params } = buildSnapshot();
      if (items.length === 0) return null;

      const rkey = generateTid();
      const now = Math.floor(Date.now() / 1000);
      const mag: Magazine = {
        rkey,
        params,
        items,
        position: null,
        title: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };

      // Optimistic: local state + cache first, then push.
      upsertLocal(mag);
      await db.magazines.put(toPlain(mag));

      const payload: MagazinePayload = { rkey, params, items, position: null, title: null };
      if (canReachBackend()) {
        try {
          await api.upsertMagazine(payload);
        } catch (e) {
          console.error('Failed to sync new magazine, queueing for retry:', e);
          await syncQueue.enqueue('create', 'magazine', rkey, payload);
        }
      } else {
        await syncQueue.enqueue('create', 'magazine', rkey, payload);
      }

      return mag;
    } finally {
      generating = false;
    }
  }

  const reroll = generate;

  function getById(rkey: string): Magazine | undefined {
    return byRkey.get(rkey);
  }

  // Update a magazine's reading position (magazine-level resume pointer). Debounced
  // per rkey; optimistic local + cache, then the cheap position-only PATCH, with an
  // offline/failed fallback that resends the whole magazine through the queue.
  function setPosition(rkey: string, position: MagazinePosition) {
    const mag = byRkey.get(rkey);
    if (!mag) return;

    const next: Magazine = { ...mag, position, updatedAt: Math.floor(Date.now() / 1000) };
    upsertLocal(next);
    void db.magazines.put(toPlain(next));

    const existing = positionTimers.get(rkey);
    if (existing) clearTimeout(existing);
    positionTimers.set(
      rkey,
      setTimeout(() => {
        positionTimers.delete(rkey);
        void flushPosition(rkey, position);
      }, POSITION_DEBOUNCE_MS)
    );
  }

  async function flushPosition(rkey: string, position: MagazinePosition) {
    const mag = byRkey.get(rkey);
    const enqueueFull = async () => {
      const source = byRkey.get(rkey) ?? mag;
      if (!source) return;
      const payload: MagazinePayload = {
        rkey,
        params: source.params,
        items: source.items,
        position,
        title: source.title ?? null,
      };
      await syncQueue.enqueue('update', 'magazine', rkey, payload);
    };

    if (!canReachBackend()) {
      await enqueueFull();
      return;
    }
    try {
      const res = await api.updateMagazinePosition(rkey, position);
      // 404 → the create is still queued (or lost); resend the whole magazine so
      // the queued create+update collapse and the position lands with it.
      if (!res.success) await enqueueFull();
    } catch (e) {
      console.error('Failed to sync magazine position, queueing for retry:', e);
      await enqueueFull();
    }
  }

  // Soft-delete a magazine (not surfaced in the default UI yet; kept for a future
  // "past issues" surface). Optimistic local removal + tombstone push.
  async function remove(rkey: string) {
    removeLocal(rkey);
    await db.magazines.delete(rkey);
    const payload: MagazinePayload = {
      rkey,
      params: { order: 'shuffle', targetMinutes: 0, totalMinutes: 0 },
      items: [],
    };
    if (canReachBackend()) {
      try {
        await api.deleteMagazine(rkey);
      } catch {
        await syncQueue.enqueue('delete', 'magazine', rkey, payload);
      }
    } else {
      await syncQueue.enqueue('delete', 'magazine', rkey, payload);
    }
  }

  return {
    get magazines() {
      return list;
    },
    get current() {
      return list[0] ?? null;
    },
    get loading() {
      return loading;
    },
    get generating() {
      return generating;
    },
    load,
    generate,
    reroll,
    getById,
    setPosition,
    remove,
  };
}

export const magazineStore = createMagazineStore();
