<script lang="ts">
  import { goto } from '$app/navigation';
  import Modal from '$lib/components/common/Modal.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { ScopeUpgradeError, UrlSaveLimitError } from '$lib/services/api';
  import LimitNotice from '$lib/components/LimitNotice.svelte';
  import { saveLimitLine } from '$lib/utils/limitCopy';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();

  let urlValue = $state('');
  let error = $state<string | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let showScopeUpgrade = $state(false);
  // Set when the monthly URL-save cap refuses the save. Held apart from `error`
  // so it renders as a notice with a way forward rather than a red line.
  let limitInfo = $state<{ limit: number; resetsAt: string } | null>(null);

  // Auto-focus input when modal opens
  $effect(() => {
    if (open) {
      urlValue = '';
      error = null;
      showScopeUpgrade = false;
      limitInfo = null;
      requestAnimationFrame(() => inputEl?.focus());
    }
  });

  async function handleSave() {
    const url = urlValue.trim();
    if (!url) return;

    try {
      new URL(url);
    } catch {
      error = 'Please enter a valid URL';
      return;
    }

    error = null;
    limitInfo = null;
    try {
      const saved = await savesStore.saveFromUrl(url);
      urlValue = '';
      onclose();
      // Take the user to the saved article. Navigate first, THEN signal which
      // item to open: SavedListView opens it via pushState, which must happen
      // after the goto navigation has settled (otherwise the navigation resets
      // page.state and the reader is torn down mid-render → null deref crash).
      await goto('/saved');
      savesStore.pendingOpenKey = saved.uri || saved.itemGuid || saved.rkey;
    } catch (err) {
      if (err instanceof ScopeUpgradeError) {
        showScopeUpgrade = true;
      } else if (err instanceof UrlSaveLimitError) {
        limitInfo = { limit: err.limit, resetsAt: err.resetsAt };
      } else {
        error = err instanceof Error ? err.message : 'Failed to save article';
      }
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
  }
</script>

<Modal {open} {onclose} title="Save URL">
  {#if limitInfo}
    <div class="limit-wrap">
      <LimitNotice kind="saves">
        <p>{saveLimitLine(limitInfo.limit, limitInfo.resetsAt)}</p>
        <p class="limit-aside">Saving from a feed you subscribe to doesn't count against this.</p>
      </LimitNotice>
    </div>
  {:else if showScopeUpgrade}
    <div class="scope-upgrade">
      <p>Saving articles requires updated permissions. Please log in again to grant access.</p>
      <div class="scope-upgrade-actions">
        <a href="/auth/login" class="scope-upgrade-btn">Log in again</a>
        <button class="dismiss-btn" onclick={() => (showScopeUpgrade = false)}>Dismiss</button>
      </div>
    </div>
  {:else}
    <div class="form">
      <input
        bind:this={inputEl}
        bind:value={urlValue}
        type="url"
        placeholder="Paste article URL..."
        class="url-input"
        onkeydown={handleKeydown}
        disabled={savesStore.saving}
      />
      {#if error}
        <p class="error">{error}</p>
      {/if}
      <button
        class="save-btn"
        onclick={handleSave}
        disabled={savesStore.saving || !urlValue.trim()}
      >
        {#if savesStore.saving}
          Saving...
        {:else}
          Save
        {/if}
      </button>
    </div>
  {/if}
</Modal>

<style>
  .limit-wrap {
    padding: 0.25rem 0 0.5rem;
  }

  .limit-aside {
    color: var(--color-text-secondary);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .url-input {
    width: 100%;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 6px;
    font-size: var(--text-md);
    background: var(--color-bg, #fff);
    color: var(--color-text);
    outline: none;
    box-sizing: border-box;
  }

  .url-input:focus {
    border-color: var(--color-primary, #2563eb);
    box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.1);
  }

  .url-input:disabled {
    opacity: 0.6;
  }

  .save-btn {
    align-self: flex-end;
    padding: 0.5rem 1.25rem;
    background: var(--color-primary, #2563eb);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .save-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .save-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-error, #dc2626);
  }

  .scope-upgrade {
    font-size: var(--text-md);
  }

  .scope-upgrade p {
    margin: 0 0 0.75rem;
  }

  .scope-upgrade-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .scope-upgrade-btn {
    padding: 0.375rem 0.75rem;
    background: var(--color-primary, #2563eb);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    text-decoration: none;
    cursor: pointer;
  }

  .dismiss-btn {
    padding: 0.375rem 0.75rem;
    background: none;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 6px;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  @media (max-width: 600px) {
    .url-input {
      font-size: var(--text-base); /* Prevents iOS zoom on focus */
    }
  }
</style>
