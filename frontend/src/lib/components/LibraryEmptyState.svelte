<script lang="ts">
  import { onMount } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { api, RateLimitError } from '$lib/services/api';
  import SourcesDiscovery from '$lib/components/sources/SourcesDiscovery.svelte';
  import ImportOPMLModal from '$lib/components/ImportOPMLModal.svelte';
  import SaveBackingPicker from '$lib/components/settings/SaveBackingPicker.svelte';
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    onAddFeed: () => void;
    onAddHandle: () => void;
  }

  let { onAddFeed, onAddHandle }: Props = $props();

  let showImportModal = $state(false);
  let pdsSyncEnabled = $state(false);
  let isLoading = $state(true);
  let isToggling = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    if (!syncStore.isOnline) {
      isLoading = false;
      return;
    }
    try {
      const settings = await api.getSettings();
      pdsSyncEnabled = settings.pdsSyncEnabled;
    } catch (e) {
      console.error('Failed to load sync settings:', e);
    } finally {
      isLoading = false;
    }
  });

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Enabling sync may pull subscriptions you've stored from another app —
  // run a sync so an existing PDS library lands here right away.
  async function runFullSync() {
    let hasMore = true;
    let batches = 0;
    while (hasMore && batches < 20) {
      batches++;
      try {
        const result = await api.triggerFullSync();
        hasMore = result.hasMore || false;
      } catch (e) {
        if (e instanceof RateLimitError) {
          await sleep(Math.min(e.retryAfter, 60) * 1000);
          batches--;
          continue;
        }
        throw e;
      }
    }
    await subscriptionsStore.load();
  }

  async function handleToggle(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    const newValue = target.checked;

    error = null;

    if (!syncStore.isOnline) {
      error = 'You are offline. Connect to the internet to change this.';
      pdsSyncEnabled = !newValue;
      return;
    }

    isToggling = true;
    try {
      const settings = await api.updateSettings({ pdsSyncEnabled: newValue });
      pdsSyncEnabled = settings.pdsSyncEnabled;

      if (newValue) {
        await runFullSync();
      }
    } catch (e) {
      console.error('Failed to update sync setting:', e);
      error = e instanceof Error ? e.message : 'Failed to update setting';
      pdsSyncEnabled = !newValue;
    } finally {
      isToggling = false;
    }
  }
</script>

<div class="library-empty">
  <h2>Your library is empty</h2>
  <p class="lede">Subscribe to a few feeds.</p>

  <div class="add-actions">
    <button type="button" class="add-action primary" onclick={onAddFeed}>
      <Icon name="rss" size={18} />
      <span class="label">Add an RSS feed</span>
      <Icon name="chevron-right" size={18} />
    </button>
    <button type="button" class="add-action" onclick={onAddHandle}>
      <Icon name="at-sign" size={18} />
      <span class="label">Add an Atmosphere publication</span>
      <Icon name="chevron-right" size={18} />
    </button>
    <button type="button" class="add-action" onclick={() => (showImportModal = true)}>
      <Icon name="file-text" size={18} />
      <span class="label">Import OPML</span>
      <Icon name="chevron-right" size={18} />
    </button>
  </div>

  <div class="portability">
    <h3>Take your subscriptions with you</h3>
    <p>
      By default your feed list is stored privately on the Skyreader servers. Turn on Atmospheric
      sync to also store your subscriptions on your atproto PDS — portable to other Atmospheric
      apps, and kept in step with your standard.site subscriptions. Your subscription list becomes
      <strong>publicly visible</strong> when synced.
    </p>

    {#if isLoading}
      <p class="status">Checking your sync setting…</p>
    {:else}
      <label class="toggle" class:disabled={isToggling}>
        <input
          type="checkbox"
          checked={pdsSyncEnabled}
          disabled={isToggling}
          onchange={handleToggle}
        />
        <span>Turn on Atmospheric sync</span>
      </label>

      {#if isToggling}
        <p class="status">Saving…</p>
      {:else if pdsSyncEnabled}
        <p class="status confirm">
          On — new subscriptions sync to the Atmosphere automatically.
          {#if auth.user}
            <a
              href="https://pdsls.dev/at://{auth.user.did}"
              target="_blank"
              rel="noopener noreferrer">View your PDS data</a
            >
          {/if}
        </p>
      {/if}

      {#if error}
        <p class="status error">{error}</p>
      {/if}

      <p class="footnote">You can change this anytime in Settings.</p>
    {/if}
  </div>

  <div class="portability">
    <h3>Where your saves live</h3>
    <p>
      Your saves stay private on Skyreader. To turn your whole Saved list into a collection you can
      edit in another app, back it with Semble or Margin. That collection is public. You can change
      this anytime.
    </p>
    <SaveBackingPicker allowExport={false} returnUrl="/" />
  </div>

  <div class="discovery-wrap">
    <SourcesDiscovery />
  </div>
</div>

<ImportOPMLModal open={showImportModal} onclose={() => (showImportModal = false)} />

<style>
  .library-empty {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--color-text-secondary);
    max-width: 34rem;
    margin: 0 auto;
  }

  .discovery-wrap {
    margin-top: 2.5rem;
    text-align: left;
  }

  .library-empty h2 {
    font-size: var(--text-2xl);
    margin-bottom: 0.5rem;
    color: var(--color-text);
  }

  .lede {
    margin-bottom: 1.5rem;
    line-height: var(--leading-normal);
  }

  .add-actions {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    text-align: left;
  }

  .add-action {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 1rem;
    font: inherit;
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
    color: var(--color-text);
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease;
  }

  .add-action .label {
    flex: 1;
    text-align: left;
  }

  /* leading icon picks up the One Blue accent; trailing chevron stays quiet */
  .add-action :global(.icon:first-child) {
    color: var(--color-primary);
  }

  .add-action :global(.icon:last-child) {
    color: var(--color-text-secondary);
  }

  .add-action:hover {
    background: var(--color-bg-secondary, rgba(0, 102, 204, 0.06));
    border-color: var(--color-primary);
  }

  .add-action:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.35);
  }

  .add-action.primary {
    color: #fff;
    background: var(--color-primary);
    border-color: var(--color-primary);
  }

  .add-action.primary :global(.icon) {
    color: #fff;
  }

  .add-action.primary:hover {
    background: var(--color-primary-dark);
    border-color: var(--color-primary-dark);
  }

  .portability {
    margin-top: 2.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--color-border);
    text-align: left;
  }

  .portability h3 {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    margin-bottom: 0.5rem;
  }

  .portability p {
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    margin-bottom: 1rem;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-md);
    color: var(--color-text);
    cursor: pointer;
  }

  .toggle.disabled {
    cursor: default;
    opacity: 0.7;
  }

  .toggle input {
    width: 1rem;
    height: 1rem;
    accent-color: var(--color-primary);
    cursor: inherit;
  }

  .status {
    font-size: var(--text-sm);
    margin: 0.5rem 0 0;
  }

  .status.confirm {
    color: var(--color-success, #4caf50);
  }

  .status.error {
    color: var(--color-error, #f44336);
  }

  .footnote {
    font-size: var(--text-sm);
    margin: 0.75rem 0 0;
    color: var(--color-text-secondary);
  }
</style>
