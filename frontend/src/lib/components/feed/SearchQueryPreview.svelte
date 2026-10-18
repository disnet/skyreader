<script lang="ts">
  // The channel editor's live preview of a saved search: what the query finds
  // among things you've already read, through the same search the overlay
  // uses. Saved searches and search share a tokenizer, so this is a fair
  // picture of what the channel will catch. Offered only where search is.
  import { api, type SearchHit } from '$lib/services/api';
  import { auth } from '$lib/stores/auth.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { canUseSearch } from '$lib/utils/search';
  import { decodeEntities } from '$lib/utils/entities';
  import { domainFromUrl } from '$lib/utils/highlightSource';

  interface Props {
    query: string;
  }

  let { query }: Props = $props();

  const DEBOUNCE_MS = 400;
  const SHOWN = 3;

  let hits = $state<SearchHit[]>([]);
  let total = $state(0);
  let totalCapped = $state(false);
  let phase = $state<'idle' | 'loading' | 'done' | 'failed'>('idle');

  let countLabel = $derived(
    `${total.toLocaleString()}${totalCapped ? '+' : ''} ${total === 1 && !totalCapped ? 'item' : 'items'}`
  );

  let available = $derived(canUseSearch(auth.user) && syncStore.isOnline);

  $effect(() => {
    const q = query;
    if (!available) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      phase = 'loading';
      try {
        const res = await api.search({
          q,
          kinds: ['read'],
          limit: SHOWN,
          signal: controller.signal,
        });
        hits = res.results;
        total = res.total;
        totalCapped = res.totalCapped;
        phase = 'done';
      } catch {
        if (!controller.signal.aborted) phase = 'failed';
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });
</script>

{#if available && phase !== 'idle' && phase !== 'failed'}
  <div class="preview" aria-live="polite" class:loading={phase === 'loading'}>
    {#if phase === 'done' && total === 0}
      <p class="preview-head">Nothing you've read matches this yet.</p>
    {:else if phase === 'done'}
      <p class="preview-head">
        {countLabel} you've read would have matched:
      </p>
      <ul>
        {#each hits as hit (hit.itemKey)}
          <li>
            <span class="hit-title"
              >{decodeEntities(hit.title) || domainFromUrl(hit.url) || 'Untitled'}</span
            >
            <span class="hit-snippet"
              >{#each hit.snippet as seg, i (i)}{#if seg.match}<mark>{seg.text}</mark
                  >{:else}{seg.text}{/if}{/each}</span
            >
          </li>
        {/each}
      </ul>
    {:else}
      <p class="preview-head">Looking through what you've read…</p>
    {/if}
  </div>
{/if}

<style>
  .preview {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    transition: opacity 0.15s;
  }

  .preview.loading {
    opacity: 0.6;
  }

  .preview-head {
    margin: 0;
  }

  ul {
    margin: 0.375rem 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  li {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .hit-title {
    color: var(--color-text);
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hit-snippet {
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Search's match yellow: a match, not a mark the reader made. */
  .hit-snippet mark {
    background-color: color-mix(in srgb, #f5c518 22%, transparent);
    color: var(--color-text);
    border-radius: 1px;
  }
</style>
