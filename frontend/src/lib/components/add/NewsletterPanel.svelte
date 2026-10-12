<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type NewsletterInbox } from '$lib/services/api';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { docsUrl } from '$lib/constants/docs';

  // Newsletters aren't added one by one: each sender that mails the reader's
  // private address becomes a source on its own. So this tab hands over that
  // address (creating it if needed); rotating it and unblocking senders stay
  // in Settings, where the rest of the inbox lives.

  interface Props {
    /** Leaving for Settings or the Supporter page closes the add modal. */
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  let inbox = $state<NewsletterInbox | null>(null);
  let loadFailed = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let copied = $state(false);

  onMount(() => {
    void load();
  });

  async function load() {
    loadFailed = false;
    try {
      inbox = await api.getNewsletters();
    } catch {
      loadFailed = true;
    }
  }

  async function createAddress() {
    busy = true;
    error = null;
    try {
      const { address } = await api.issueNewsletterAddress(false);
      if (inbox) inbox = { ...inbox, address };
      else await load();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not create an address';
    } finally {
      busy = false;
    }
  }

  async function copyAddress() {
    if (!inbox?.address) return;
    try {
      await navigator.clipboard.writeText(inbox.address);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context); the address is selectable.
    }
  }
</script>

<div class="panel">
  <p class="modal-desc">
    Read newsletters here, away from the inbox. Each sender becomes a source.
    <a href={docsUrl('newsletters')} target="_blank" rel="noopener noreferrer">Learn more</a>
  </p>

  {#if !inbox}
    <p class="status">
      {#if loadFailed || !syncStore.isOnline}
        Your newsletter address is available when online.
      {:else}
        Loading…
      {/if}
    </p>
  {:else if !inbox.enabled}
    <p class="status">Newsletter delivery isn't available here yet.</p>
  {:else if inbox.entitled && inbox.address}
    <div class="address-block">
      <span class="label">Your newsletter address</span>
      <div class="address-row">
        <code class="address">{inbox.address}</code>
        <button class="primary-btn" onclick={copyAddress}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p class="hint">
        Sign up with it, or forward an issue to it. Keep it to yourself: anything sent here lands in
        your reader.
      </p>
    </div>
  {:else if inbox.entitled}
    <p class="hint">Get a private address to sign up with.</p>
    <button class="primary-btn start" disabled={busy} onclick={createAddress}>
      {busy ? 'Creating…' : 'Create my address'}
    </button>
  {:else}
    <p class="hint">
      {#if inbox.address}
        <code>{inbox.address}</code> isn't receiving mail while you're off the Supporter plan. Newsletters
        you already have stay readable.
      {:else}
        Newsletters by email are part of the Supporter plan: one private address, and every
        newsletter you send to it becomes a source.
      {/if}
    </p>
    <a class="primary-btn start" href="/supporter" onclick={onclose}>Become a Supporter</a>
  {/if}

  {#if error}
    <p class="error-message">{error}</p>
  {/if}

  {#if inbox?.enabled && inbox.entitled}
    <a class="secondary-link" href="/settings#newsletters" onclick={onclose}>
      Manage address and blocked senders in Settings
    </a>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 100px;
  }

  .modal-desc {
    margin: 0;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .modal-desc a {
    color: var(--color-primary);
  }

  .status,
  .hint {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .address-block {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .address-row {
    display: flex;
    gap: 0.5rem;
    align-items: stretch;
  }

  .address {
    flex: 1;
    min-width: 0;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg-secondary);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
    user-select: all;
  }

  .primary-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.625rem 1rem;
    border: none;
    border-radius: 8px;
    background: var(--color-primary, #0066cc);
    color: white;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    text-decoration: none;
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }

  .primary-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .start {
    align-self: flex-start;
  }

  .secondary-link {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .secondary-link:hover {
    color: var(--color-text);
  }

  .error-message {
    margin: 0;
    color: var(--color-error);
    font-size: var(--text-md);
  }
</style>
