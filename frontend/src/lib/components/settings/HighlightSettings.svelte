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
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
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
    /**
     * Deck size only makes sense where the deck is: "5" means something when
     * you can see it. `/settings` renders the Margin toggle alone, because that
     * one has to be reachable *before* there's a deck to configure — a reader
     * with a Margin library and no Skyreader highlights has no Review entry in
     * the nav at all, so the deck's own gear can't be its only home.
     */
    showDeckSize?: boolean;
  }

  let { returnUrl = '/settings', onImported, showDeckSize = true }: Props = $props();

  let loaded = $state(false);
  // Three states, not two. Offline and a failed status call both leave the grant
  // unknown, and treating unknown as missing tells a reader who granted the
  // scopes months ago to log in again — while offline, where the re-auth button
  // logs them out and can't log them back in. It also locks the toggle, so they
  // can't even switch the import off.
  let marginScopes = $state<'unknown' | 'granted' | 'missing'>('unknown');
  let importing = $state(false);
  let importNote = $state<string | null>(null);

  onMount(async () => {
    if (!syncStore.isOnline) {
      loaded = true;
      return;
    }
    try {
      const status = await api.getIntegrationStatus();
      marginScopes = status.scopeStatus.margin ? 'granted' : 'missing';
    } catch (error) {
      console.error('Failed to load integration status:', error);
    }
    loaded = true;
  });

  async function reauthForScopes() {
    await auth.logout();
    goto(`/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`);
  }

  // Keeping the promise the toggle makes when it lands mid-hydration. The deck
  // and the list each have an effect that calls the import once their stores are
  // ready; the panel can be mounted on /settings, where nothing else will.
  let storesReady = $derived(!itemLabelsStore.isLoading && !savesStore.loading);
  let awaitingStores = $state(false);

  $effect(() => {
    if (!awaitingStores || !storesReady) return;
    awaitingStores = false;
    void toggleImport(true);
  });

  async function toggleImport(enabled: boolean) {
    preferences.setMarginHighlightImport(enabled);
    importNote = null;
    if (!enabled) {
      // Switching off has to cancel the deferred retry too. Without this, a
      // reader who turned it on mid-hydration and changed their mind before the
      // stores landed would watch the effect below switch it back on for them.
      awaitingStores = false;
      return;
    }
    // Turning it on should do something visible right away, not in 15 minutes.
    importing = true;
    try {
      const outcome = await maybeImportMarginHighlights({ force: true });
      if (outcome.status === 'imported') {
        if (outcome.truncated) {
          importNote = `Brought in ${outcome.imported}. Some highlights couldn’t be fetched yet.`;
        } else if (outcome.imported === 0) {
          importNote = 'Nothing new to bring in.';
        } else {
          importNote = `Brought in ${outcome.imported} highlight${
            outcome.imported === 1 ? '' : 's'
          }.`;
        }
        if (outcome.imported > 0) onImported?.(outcome.imported);
      } else if (outcome.status === 'scope-expired') {
        // The grant is gone and the import switched itself back off. Say that,
        // rather than blaming the network for a permissions problem — and let
        // the re-auth prompt below appear, which is the only way out of it.
        marginScopes = 'missing';
        importNote = null;
      } else if (outcome.status === 'skipped' && outcome.reason === 'stores-loading') {
        // The import is gated on the local highlights being read: it writes each
        // item's whole set, so running early would overwrite what it can't see.
        awaitingStores = true;
        importNote = 'Bringing them in as soon as your highlights finish loading.';
      } else if (outcome.status === 'skipped' && outcome.reason === 'offline') {
        importNote = 'Offline. Skyreader will bring them in once you’re back.';
      } else {
        importNote = 'Couldn’t reach Margin just now. Skyreader will try again later.';
      }
    } finally {
      importing = false;
    }
  }
</script>

{#if showDeckSize}
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
  <p class="setting-description">How many highlights a review session brings back.</p>
{/if}

{#if loaded}
  <label class="toggle-setting">
    <input
      type="checkbox"
      checked={preferences.marginHighlightImport}
      disabled={marginScopes === 'missing' || importing}
      onchange={(e) => toggleImport(e.currentTarget.checked)}
    />
    <span>Bring in highlights from Margin</span>
  </label>
  <p class="setting-description">Highlights you've made in Margin join your review deck here.</p>
  {#if marginScopes === 'missing'}
    <p class="setting-description">
      This needs permission to read and write your Margin notes.
      <button class="link-btn" onclick={reauthForScopes} type="button">
        Log in again to grant access
      </button>
    </p>
  {:else if marginScopes === 'unknown'}
    <p class="setting-description">
      Couldn't check your Margin permissions just now. The import will start once you're back
      online.
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
