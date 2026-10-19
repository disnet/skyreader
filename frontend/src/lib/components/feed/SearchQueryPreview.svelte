<script lang="ts">
  // The channel editor's live preview of a saved search: what the query finds
  // among its sources' recent items, read or not, matched by the same
  // tokenizer the channel uses. Offered only where saved searches are.
  import { api, type SavedSearchPreview } from '$lib/services/api';
  import { auth } from '$lib/stores/auth.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { canUseSavedSearches } from '$lib/utils/searchChannels';
  import { decodeEntities } from '$lib/utils/entities';
  import { domainFromUrl } from '$lib/utils/highlightSource';

  interface Props {
    query: string;
    sourceMode: 'all' | 'include' | 'exclude';
    sourceKeys: string[];
  }

  let { query, sourceMode, sourceKeys }: Props = $props();

  const DEBOUNCE_MS = 400;

  let preview = $state<SavedSearchPreview | null>(null);
  let phase = $state<'idle' | 'loading' | 'done' | 'failed'>('idle');

  // A string, so an equal selection rebuilt as a new array doesn't refetch.
  let keysKey = $derived(JSON.stringify(sourceKeys));

  let available = $derived(canUseSavedSearches(auth.user) && syncStore.isOnline);

  let scannedLabel = $derived.by(() => {
    if (!preview) return '';
    const n = preview.scanned.toLocaleString();
    return preview.capped
      ? `the last ${n} items`
      : `${n} ${preview.scanned === 1 ? 'item' : 'items'}`;
  });

  $effect(() => {
    const params = { query, sourceMode, sourceKeys: JSON.parse(keysKey) as string[] };
    if (!available) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      phase = 'loading';
      try {
        preview = await api.previewSavedSearch(params, controller.signal);
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
    {#if phase === 'done' && preview && preview.scanned === 0}
      <p class="preview-head">Nothing has come in from these sources this past month.</p>
    {:else if phase === 'done' && preview && preview.total === 0}
      <p class="preview-head">None of {scannedLabel} from these sources match yet.</p>
    {:else if phase === 'done' && preview}
      <p class="preview-head">
        {preview.total.toLocaleString()} of {scannedLabel} from these sources match:
      </p>
      <ul>
        {#each preview.hits as hit (hit.itemKey)}
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
      <p class="preview-head">Looking through recent items from these sources…</p>
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
