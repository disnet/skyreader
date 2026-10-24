import { api } from '$lib/services/api';
import { getMetadata, setMetadata } from '$lib/services/db';
import { generateTid } from '$lib/utils/tid';
import { savedItemLabelKeys } from '$lib/utils/savedPile';
import type { SavedItem, ShelfCollection } from '$lib/types';
import { auth } from './auth.svelte';
import { itemLabelsStore } from './itemLabels.svelte';
import { savesStore } from './saves.svelte';
import { syncStore } from './sync.svelte';
import { toastStore } from './toast.svelte';

/**
 * The Shelf: the reference half of Saved.
 *
 * Saved is a queue — read it, archive it, it leaves. The Shelf is what a reader
 * keeps and comes back to: books, papers, long references. It isn't a separate
 * pile, it's a view over the same saves, so a save can be on both (it leaves the
 * queue when archived and stays on the Shelf).
 *
 * Two things put a save on the Shelf:
 *  - its `kept` label (itemLabelsStore.getKeptState), or, with no label, its
 *    kind: an uploaded or linked PDF/EPUB is on by default;
 *  - being in a collection.
 *
 * Collections are private, ordered groups of saves, held server-side
 * (routes/shelf.ts) and cached whole in Dexie metadata for offline display.
 * They're account-only, like Semble/Margin saves: writes need the network and
 * fail visibly rather than queueing. See docs/plans/SHELF_PLAN.md.
 */

const CACHE_KEY = 'shelfCollections';

/** How many saves a collection holds (routes/shelf.ts MAX_ITEMS_PER_COLLECTION). */
export const MAX_COLLECTION_ITEMS = 2000;

/** Kinds of save that are on the Shelf unless taken off. */
export function isReferenceKind(save: Pick<SavedItem, 'contentType'>): boolean {
  return save.contentType === 'pdf' || save.contentType === 'epub';
}

function sortCollections(list: ShelfCollection[]): ShelfCollection[] {
  return [...list].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
}

