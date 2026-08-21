<script lang="ts">
  // Unfinished share drafts, surfaced at the top of your linkblog page so a
  // half-written share can be found and finished from one place. Drafts are
  // local to this device; a row opens the composer with the draft restored.
  import Icon from '$lib/components/Icon.svelte';
  import { shareDraftsStore } from '$lib/stores/shareDrafts.svelte';
  import { shareComposerStore } from '$lib/stores/shareComposer.svelte';
  import { formatRelativeDate } from '$lib/utils/date';
  import type { ShareDraft } from '$lib/types';

  let drafts = $derived(shareDraftsStore.list);

  function snippet(draft: ShareDraft): string {
    const first = draft.blocks.find((b) => b.text.trim());
    return first ? first.text.trim() : '';
  }

  function quoteCount(draft: ShareDraft): number {
    return draft.blocks.filter((b) => b.kind === 'quote' && b.text.trim()).length;
  }

  // Deleting a draft is local-only but still someone's words — two-step confirm.
  let confirmingDelete = $state<string | null>(null);
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;

  function handleDelete(articleUrl: string) {
    if (confirmingDelete === articleUrl) {
      clearTimeout(confirmTimer);
      confirmingDelete = null;
      void shareDraftsStore.remove(articleUrl);
    } else {
      clearTimeout(confirmTimer);
      confirmingDelete = articleUrl;
      confirmTimer = setTimeout(() => (confirmingDelete = null), 3000);
    }
  }
</script>

{#if drafts.length > 0}
  <section class="drafts" aria-label="Share drafts">
    <h2 class="drafts-head">Drafts</h2>
    <ul class="drafts-list">
      {#each drafts as draft (draft.articleUrl)}
        <li class="draft-row">
          <button
            type="button"
            class="draft-main"
            onclick={() => shareComposerStore.openDraft(draft)}
            title="Resume this draft"
          >
            <span class="draft-title">{draft.articleTitle ?? draft.articleUrl}</span>
            {#if snippet(draft)}
              <span class="draft-snippet">{snippet(draft)}</span>
            {/if}
            <span class="draft-meta">
              {#if quoteCount(draft) > 0}
                {quoteCount(draft)}
                {quoteCount(draft) === 1 ? 'quote' : 'quotes'} ·
              {/if}
              {formatRelativeDate(new Date(draft.updatedAt).toISOString())}
            </span>
          </button>
          <button
            type="button"
            class="draft-delete"
            class:confirming={confirmingDelete === draft.articleUrl}
            onclick={() => handleDelete(draft.articleUrl)}
            aria-label={confirmingDelete === draft.articleUrl
              ? 'Confirm delete draft'
              : 'Delete draft'}
            title={confirmingDelete === draft.articleUrl ? 'Tap again to delete' : 'Delete draft'}
          >
            <Icon name="trash" size={15} />
            {#if confirmingDelete === draft.articleUrl}<span class="draft-delete-label"
                >Delete?</span
              >{/if}
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .drafts {
    margin: 0 0 1.5rem;
  }

  .drafts-head {
    margin: 0 0 0.375rem;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  .drafts-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  /* Rows, not cards: rhythm and a hover tint, matching the feed's own grammar. */
  .draft-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .draft-main {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.5rem 0.625rem;
    background: none;
    border: none;
    border-radius: 8px;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .draft-main:hover {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .draft-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-base);
    color: var(--color-text);
  }

  .draft-snippet {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: var(--text-md);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
  }

  .draft-meta {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .draft-delete {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4375rem;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      color 0.15s,
      background-color 0.15s;
  }

  .draft-delete:hover,
  .draft-delete.confirming {
    color: var(--color-error, #f44336);
  }

  .draft-delete-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
</style>
