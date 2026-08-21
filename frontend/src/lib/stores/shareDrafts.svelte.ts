// Local share drafts (device-only). A draft is the unposted state of a linkblog
// share, keyed by the external article URL — the same key the linkblog dedups
// on. Drafts live in IndexedDB only: nothing leaves the device until the user
// posts, which is the whole point of drafting a public share.

import { db } from '$lib/services/db';
import { draftHasContent } from '$lib/utils/shareNote';
import type { ShareDraft } from '$lib/types';

function toPlain(draft: ShareDraft): ShareDraft {
  // $state proxies can't cross into IndexedDB — copy to plain objects.
  return { ...draft, blocks: draft.blocks.map((b) => ({ ...b })) };
}

function createShareDraftsStore() {
  let drafts = $state<Map<string, ShareDraft>>(new Map());
  let hasLoaded = false;

  const list = $derived(
    [...drafts.values()]
      .filter((d) => draftHasContent(d.blocks))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  );

  async function load() {
    if (hasLoaded) return;
    hasLoaded = true;
    try {
      const rows = await db.shareDrafts.toArray();
      drafts = new Map(rows.map((d) => [d.articleUrl, d]));
    } catch (e) {
      console.error('Failed to load share drafts:', e);
    }
  }

  function get(articleUrl: string): ShareDraft | undefined {
    return drafts.get(articleUrl);
  }

  /** Whether a resumable draft (with real content) exists for this article. */
  function hasDraft(articleUrl: string): boolean {
    const draft = drafts.get(articleUrl);
    return Boolean(draft && draftHasContent(draft.blocks));
  }

  async function save(draft: ShareDraft) {
    const plain = toPlain(draft);
    drafts.set(plain.articleUrl, plain);
    drafts = new Map(drafts);
    try {
      await db.shareDrafts.put(plain);
    } catch (e) {
      console.error('Failed to persist share draft:', e);
    }
  }

  async function remove(articleUrl: string) {
    drafts.delete(articleUrl);
    drafts = new Map(drafts);
    try {
      await db.shareDrafts.delete(articleUrl);
    } catch (e) {
      console.error('Failed to delete share draft:', e);
    }
  }

  return {
    load,
    get,
    hasDraft,
    save,
    remove,
    get list() {
      return list;
    },
  };
}

export const shareDraftsStore = createShareDraftsStore();
