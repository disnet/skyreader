import { db } from '$lib/services/db';
import type { ItemTags } from '$lib/types';

function createTagsStore() {
  let tagsByItem = $state<Map<string, ItemTags>>(new Map());

  let allTags = $derived.by((): string[] => {
    const tagSet = new Set<string>();
    for (const entry of tagsByItem.values()) {
      if (!Array.isArray(entry.tags)) continue;
      for (const tag of entry.tags) {
        tagSet.add(tag);
      }
    }
    return [...tagSet].sort();
  });

  async function load() {
    const all = await db.itemTags.toArray();
    const map = new Map<string, ItemTags>();
    for (const entry of all) {
      if (!Array.isArray(entry.tags)) {
        entry.tags = [];
      }
      map.set(entry.itemKey, entry);
    }
    tagsByItem = map;
  }

  function getTagsForItem(itemKey: string): string[] {
    return tagsByItem.get(itemKey)?.tags ?? [];
  }

  function hasTag(itemKey: string, tag: string): boolean {
    return getTagsForItem(itemKey).includes(tag);
  }

  async function addTag(itemKey: string, itemType: ItemTags['itemType'], tag: string) {
    const trimmed = tag.trim().slice(0, 64);
    if (!trimmed) return;

    const existing = tagsByItem.get(itemKey);
    if (existing) {
      if (existing.tags.includes(trimmed)) return;
      if (existing.tags.length >= 10) return;
      const newTags = [...existing.tags, trimmed];
      const updated = { ...existing, tags: newTags };
      tagsByItem = new Map(tagsByItem).set(itemKey, updated);
      await db.itemTags.put(updated);
    } else {
      const entry: ItemTags = { itemKey, itemType, tags: [trimmed] };
      tagsByItem = new Map(tagsByItem).set(itemKey, entry);
      await db.itemTags.put(entry);
    }
  }

  async function removeTag(itemKey: string, tag: string) {
    const existing = tagsByItem.get(itemKey);
    if (!existing) return;

    const newTags = existing.tags.filter((t) => t !== tag);
    if (newTags.length === 0) {
      const updated = new Map(tagsByItem);
      updated.delete(itemKey);
      tagsByItem = updated;
      await db.itemTags.delete(itemKey);
    } else {
      const updated = { ...existing, tags: newTags };
      tagsByItem = new Map(tagsByItem).set(itemKey, updated);
      await db.itemTags.put(updated);
    }
  }

  async function toggleTag(itemKey: string, itemType: ItemTags['itemType'], tag: string) {
    if (hasTag(itemKey, tag)) {
      await removeTag(itemKey, tag);
    } else {
      await addTag(itemKey, itemType, tag);
    }
  }

  async function deleteTag(tag: string) {
    const updated = new Map<string, ItemTags>();
    const toUpdate: ItemTags[] = [];
    const toDelete: string[] = [];

    for (const [key, entry] of tagsByItem) {
      if (entry.tags.includes(tag)) {
        const newTags = entry.tags.filter((t) => t !== tag);
        if (newTags.length === 0) {
          toDelete.push(key);
        } else {
          const newEntry = { ...entry, tags: newTags };
          updated.set(key, newEntry);
          toUpdate.push(newEntry);
        }
      } else {
        updated.set(key, entry);
      }
    }

    tagsByItem = updated;
    await Promise.all([
      ...toUpdate.map((e) => db.itemTags.put(e)),
      ...toDelete.map((k) => db.itemTags.delete(k)),
    ]);
  }

  function itemHasAnyTag(itemKey: string, tags: string[]): boolean {
    const itemTags = getTagsForItem(itemKey);
    return tags.some((t) => itemTags.includes(t));
  }

  return {
    get allTags() {
      return allTags;
    },
    get tagsByItem() {
      return tagsByItem;
    },
    load,
    getTagsForItem,
    hasTag,
    addTag,
    removeTag,
    toggleTag,
    deleteTag,
    itemHasAnyTag,
  };
}

export const tagsStore = createTagsStore();
