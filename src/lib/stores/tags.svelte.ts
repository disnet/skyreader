import { db } from '$lib/services/db';
import type { ItemType, ItemTag } from '$lib/types';

const MAX_TAGS_PER_ITEM = 10;
const MAX_TAG_LENGTH = 64;

function createTagsStore() {
  // All tags for all items, keyed by "itemType:itemKey"
  let tagsByItem = $state<Map<string, string[]>>(new Map());
  // All unique tags in use
  let allTags = $state<string[]>([]);

  function itemKey(itemType: ItemType, key: string): string {
    return `${itemType}:${key}`;
  }

  async function load() {
    const all = await db.itemTags.toArray();
    const map = new Map<string, string[]>();
    const tagSet = new Set<string>();
    for (const entry of all) {
      const k = itemKey(entry.itemType, entry.itemKey);
      const existing = map.get(k) || [];
      existing.push(entry.tag);
      map.set(k, existing);
      tagSet.add(entry.tag);
    }
    tagsByItem = map;
    allTags = Array.from(tagSet).sort();
  }

  function getTagsForItem(itemType: ItemType, key: string): string[] {
    return tagsByItem.get(itemKey(itemType, key)) || [];
  }

  async function addTag(itemType: ItemType, key: string, tag: string): Promise<boolean> {
    const trimmed = tag.trim().slice(0, MAX_TAG_LENGTH);
    if (!trimmed) return false;

    const k = itemKey(itemType, key);
    const existing = tagsByItem.get(k) || [];
    if (existing.length >= MAX_TAGS_PER_ITEM) return false;
    if (existing.includes(trimmed)) return false;

    await db.itemTags.add({ itemType, itemKey: key, tag: trimmed });

    // Update in-memory state
    const updated = [...existing, trimmed];
    tagsByItem = new Map(tagsByItem).set(k, updated);
    if (!allTags.includes(trimmed)) {
      allTags = [...allTags, trimmed].sort();
    }
    return true;
  }

  async function removeTag(itemType: ItemType, key: string, tag: string) {
    await db.itemTags
      .where('[itemType+itemKey]')
      .equals([itemType, key])
      .filter((entry) => entry.tag === tag)
      .delete();

    const k = itemKey(itemType, key);
    const existing = tagsByItem.get(k) || [];
    const updated = existing.filter((t) => t !== tag);
    const newMap = new Map(tagsByItem);
    if (updated.length === 0) {
      newMap.delete(k);
    } else {
      newMap.set(k, updated);
    }
    tagsByItem = newMap;

    // Recompute allTags if tag is no longer used anywhere
    const stillUsed = Array.from(tagsByItem.values()).some((tags) => tags.includes(tag));
    if (!stillUsed) {
      allTags = allTags.filter((t) => t !== tag);
    }
  }

  // Check if an item has a specific tag
  function hasTag(itemType: ItemType, key: string, tag: string): boolean {
    const tags = tagsByItem.get(itemKey(itemType, key));
    return tags ? tags.includes(tag) : false;
  }

  // Check if an item has any of the given tags
  function hasAnyTag(itemType: ItemType, key: string, tags: string[]): boolean {
    const itemTags = tagsByItem.get(itemKey(itemType, key));
    if (!itemTags) return false;
    return tags.some((t) => itemTags.includes(t));
  }

  return {
    get allTags() {
      return allTags;
    },
    load,
    getTagsForItem,
    addTag,
    removeTag,
    hasTag,
    hasAnyTag,
  };
}

export const tagsStore = createTagsStore();
