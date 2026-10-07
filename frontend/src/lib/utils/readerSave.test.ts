import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SavedItem } from '$lib/types';

// A stand-in saves store: the real one drags in Dexie, the API client and the
// sync queue. What's under test is the identity logic on top of it — which key a
// save is looked up by, and which rkey an unsave targets.
const saves: SavedItem[] = [];

vi.mock('$lib/stores/saves.svelte', () => ({
  savesStore: {
    getByGuid: (guid: string) => saves.find((s) => s.itemGuid === guid),
    getByUrl: (url: string) => saves.find((s) => s.url === url),
    remove: vi.fn(async (rkey: string) => {
      const i = saves.findIndex((s) => s.rkey === rkey);
      if (i >= 0) saves.splice(i, 1);
    }),
    saveArticle: vi.fn(async (a: { url: string; guid: string; title?: string }) => {
      const item = save({ rkey: 'fresh-rkey', uri: '', url: a.url, itemGuid: a.guid });
      saves.push(item);
      return item;
    }),
    saveDocument: vi.fn(async (d: { recordUri: string; url: string; content?: string }) => {
      const item = save({
        rkey: 'fresh-rkey',
        uri: '',
        url: d.url,
        itemGuid: d.recordUri,
        source: 'document',
        content: d.content ?? null,
      });
      saves.push(item);
      return item;
    }),
    // Bodies are stripped from the in-memory copies; the full row lives in Dexie.
    getContent: vi.fn(async (rkey: string) => (rkey === '3kaaaaaaaaaaa' ? '<p>A body</p>' : null)),
  },
}));

const { savesStore } = await import('$lib/stores/saves.svelte');
const { isSavedItemSaved, toggleSavedItemSave } = await import('./readerSave');

function save(partial: Partial<SavedItem> = {}): SavedItem {
  return {
    rkey: '3kaaaaaaaaaaa',
    uri: 'at://did:plc:me/app.skyreader.feed.saved/3kaaaaaaaaaaa',
    url: 'https://example.com/piece',
    title: 'A Piece',
    author: null,
    description: null,
    content: null,
    contentType: 'article',
    domain: 'example.com',
    image: null,
    wordCount: null,
    publishedAt: null,
    savedAt: '2026-08-01T00:00:00.000Z',
    itemGuid: 'guid-1',
    ...partial,
  };
}

beforeEach(() => {
  saves.length = 0;
  vi.clearAllMocks();
});

describe('isSavedItemSaved', () => {
  it('reports a save as saved even though its display key is unindexed', () => {
    const item = save();
    saves.push(item);
    // The display key is the record uri — neither the guid nor the url map holds
    // it, which is why the reader can't ask about that key.
    expect(savesStore.getByGuid(item.uri)).toBeUndefined();
    expect(isSavedItemSaved(item)).toBe(true);
  });

  it('matches by url when the save carries no guid', () => {
    const item = save({ itemGuid: undefined });
    saves.push(item);
    expect(isSavedItemSaved(item)).toBe(true);
  });

  it('reports false once the save is gone', () => {
    expect(isSavedItemSaved(save())).toBe(false);
  });
});

describe('toggleSavedItemSave', () => {
  it('unsaves the save behind the reader item', async () => {
    const item = save();
    saves.push(item);
    await toggleSavedItemSave(item);
    expect(savesStore.remove).toHaveBeenCalledWith(item.rkey);
    expect(isSavedItemSaved(item)).toBe(false);
  });

  it('re-saves under the same guid, so the feed article lights up again', async () => {
    const item = save();
    await toggleSavedItemSave(item);
    expect(savesStore.saveArticle).toHaveBeenCalledWith(
      expect.objectContaining({ url: item.url, guid: 'guid-1', title: 'A Piece' })
    );
    expect(isSavedItemSaved(item)).toBe(true);
  });

  it('re-saves a document save as a document, body and all', async () => {
    const item = save({
      source: 'document',
      itemGuid: 'at://did:plc:me/site.doc/abc',
      content: null,
    });
    saves.push(item);

    await toggleSavedItemSave(item); // unsave — the body goes with the row
    await toggleSavedItemSave(item); // undo

    expect(savesStore.saveArticle).not.toHaveBeenCalled();
    expect(savesStore.saveDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        recordUri: 'at://did:plc:me/site.doc/abc',
        url: item.url,
        content: '<p>A body</p>',
      })
    );
  });

  it('targets the live rkey across a save → unsave → save → unsave round trip', async () => {
    const item = save();
    saves.push(item);

    await toggleSavedItemSave(item); // unsave
    await toggleSavedItemSave(item); // re-save, minting a new rkey
    await toggleSavedItemSave(item); // unsave again — the reader still holds the old rkey

    expect(savesStore.remove).toHaveBeenLastCalledWith('fresh-rkey');
    expect(saves).toHaveLength(0);
  });
});