function createShelfStore() {
  let collections = $state<ShelfCollection[]>([]);
  let orderSend: Promise<unknown> = Promise.resolve();
  let loadedFor = $state<string | null>(null);
  let loading = $state(false);
  let inflight: Promise<void> | null = null;
  let loadToken: object | null = null;
  // The saves the collection picker (ShelfCollectionPicker, mounted in AppShell)
  // is open for: one from an item's menu, or the Library's selection. Null when
  // it's closed.
  let pickerSaves = $state<SavedItem[] | null>(null);

  // rkey → ids of the collections holding it.
  let membership = $derived.by(() => {
    const map = new Map<string, string[]>();
    for (const c of collections) {
      for (const item of c.items) {
        const ids = map.get(item.rkey);
        if (ids) ids.push(c.id);
        else map.set(item.rkey, [c.id]);
      }
    }
    return map;
  });

  function canWrite(): boolean {
    return Boolean(auth.user) && !auth.isGuest && syncStore.isOnline;
  }

  async function persist() {
    try {
      await setMetadata(CACHE_KEY, $state.snapshot(collections));
    } catch (e) {
      console.error('[shelf] Failed to cache collections:', e);
    }
  }

  /**
   * Load collections: the cached copy first, then the server's. Once per
   * account per session unless `force`; a guest has none.
   */
  async function load(force = false) {
    const did = auth.user?.did ?? null;
    if (!did || auth.isGuest) {
      collections = [];
      loadedFor = null;
      return;
    }
    if (loadedFor === did && !force) return;
    // One load at a time, and `loading` from the first await: the cached and
    // fresh lists replace `collections` whole, so a collection created while a
    // load is in flight would vanish (the picker holds its create until done).
    if (inflight && !force) return inflight;
    loading = true;
    const token = {};
    loadToken = token;
    const run = (async () => {
      await Promise.resolve();
      try {
        if (loadedFor !== did) {
          const cached = await getMetadata<ShelfCollection[]>(CACHE_KEY).catch(() => null);
          if (loadToken !== token) return;
          collections = Array.isArray(cached) ? sortCollections(cached) : [];
        }
        if (!syncStore.isOnline) {
          loadedFor = did;
          return;
        }
        const { collections: fresh } = await api.getShelfCollections();
        // A forced reload that started since has the newer list.
        if (loadToken !== token) return;
        collections = sortCollections(fresh);
        loadedFor = did;
        await persist();
      } catch (e) {
        console.error('[shelf] Failed to load collections:', e);
      } finally {
        if (loadToken === token) {
          inflight = null;
          loading = false;
        }
      }
    })();
    inflight = run;
    return run;
  }

  /**
   * Apply a change optimistically, send it, and roll back (with a toast) if the
   * server refuses. Returns whether it landed.
   */
  async function mutate(
    apply: () => void,
    send: () => Promise<unknown>,
    failure: string
  ): Promise<boolean> {
    if (!canWrite()) {
      const id = toastStore.add(failure);
      toastStore.update(
        id,
        'error',
        auth.isGuest ? 'Collections need an account' : 'Collections need a connection'
      );
      return false;
    }
    const before = $state.snapshot(collections) as ShelfCollection[];
    apply();
    try {
      await send();
      await persist();
      return true;
    } catch (e) {
      console.error(`[shelf] ${failure}:`, e);
      collections = before;
      const id = toastStore.add(failure);
      toastStore.update(id, 'error', e instanceof Error && e.message ? e.message : failure);
      return false;
    }
  }

  function find(id: string): ShelfCollection | undefined {
    return collections.find((c) => c.id === id);
  }

  async function create(name: string, description: string | null = null) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const id = generateTid();
    const now = Math.floor(Date.now() / 1000);
    const position = collections.reduce((max, c) => Math.max(max, c.position), -1) + 1;
    const ok = await mutate(
      () => {
        collections = [
          ...collections,
          {
            id,
            name: trimmed,
            description: description?.trim() || null,
            position,
            createdAt: now,
            updatedAt: now,
            items: [],
          },
        ];
      },
      () => api.createShelfCollection({ id, name: trimmed, description }),
      "Couldn't create the collection"
    );
    return ok ? id : null;
  }

  async function update(id: string, data: { name?: string; description?: string | null }) {
    const name = data.name?.trim();
    if (data.name !== undefined && !name) return false;
    return mutate(
      () => {
        const c = find(id);
        if (!c) return;
        if (name !== undefined) c.name = name;
        if (data.description !== undefined) c.description = data.description?.trim() || null;
      },
      () =>
        api.updateShelfCollection(id, {
          ...(name !== undefined ? { name } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
        }),
      "Couldn't update the collection"
    );
  }

  async function remove(id: string) {
    return mutate(
      () => {
        collections = collections.filter((c) => c.id !== id);
      },
      () => api.deleteShelfCollection(id),
      "Couldn't delete the collection"
    );
  }

  async function addItem(id: string, save: SavedItem) {
    if (find(id)?.items.some((i) => i.rkey === save.rkey)) return true;
    return mutate(
      () => {
        find(id)?.items.push({ rkey: save.rkey, addedAt: Math.floor(Date.now() / 1000) });
      },
      () => api.addToShelfCollection(id, save.rkey),
      "Couldn't add to the collection"
    );
  }

  /** Room left in a collection before the cap. */
  function roomIn(id: string): number {
    return Math.max(0, MAX_COLLECTION_ITEMS - (find(id)?.items.length ?? 0));
  }

  /**
   * File several saves in a collection at once, in the order given; ones already
   * in it keep their place. All or nothing at the cap, like the server: a reader
   * told "room for 120 more" can narrow the selection, where a partial add would
   * leave them guessing which saves made it.
   */
  async function addItems(id: string, saves: SavedItem[]) {
    const c = find(id);
    if (!c) return false;
    const members = new Set(c.items.map((i) => i.rkey));
    const fresh = [...new Map(saves.map((s) => [s.rkey, s])).values()].filter(
      (s) => !members.has(s.rkey)
    );
    if (fresh.length === 0) return true;
    const room = roomIn(id);
    if (fresh.length > room) {
      const toast = toastStore.add("Couldn't add to the collection");
      toastStore.update(
        toast,
        'error',
        room === 0
          ? `“${c.name}” is full (${MAX_COLLECTION_ITEMS.toLocaleString()} items)`
          : `“${c.name}” has room for ${room.toLocaleString()} more`
      );
      return false;
    }
    const rkeys = fresh.map((s) => s.rkey);
    return mutate(
      () => {
        const now = Math.floor(Date.now() / 1000);
        find(id)?.items.push(...rkeys.map((rkey) => ({ rkey, addedAt: now })));
      },
      () => api.addManyToShelfCollection(id, rkeys),
      "Couldn't add to the collection"
    );
  }

  /** Take several saves out of a collection at once. */
  async function removeItems(id: string, rkeys: string[]) {
    const c = find(id);
    if (!c) return false;
    const drop = new Set(rkeys);
    const members = c.items.filter((i) => drop.has(i.rkey)).map((i) => i.rkey);
    if (members.length === 0) return true;
    return mutate(
      () => {
        const target = find(id);
        if (target) target.items = target.items.filter((i) => !drop.has(i.rkey));
      },
      () => api.removeManyFromShelfCollection(id, members),
      "Couldn't remove from the collection"
    );
  }

  async function removeItem(id: string, rkey: string) {
    return mutate(
      () => {
        const c = find(id);
        if (c) c.items = c.items.filter((i) => i.rkey !== rkey);
      },
      () => api.removeFromShelfCollection(id, rkey),
      "Couldn't remove from the collection"
    );
  }

  /**
   * Forget deleted saves' places in every collection, locally: the server drops
   * them itself when a save is deleted (removeSavedFromCollections), so this
   * only keeps the counts here honest until the next load.
   */
  function forgetSaves(rkeys: string[]) {
    const gone = new Set(rkeys);
    let changed = false;
    for (const c of collections) {
      if (c.items.some((i) => gone.has(i.rkey))) {
        c.items = c.items.filter((i) => !gone.has(i.rkey));
        changed = true;
      }
    }
    if (changed) void persist();
  }

  /** Move a member one place up (-1) or down (+1). */
  async function moveItem(id: string, rkey: string, delta: -1 | 1) {
    const c = find(id);
    if (!c) return false;
    const from = c.items.findIndex((i) => i.rkey === rkey);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= c.items.length) return false;
    const order = c.items.map((i) => i.rkey);
    [order[from], order[to]] = [order[to], order[from]];
    return mutate(
      () => {
        const target = find(id);
        if (!target) return;
        const byRkey = new Map(target.items.map((i) => [i.rkey, i]));
        target.items = order.map((r) => byRkey.get(r)!).filter(Boolean);
      },
      () => api.reorderShelfCollection(id, order),
      "Couldn't reorder the collection"
    );
  }

  /** Put the collections in a new order (their ids, top first). */
  async function reorderCollections(order: string[]) {
    const index = new Map(order.map((id, i) => [id, i]));
    return mutate(
      () => {
        collections = sortCollections(
          collections.map((c) => ({ ...c, position: index.get(c.id) ?? order.length + c.position }))
        );
      },
      // One at a time, so two quick moves can't land out of order.
      () => (orderSend = orderSend.catch(() => {}).then(() => api.reorderShelfCollections(order))),
      "Couldn't reorder your collections"
    );
  }

  // --- Shelf membership ---

  function collectionIdsFor(save: Pick<SavedItem, 'rkey'>): string[] {
    return membership.get(save.rkey) ?? [];
  }

  /** The explicit kept state, falling back to the save's kind. */
  function isKept(save: SavedItem): boolean {
    const explicit = itemLabelsStore.getKeptState(savedItemLabelKeys(save));
    return explicit ?? isReferenceKind(save);
  }

  function isOnShelf(save: SavedItem): boolean {
    return isKept(save) || collectionIdsFor(save).length > 0;
  }

  /**
   * Put a save on the Shelf, or take it off — which also takes it out of its
   * collections, since a collection member is on the Shelf by definition.
   */
  async function setOnShelf(save: SavedItem, on: boolean) {
    const keys = savedItemLabelKeys(save);
    if (on) {
      await itemLabelsStore.setKeptState(keys, true);
      return;
    }
    // Off: clear back to the default when that already means "off", else say so.
    await itemLabelsStore.setKeptState(keys, isReferenceKind(save) ? false : null);
    for (const id of collectionIdsFor(save)) {
      await removeItem(id, save.rkey);
    }
  }

  /** Every save on the Shelf, in the saves store's order. */
  let items = $derived(savesStore.articles.filter((save) => isOnShelf(save)));

  let savesByRkey = $derived(new Map(savesStore.articles.map((save) => [save.rkey, save])));

  /** A collection's members that resolve to a local save, in collection order. */
  function itemsIn(id: string): SavedItem[] {
    const c = find(id);
    if (!c) return [];
    const out: SavedItem[] = [];
    for (const member of c.items) {
      const save = savesByRkey.get(member.rkey);
      if (save) out.push(save);
    }
    return out;
  }

  return {
    get collections() {
      return collections;
    },
    get loading() {
      return loading;
    },
    get items() {
      return items;
    },
    get canWrite() {
      return canWrite();
    },
    get pickerSaves() {
      return pickerSaves;
    },
    /** Open the collection picker for one save, or several (a Library selection). */
    openPicker(saves: SavedItem | SavedItem[]) {
      const list = Array.isArray(saves) ? saves : [saves];
      if (list.length === 0) return;
      pickerSaves = list;
      void load();
    },
    closePicker() {
      pickerSaves = null;
    },
    load,
    find,
    create,
    update,
    remove,
    addItem,
    addItems,
    removeItem,
    removeItems,
    roomIn,
    forgetSaves,
    moveItem,
    reorderCollections,
    collectionIdsFor,
    isKept,
    isOnShelf,
    setOnShelf,
    itemsIn,
  };
}

export const shelfStore = createShelfStore();
