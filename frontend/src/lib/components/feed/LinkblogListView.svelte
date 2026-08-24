<script lang="ts">
  // Your own linkblog, as a page of posts rather than a river of things to read.
  //
  // One chronological stream: unposted local drafts sit alongside the published
  // entries they will become, in the same entry shape, so there is no second
  // design for "not finished yet". Drafts sync across the user's devices but
  // carry no server pagination of their own — the store holds the whole set —
  // so they are merged into this list client-side by their own edit time.
  import LinkblogEntry from './LinkblogEntry.svelte';
  import SavedReader from './SavedReader.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import { feedViewStore, type FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import { shareDraftsStore } from '$lib/stores/shareDrafts.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { useReaderStack } from '$lib/hooks/useReaderStack.svelte';
  import { getDocumentEffectiveUrl } from '$lib/utils/linkPost';
  import type { ShareDraft } from '$lib/types';

  interface Props {
    onReaderChange?: (open: boolean) => void;
  }

  let { onReaderChange }: Props = $props();

  const reader = useReaderStack({ onReaderChange: (open) => onReaderChange?.(open) });
  let readerItem = $derived(reader.readerItem);

  type Row =
    | { kind: 'draft'; key: string; at: number; draft: ShareDraft }
    | { kind: 'post'; key: string; at: number; item: FeedDisplayItem };

  // Published entries arrive already filtered, sorted and paginated by the feed
  // view. Drafts are not spliced into that order: they are unfinished work with
  // somewhere still to go, so they are pinned above the stream where you'll see
  // them, rather than sinking under whatever you posted since. A draft for a URL
  // that has since been posted would read as a duplicate, so the post wins.
  let rows = $derived.by((): Row[] => {
    const posts: Row[] = feedViewStore.currentItems
      .filter((i) => i.type === 'document')
      .map((item) => ({
        kind: 'post' as const,
        key: item.key,
        at: new Date(item.item.publishedAt).getTime() || 0,
        item,
      }));

    const postedUrls = new Set(
      feedViewStore.currentItems
        .filter((i) => i.type === 'document')
        .map((i) => getDocumentEffectiveUrl(i.item))
        .filter(Boolean)
    );

    // Ordered by when the draft was STARTED, not last touched: autosave stamps
    // `updatedAt` on every keystroke, and sorting on that would slide the entry
    // you are typing in up the page out from under the cursor. The entry still
    // reports its edit time in its own meta row.
    const drafts: Row[] = shareDraftsStore.list
      .filter((d) => !postedUrls.has(d.articleUrl))
      .map((draft) => ({
        kind: 'draft' as const,
        key: `draft:${draft.articleUrl}`,
        at: draft.createdAt,
        draft,
      }));

    // Drafts keep the page's sort among themselves; posts keep the order the
    // feed view already put them in. The two groups never interleave.
    const newestFirst = feedViewStore.currentSortOrder === 'newest';
    drafts.sort((a, b) => (newestFirst ? b.at - a.at : a.at - b.at));
    posts.sort((a, b) => (newestFirst ? b.at - a.at : a.at - b.at));
    return [...drafts, ...posts];
  });

  function handleReaderSave() {
    if (!readerItem || readerItem.type !== 'document') return;
    const doc = readerItem.item;
    itemLabelsStore.toggleSave(doc.recordUri, 'document', getDocumentEffectiveUrl(doc), doc.title, {
      type: 'document',
      recordUri: doc.recordUri,
      url: getDocumentEffectiveUrl(doc),
      title: doc.title,
      description: doc.description,
      publishedAt: doc.publishedAt,
    });
  }
</script>

{#if readerItem}
  <SavedReader {readerItem} onClose={reader.closeReader} onToggleSave={handleReaderSave} />
{/if}

<div class="linkblog-list" class:hidden-behind-reader={readerItem !== null}>
  {#each rows as row (row.key)}
    {#if row.kind === 'draft'}
      <LinkblogEntry draft={row.draft} />
    {:else if row.item.type === 'document'}
      <LinkblogEntry doc={row.item.item} onOpenReader={() => reader.openReader(row.item)} />
    {/if}
  {/each}

  <InfiniteScrollSentinel
    hasMore={feedViewStore.hasMore}
    isLoading={feedViewStore.isLoadingMore}
    onLoadMore={() => feedViewStore.loadMore()}
  />
</div>

<style>
  .linkblog-list {
    display: flex;
    flex-direction: column;
  }

  .hidden-behind-reader {
    visibility: hidden;
    position: fixed;
    pointer-events: none;
  }
</style>
