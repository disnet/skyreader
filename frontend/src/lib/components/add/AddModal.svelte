<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon, { type IconName } from '$lib/components/Icon.svelte';
  import ImportOPMLModal from '$lib/components/ImportOPMLModal.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { sidebarStore, type AddTab } from '$lib/stores/sidebar.svelte';
  import {
    openSaveAnywhere,
    SAVE_ANYWHERE_LABEL,
    saveAnywhereLabel,
  } from '$lib/utils/saveAnywhere';
  import AddFeedPanel from './AddFeedPanel.svelte';
  import AddHandlePanel from './AddHandlePanel.svelte';
  import NewsletterPanel from './NewsletterPanel.svelte';
  import SaveLinkPanel from './SaveLinkPanel.svelte';

  // The one place anything comes into the reader, reached from every "+".
  // Each tab is a different kind of thing, so each gets its own input rather
  // than one field that guesses: a site (RSS/Atom or standard.site), an
  // Atmosphere account, newsletters by email, or a single article to keep.
  // Panels mount fresh whenever their tab is shown, so a half-finished flow in
  // one tab never leaks into another.

  const TABS: { id: AddTab; label: string; icon: IconName }[] = [
    { id: 'web', label: 'Website', icon: 'rss' },
    { id: 'atmosphere', label: 'Atmosphere', icon: 'at-sign' },
    { id: 'newsletters', label: 'Newsletter', icon: 'mail' },
    { id: 'save', label: 'Save a link', icon: 'bookmark' },
  ];

  let tab = $derived(sidebarStore.addModalTab);
  let open = $derived(tab !== null);
  let initialValue = $derived(sidebarStore.addSourceInitialValue);

  let showImport = $state(false);
  let saveAnywhereActionLabel = $state(SAVE_ANYWHERE_LABEL);
  let tabEls: Record<string, HTMLButtonElement | undefined> = $state({});

  onMount(() => {
    saveAnywhereActionLabel = saveAnywhereLabel(window.navigator.userAgent);
  });

  function close() {
    sidebarStore.closeAddModal();
  }

  function selectTab(id: AddTab) {
    if (id !== tab) sidebarStore.setAddModalTab(id);
  }

  // Arrow keys move between tabs (WAI-ARIA tabs pattern, automatic activation).
  function handleTabKeydown(e: KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next].id;
    selectTab(id);
    tabEls[id]?.focus();
  }

  function openImport() {
    close();
    showImport = true;
  }

  function saveFromAnywhere() {
    close();
    openSaveAnywhere();
  }
</script>

<Modal {open} onclose={close} title="Add to Skyreader" icon="plus" maxWidth="520px">
  {#snippet headerExtra()}
    {#if !auth.isGuest}
      <div class="tabs" role="tablist" aria-label="What to add" tabindex="-1">
        {#each TABS as t (t.id)}
          <button
            bind:this={tabEls[t.id]}
            id="add-tab-{t.id}"
            class="tab"
            class:active={tab === t.id}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="add-tabpanel"
            tabindex={tab === t.id ? 0 : -1}
            onclick={() => selectTab(t.id)}
            onkeydown={handleTabKeydown}
          >
            <Icon name={t.icon} size={15} />
            <span>{t.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  {/snippet}

  {#if auth.isGuest}
    <!-- Everything here is account-only: a guest reads the curated starter
         channels, which the crawler keeps current. -->
    <div class="guest">
      <p>
        Adding sources and saving links needs an account. Everything you've read or saved as a guest
        comes with you.
      </p>
      <a class="signin-btn" href="/auth/login?returnUrl=/feeds" onclick={close}>Sign in</a>
    </div>
  {:else if tab}
    <div
      class="tabpanel"
      id="add-tabpanel"
      role="tabpanel"
      aria-labelledby="add-tab-{tab}"
      tabindex="-1"
    >
      {#key `${tab}:${initialValue}`}
        {#if tab === 'web'}
          <AddFeedPanel
            onclose={close}
            {initialValue}
            onHandle={(handle) => sidebarStore.setAddModalTab('atmosphere', handle)}
          />
        {:else if tab === 'atmosphere'}
          <AddHandlePanel onclose={close} {initialValue} />
        {:else if tab === 'newsletters'}
          <NewsletterPanel onclose={close} />
        {:else}
          <SaveLinkPanel onclose={close} {initialValue} />
        {/if}
      {/key}

      {#if tab === 'web'}
        <div class="aside">
          <span>Moving from another reader?</span>
          <button class="aside-btn" onclick={openImport}>
            <Icon name="file-text" size={14} />
            Import OPML
          </button>
        </div>
      {:else if tab === 'save'}
        <div class="aside">
          <span>Save while you browse.</span>
          <button class="aside-btn" onclick={saveFromAnywhere}>
            <Icon name="share" size={14} />
            {saveAnywhereActionLabel}
          </button>
        </div>
      {/if}
    </div>
  {/if}
</Modal>

<ImportOPMLModal open={showImport} onclose={() => (showImport = false)} />

<style>
  /* Four equal columns: every kind of source is on screen at once, at any width. */
  .tabs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    padding: 0 0.75rem;
    margin-bottom: -1px;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    min-width: 0;
    padding: 0.5rem 0.625rem 0.625rem;
    border: none;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    cursor: pointer;
    transition:
      color 0.15s,
      border-color 0.15s;
  }

  .tab:hover {
    color: var(--color-text);
  }

  .tab.active {
    color: var(--color-text);
    border-bottom-color: var(--color-primary, #0066cc);
  }

  .tab:focus-visible {
    outline: 2px solid var(--color-primary, #0066cc);
    outline-offset: -2px;
    border-radius: 4px;
  }

  /* A floor, so switching tabs doesn't make the dialog jump in height. */
  .tabpanel {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    min-height: 220px;
    outline: none;
  }

  .aside {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: auto;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .aside-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: transparent;
    color: var(--color-text);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .aside-btn:hover {
    background: var(--color-bg-secondary);
  }

  .guest {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .guest p {
    margin: 0;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .signin-btn {
    align-self: flex-start;
    padding: 0.625rem 1rem;
    border-radius: 8px;
    background: var(--color-primary, #0066cc);
    color: white;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    text-decoration: none;
  }

  .signin-btn:hover {
    opacity: 0.9;
  }

  @media (max-width: 480px) {
    /* Phone: icon over label, so four tabs fit a 360px screen. */
    .tab {
      flex-direction: column;
      gap: 0.25rem;
      padding-inline: 0.25rem;
      font-size: var(--text-xs);
    }
  }
</style>
