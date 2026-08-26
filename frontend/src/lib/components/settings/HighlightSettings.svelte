<script lang="ts">
  // Highlight preferences: how big a review deck is, and whether Skyreader
  // pulls the reader's own Margin highlights in.
  //
  // The Margin toggle is gated on the margin scopes even though the read itself
  // is public XRPC: without them, editing an imported highlight's note would
  // queue a PDS write the session can't perform. Same posture as
  // SaveBackingPicker — disabled plus a re-auth prompt, never a broken half-state.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { api } from '$lib/services/api';
  import { syncStore } from '$lib/stores/sync.svelte';
  import {
    HIGHLIGHT_REVIEW_COUNT_OPTIONS,
    preferences,
    type HighlightReviewCount,
  } from '$lib/stores/preferences.svelte';
  import { maybeImportMarginHighlights } from '$lib/services/marginHighlightImport';

  interface Props {
    returnUrl?: string;
    /** Fired when switching the toggle on actually brought highlights in, so a
        host showing those highlights (the review deck) can react. */
    onImported?: (imported: number) => void;
  }

  let { returnUrl = '/settings', onImported }: Props = $props();

  let loaded = $state(false);
  let hasMarginScopes = $state(false);
  let importing = $state(false);
  let importNote = $state<string | null>(null);

  onMount(async () => {
    if (!syncStore.isOnline) {
      loaded = true;
      return;
    }
    try {
      const status = await api.getIntegrationStatus();
      hasMarginScopes = status.scopeStatus.margin;
    } catch (error) {
      console.error('Failed to load integration status:', error);
    }
    loaded = true;
  });

  async function reauthForScopes() {
    await auth.logout();
    goto(`/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`);
  }

  async function toggleImport(enabled: boolean) {
    preferences.setMarginHighlightImport(enabled);
    importNote = null;
    if (!enabled) return;
    // Turning it on should do something visible right away, not in 15 minutes.
    importing = true;
    try {
      const result = await maybeImportMarginHighlights({ force: true });
      if (!result) importNote = 'Couldn’t reach Margin just now. Skyreader will try again later.';
      else if (result.truncated) {
        importNote = `Brought in ${result.imported}. Some highlights couldn’t be fetched yet.`;
      } else if (result.imported === 0) {
        importNote = 'Nothing new to bring in.';
      } else {
        importNote = `Brought in ${result.imported} highlight${result.imported === 1 ? '' : 's'}.`;
      }
      if (result && result.imported > 0) onImported?.(result.imported);
    } finally {
      importing = false;
    }
  }
</script>

<div class="setting-row">
  <label for="review-count">Review deck</label>
  <select
    id="review-count"
    value={preferences.highlightReviewCount}
    onchange={(e) =>
      preferences.setHighlightReviewCount(Number(e.currentTarget.value) as HighlightReviewCount)}
  >
    {#each HIGHLIGHT_REVIEW_COUNT_OPTIONS as option}
      <option value={option}>{option} highlights</option>
    {/each}
  </select>
</div>
<p class="setting-description">
  How many highlights a review session brings back. Least recently revisited first.
</p>

{#if loaded}
  <label class="toggle-setting">
    <input
      type="checkbox"
      checked={preferences.marginHighlightImport}
      disabled={!hasMarginScopes || importing}
      onchange={(e) => toggleImport(e.currentTarget.checked)}
    />
    <span>Bring in highlights from Margin</span>
  </label>
  <p class="setting-description">
    Highlights you've made in Margin join your review deck here. They stay private on Skyreader —
    the notes they came from stay public on your PDS.
  </p>
  {#if !hasMarginScopes}
    <p class="setting-description">
      This needs permission to read and write your Margin notes.
      <button class="link-btn" onclick={reauthForScopes} type="button">
        Log in again to grant access
      </button>
    </p>
  {/if}
  {#if importing}
    <p class="setting-description">Looking for highlights…</p>
  {:else if importNote}
    <p class="setting-description">{importNote}</p>
  {/if}
{/if}

<style>
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .setting-row label {
    font-weight: var(--weight-medium);
  }

  select {
    min-height: 2.25rem;
    padding: 0.35rem 1.8rem 0.35rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
  }

  .toggle-setting {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1rem;
    cursor: pointer;
  }

  .toggle-setting input:disabled {
    cursor: default;
  }

  .setting-description {
    margin: 0.5rem 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: var(--leading-relaxed, 1.5);
  }

  .link-btn {
    padding: 0;
    background: none;
    border: none;
    color: var(--color-primary);
    font: inherit;
    font-weight: var(--weight-medium);
    cursor: pointer;
    text-decoration: underline;
  }
</style>
