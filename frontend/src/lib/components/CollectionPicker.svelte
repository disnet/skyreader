<script lang="ts">
  // Two modes in one modal. If the article has never been saved to this
  // integration, the picker behaves exactly as it always did: pick collections,
  // create a card/note. If it HAS been saved, the modal opens on the live PDS
  // answer — the collections it's already in are pre-checked, and confirming
  // applies the difference (new links added, unchecked links deleted) instead of
  // creating a second card. Editing never deletes the card/note itself.
  //
  // Membership is read per-open rather than remembered: a save can be created or
  // moved in Semble/Margin themselves, so anything we cached would eventually lie.
  // Offline there's no way to read it, so the picker stays in create mode (a diff
  // computed against stale state would delete the wrong links).
  //
  // Ordering is the one thing the picker knows that the servers don't. Neither
  // Semble nor Margin reports when a collection was last filed into, so the
  // "Recently used" band comes from lastUsedAt, stamped locally on confirm
  // (collections.svelte.ts). Everything below it is alphabetical, so a name you
  // know stays where you left it while the ones you actually reach for float up.
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import {
    collectionsStore,
    type CollectionEntry,
    type IntegrationKind,
  } from '$lib/stores/collections.svelte';
  import { saveBackingStore } from '$lib/stores/saveBacking.svelte';
  import { api } from '$lib/services/api';
  import { formatRelativeTime } from '$lib/utils/date';
  import type {
    IntegrationMemberships,
    CollectionSelection,
    CollectionPickerResult,
  } from '$lib/types';

  interface Props {
    open: boolean;
    integration: IntegrationKind;
    /** the article URL being saved — membership is looked up per-URL */
    url?: string;
    onconfirm: (result: CollectionPickerResult) => void;
    onclose: () => void;
  }

  let { open, integration, url, onconfirm, onclose }: Props = $props();

  /** How many collections the "Recently used" band leads with. */
  const RECENT_LIMIT = 5;

  let searchQuery = $state('');
  let selectedUris = $state<Set<string>>(new Set());
  let noCollection = $state(false);
  let memberships = $state<IntegrationMemberships | null>(null);
  let membershipsLoading = $state(false);
  // Non-reactive generation counter: changing it must not retrigger the open
  // effect that starts membership requests.
  let membershipRequestId = 0;
  // The lookup is advisory: if it fails we fall back to create mode rather than
  // block the save. A duplicate card is recoverable; a blocked save is annoying.
  let membershipsFailed = $state(false);

  let list = $derived<CollectionEntry[]>(collectionsStore.collections[integration]);
  let isLoading = $derived(collectionsStore.loading[integration]);
  let isRefreshing = $derived(collectionsStore.refreshing[integration]);
  let loadError = $derived(collectionsStore.error[integration]);
  let isOffline = $derived(loadError === 'offline');
  let needsScopeUpgrade = $derived(loadError === 'scope_upgrade_required');
  // Nothing to list and no way to get one. The picker still opens: saving
  // without a collection is exactly the escape hatch this state needs, so the
  // notice replaces the list, not the whole body.
  let noListing = $derived(!!loadError && list.length === 0);

  function collectionName(c: CollectionEntry): string {
    return c.name?.trim() || 'Untitled';
  }

  /**
   * The scan anchor on each row. Array.from so an emoji or any other non-BMP
   * first character survives being sliced.
   */
  function monogram(c: CollectionEntry): string {
    const name = c.name?.trim();
    if (!name) return '·';
    return Array.from(name)[0].toLocaleUpperCase();
  }

  let byName = $derived(
    [...list].sort((a, b) =>
      collectionName(a).localeCompare(collectionName(b), undefined, { sensitivity: 'base' })
    )
  );

  let recent = $derived(
    list
      .filter((c) => typeof c.lastUsedAt === 'number')
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .slice(0, RECENT_LIMIT)
  );

  let filtered = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return byName;
    return byName.filter((c) => {
      const name = (c.name || '').toLowerCase();
      const desc = (c.description || '').toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  });

  // Searching is a different mental mode: one flat ranked list of matches beats
  // two bands that both say "no results".
  let searching = $derived(searchQuery.trim().length > 0);
  let banded = $derived(!searching && recent.length > 0);

  let integrationName = $derived(
    { semble: 'Semble', margin: 'Margin', currents: 'Currents' }[integration]
  );
  let singleSelect = $derived(integration === 'currents');

  // Edit mode = this URL already has a card/note in the user's repo.
  let isEdit = $derived((memberships?.items.length ?? 0) > 0);
  // A capped item listing that found no match is not proof this is a first save.
  // Keep the lookup honest, but don't permanently block established users whose
  // repos are larger than the bounded scan: a possible duplicate is recoverable.
  let lookupIncomplete = $derived(memberships?.truncated === true && !isEdit);
  /** collections the save currently belongs to (the diff baseline) */
  let initialUris = $derived(new Set((memberships?.memberships ?? []).map((m) => m.collectionUri)));

  // The one collection that must not be edited from here: when the Saved list is
  // backed by it, its membership IS the save, and removing the link would silently
  // unsave the article on the next poll. Unknown backing (lookup failed) locks
  // nothing — see saveBacking.svelte.ts.
  let lockedUri = $derived.by(() => {
    const backing = saveBackingStore.backing;
    return backing && backing.provider === integration ? backing.collectionUri : null;
  });

  let addedUris = $derived([...selectedUris].filter((u) => !initialUris.has(u)));
  let removedUris = $derived([...initialUris].filter((u) => !selectedUris.has(u)));
  let changed = $derived(addedUris.length > 0 || removedUris.length > 0);

  let canSave = $derived.by(() => {
    if (needsScopeUpgrade) return false;
    if (membershipsLoading) return false;
    // Until this settles, the row whose membership IS the user's Saved entry is
    // unknown and must not be editable (or removable through "remove all").
    if (!singleSelect && !saveBackingStore.loaded) return false;
    if (singleSelect) return noCollection || selectedUris.size === 1;
    if (isEdit) return changed;
    return noCollection || selectedUris.size > 0;
  });

  let saveLabel = $derived(isEdit ? 'Update' : 'Save');

  // The list scrolls inside the modal, so its own edges have to say so. Without
  // this a row is sliced clean in half at the container edge and reads as a
  // rendering fault rather than as "there's more".
  let listEl = $state<HTMLDivElement | null>(null);
  let moreAbove = $state(false);
  let moreBelow = $state(false);

  function measureScroll() {
    const el = listEl;
    if (!el) return;
    moreAbove = el.scrollTop > 2;
    moreBelow = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
  }

  // Re-measure whenever the rendered set changes (search, bands, a refresh).
  $effect(() => {
    void filtered;
    void banded;
    void recent.length;
    measureScroll();
  });

  /**
   * The running answer, read out beside the buttons so the choice is legible
   * without counting checkmarks. In edit mode it's the pending diff.
   */
  let summary = $derived.by(() => {
    if (membershipsLoading || (!singleSelect && !saveBackingStore.loaded)) return '';
    if (isEdit) {
      if (!changed) return 'No changes yet';
      const parts: string[] = [];
      if (addedUris.length > 0) parts.push(`${addedUris.length} added`);
      if (removedUris.length > 0) parts.push(`${removedUris.length} removed`);
      return parts.join(' · ');
    }
    if (noCollection) return 'Saving without a collection';
    if (selectedUris.size === 0) return '';
    return `${selectedUris.size} selected`;
  });

  $effect(() => {
    if (open) {
      collectionsStore.loadAndRefresh(integration);
      if (!singleSelect) saveBackingStore.load();
      loadMemberships(integration, url);
    } else {
      // Reset picker state when modal closes.
      membershipRequestId += 1;
      searchQuery = '';
      selectedUris = new Set();
      noCollection = false;
      memberships = null;
      membershipsLoading = false;
      membershipsFailed = false;
    }
  });

  async function loadMemberships(kind: IntegrationKind, target: string | undefined) {
    const requestId = ++membershipRequestId;
    memberships = null;
    membershipsFailed = false;
    // No URL, or offline: nothing readable, so stay in create mode.
    if (kind === 'currents' || !target || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      membershipsLoading = false;
      return;
    }
    membershipsLoading = true;
    try {
      const res = await api.getIntegrationMemberships(kind, target);
      // The modal may have been closed (or reopened for another article) while the
      // request was in flight — only apply an answer that's still the current one.
      if (requestId !== membershipRequestId || !open || kind !== integration || target !== url)
        return;
      memberships = res;
      selectedUris = new Set(res.memberships.map((m) => m.collectionUri));
    } catch (err) {
      console.error('Failed to load existing saves:', err);
      if (requestId !== membershipRequestId || !open || kind !== integration || target !== url)
        return;
      membershipsFailed = true;
    } finally {
      // A request for an earlier article must not unlock the current picker while
      // its membership lookup is still pending.
      if (requestId === membershipRequestId) membershipsLoading = false;
    }
  }

  function toggleCollection(uri: string) {
    if (uri === lockedUri) return;
    if (singleSelect) {
      selectedUris = new Set([uri]);
      noCollection = false;
      return;
    }
    const next = new Set(selectedUris);
    if (next.has(uri)) {
      next.delete(uri);
    } else {
      next.add(uri);
      noCollection = false;
    }
    selectedUris = next;
  }

  /** Create mode: "No collection". Edit mode: "Remove from all collections". */
  function toggleNoCollection() {
    if (isEdit) {
      selectedUris = new Set(lockedUri && initialUris.has(lockedUri) ? [lockedUri] : []);
      return;
    }
    if (noCollection) {
      noCollection = false;
    } else {
      noCollection = true;
      selectedUris = new Set();
    }
  }

  function handleSave() {
    if (!canSave) return;

    if (isEdit) {
      const byUri = new Map(list.map((c) => [c.uri, c]));
      const add: CollectionSelection[] = addedUris.map((uri) => ({
        uri,
        cid: byUri.get(uri)?.cid ?? '',
      }));
      // Every link pointing at a de-selected collection, across all matched items —
      // a URL saved twice can sit in the same collection through two links.
      const remove = (memberships?.memberships ?? [])
        .filter((m) => removedUris.includes(m.collectionUri))
        .map((m) => m.linkUri);
      onconfirm({ mode: 'edit', add, remove });
      return;
    }

    if (noCollection) {
      onconfirm({ mode: 'create', collections: [] });
      return;
    }
    const byUri = new Map(list.map((c) => [c.uri, c]));
    const collections: CollectionSelection[] = [];
    for (const uri of selectedUris) {
      const col = byUri.get(uri);
      if (col) collections.push({ uri: col.uri, cid: col.cid });
    }
    onconfirm({ mode: 'create', collections });
  }
</script>

<!--
  One row, used by every band. `showUsed` is on only inside "Recently used",
  where a timestamp has a heading to be relative to; repeating it in the full
  alphabetical list below would be noise without a frame.
-->
{#snippet collectionRow(collection: CollectionEntry, showUsed: boolean)}
  {@const checked = selectedUris.has(collection.uri)}
  {@const locked = collection.uri === lockedUri}
  <button
    class="collection-row"
    class:selected={checked}
    class:locked
    role={singleSelect ? 'radio' : 'checkbox'}
    aria-checked={checked}
    aria-disabled={locked}
    onclick={() => toggleCollection(collection.uri)}
    disabled={!singleSelect && !saveBackingStore.loaded}
    type="button"
  >
    <span class="tile" aria-hidden="true">
      {#if checked}
        <span class="tile-check"><Icon name="check" size={16} /></span>
      {:else}
        {monogram(collection)}
      {/if}
    </span>
    <div class="collection-info">
      <span class="collection-line">
        <span class="collection-name">{collectionName(collection)}</span>
        {#if locked}
          <span class="backing-pill">
            <Icon name="bookmark" size={11} />
            Saved list
          </span>
        {:else if showUsed && collection.lastUsedAt}
          <span class="used-at">{formatRelativeTime(collection.lastUsedAt)}</span>
        {/if}
      </span>
      {#if locked}
        <span class="collection-desc">
          Managed by your Saved list. {checked
            ? 'Unsave the article to remove it.'
            : 'Save the article to add it.'}
        </span>
      {:else if collection.description}
        <span class="collection-desc">{collection.description}</span>
      {/if}
    </div>
  </button>
{/snippet}

<Modal
  {open}
  {onclose}
  maxWidth="520px"
  title={isEdit ? `Saved to ${integrationName}` : `Save to ${integrationName}`}
>
  <div class="picker-body">
    {#if !noListing && (isLoading || membershipsLoading) && list.length === 0}
      <div class="skeleton-list" aria-hidden="true">
        {#each [0, 1, 2, 3] as i (i)}
          <div class="skeleton-row" style:--skeleton-delay="{i * 90}ms">
            <span class="skeleton-tile"></span>
            <span class="skeleton-bars">
              <span class="skeleton-bar" style:width="{58 - i * 9}%"></span>
              <span class="skeleton-bar skeleton-bar-sub" style:width="{38 + i * 7}%"></span>
            </span>
          </div>
        {/each}
      </div>
      <p class="sr-only" aria-live="polite">Loading collections</p>
    {:else}
      {#if noListing && isOffline}
        <p class="notice notice-warn">
          <span class="notice-icon" aria-hidden="true"><Icon name="alert-circle" size={15} /></span>
          <span>
            You're offline and no collections are cached. You can still save without a collection
            and it will go out when you're back.
          </span>
        </p>
      {:else if noListing}
        <p class="notice notice-error">
          <span class="notice-icon" aria-hidden="true"><Icon name="alert-circle" size={15} /></span>
          <span>
            {needsScopeUpgrade ? 'Log in again to grant Currents permissions.' : loadError}
          </span>
        </p>
      {:else if isOffline}
        <p class="notice notice-warn">
          <span class="notice-icon" aria-hidden="true"><Icon name="alert-circle" size={15} /></span>
          <span>Offline, showing cached collections. Your save will go out when you're back.</span>
        </p>
      {/if}

      {#if membershipsLoading}
        <p class="notice" aria-live="polite">Checking existing saves…</p>
      {:else if isEdit}
        <p class="notice">
          {#if initialUris.size === 0}
            Saved without a collection. Pick where it should live.
          {:else}
            Already in {initialUris.size} collection{initialUris.size === 1 ? '' : 's'}. Changes
            apply on update.
          {/if}
          {#if memberships?.truncated}
            <span class="notice-soft">Some older saves may not be shown.</span>
          {/if}
        </p>
      {:else if lookupIncomplete}
        <p class="notice notice-warn">
          <span class="notice-icon" aria-hidden="true"><Icon name="alert-circle" size={15} /></span>
          <span>
            Couldn't check all older saves. Saving may create another {integrationName} item.
          </span>
        </p>
      {:else if membershipsFailed}
        <p class="notice notice-warn">
          <span class="notice-icon" aria-hidden="true"><Icon name="alert-circle" size={15} /></span>
          <span>Couldn't check existing saves, so saving will create a new one.</span>
        </p>
      {/if}

      {#if list.length > 0}
        <div class="search-row">
          <span class="search-icon" aria-hidden="true"><Icon name="search" size={16} /></span>
          <input
            type="text"
            placeholder="Search collections"
            bind:value={searchQuery}
            class="search-input"
            aria-label="Search collections"
          />
          {#if isRefreshing}
            <span class="refreshing-badge" aria-live="polite">Refreshing…</span>
          {/if}
        </div>
      {/if}

      <!--
        Create mode this is a checkbox ("No collection", on or off). Edit mode it
        is a one-shot action ("Remove from all collections") that clears the
        selection and never sets noCollection, so it keeps plain button
        semantics — a checkbox permanently announcing "not checked" would report
        a state that never changes.
      -->
      <button
        class="collection-row no-collection"
        class:selected={!isEdit && noCollection}
        role={isEdit ? undefined : 'checkbox'}
        aria-checked={isEdit ? undefined : noCollection}
        onclick={toggleNoCollection}
        disabled={!singleSelect && !saveBackingStore.loaded}
        type="button"
      >
        <span class="tile tile-none" aria-hidden="true">
          {#if !isEdit && noCollection}
            <span class="tile-check"><Icon name="check" size={16} /></span>
          {:else}
            <Icon name="minus" size={15} />
          {/if}
        </span>
        <div class="collection-info">
          <span class="collection-line">
            <span class="collection-name">
              {isEdit && initialUris.size > 0 ? 'Remove from all collections' : 'No collection'}
            </span>
          </span>
        </div>
      </button>

      {#if !noListing}
        <div class="collection-divider"></div>

        <div
          class="collections-list"
          class:more-above={moreAbove}
          class:more-below={moreBelow}
          bind:this={listEl}
          onscroll={measureScroll}
        >
          {#if filtered.length === 0}
            <div class="empty-state">
              {#if searching}
                <p class="empty-title">No collection matches “{searchQuery.trim()}”</p>
                <p class="empty-hint">Try a shorter word, or save without a collection.</p>
              {:else}
                <p class="empty-title">No collections in {integrationName} yet</p>
                <p class="empty-hint">Make one there and it will show up here.</p>
              {/if}
            </div>
          {:else if banded}
            <p class="band-label">Recently used</p>
            {#each recent as collection (collection.uri)}
              {@render collectionRow(collection, true)}
            {/each}
            <p class="band-label band-label-spaced">All collections</p>
            {#each byName as collection (collection.uri)}
              {@render collectionRow(collection, false)}
            {/each}
          {:else}
            {#each filtered as collection (collection.uri)}
              {@render collectionRow(collection, false)}
            {/each}
          {/if}
        </div>
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    <!-- always present so the live region can announce a change into it -->
    <span class="footer-summary" aria-live="polite">{summary}</span>
    <button class="btn btn-secondary" onclick={onclose} type="button">Cancel</button>
    <button class="btn btn-primary" onclick={handleSave} disabled={!canSave} type="button">
      {saveLabel}
    </button>
  {/snippet}
</Modal>

<style>
  .picker-body {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* ── Notices ─────────────────────────────────────────────────
     One shape for every out-of-band message. Neutral by default;
     the warn/error variants earn an icon so a problem is legible
     before the sentence is read. */
  .notice {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem 0.125rem;
    font-size: var(--text-md);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
  }

  .notice-warn,
  .notice-error {
    padding: 0.5rem 0.625rem;
    border-radius: 6px;
    background: var(--color-bg-secondary);
    margin-bottom: 0.5rem;
  }

  .notice-icon {
    display: flex;
    flex-shrink: 0;
    /* optical: pull the glyph onto the first line's baseline band */
    margin-top: 0.0625rem;
    color: var(--color-warning);
  }

  .notice-error .notice-icon {
    color: var(--color-error);
  }

  .notice-soft {
    display: block;
    font-size: var(--text-sm);
  }

  /* ── Search ──────────────────────────────────────────────── */
  .search-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4375rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    margin-bottom: 0.75rem;
    background: var(--color-bg);
    transition: border-color 0.15s ease;
  }

  .search-row:focus-within {
    border-color: var(--color-primary);
  }

  .search-icon {
    color: var(--color-text-secondary);
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .search-input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    font-family: inherit;
    font-size: var(--text-lg);
    color: var(--color-text);
    min-width: 0;
  }

  .search-input::placeholder {
    color: var(--color-text-secondary);
  }

  .refreshing-badge {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  /* ── Rows ────────────────────────────────────────────────────
     The tile is both the collection's mark and its checkbox: at rest
     it carries the name's initial (a scan anchor in a long list), and
     selecting flips it to the wash-blue check. One element, two jobs,
     so a row of twenty reads as a list rather than a form. */
  .collection-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.4375rem 0.5rem;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;
    border-radius: 8px;
    color: var(--color-text);
    font-family: inherit;
    transition: background-color 0.15s ease;
  }

  .collection-row:hover {
    background: var(--color-bg-secondary);
  }

  .collection-row.selected {
    background: var(--color-sidebar-active);
  }

  .collection-row.selected:hover {
    background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  }

  .collection-row:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .collection-row.locked {
    cursor: default;
  }

  .collection-row.locked:hover {
    background: none;
  }

  .collection-row.locked.selected,
  .collection-row.locked.selected:hover {
    background: var(--color-sidebar-active);
  }

  .collection-row:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .tile {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg-secondary);
    display: grid;
    place-items: center;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-none);
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
  }

  .collection-row.selected .tile {
    background: var(--color-sidebar-active);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .tile-none {
    color: var(--color-text-secondary);
    border-style: dashed;
    background: none;
  }

  .collection-row.selected .tile-none {
    border-style: solid;
  }

  .tile-check {
    display: flex;
    animation: tile-check 0.15s cubic-bezier(0.22, 1, 0.36, 1);
  }

  @keyframes tile-check {
    from {
      opacity: 0;
      transform: scale(0.6);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .collection-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .collection-line {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
  }

  .collection-name {
    flex: 1;
    min-width: 0;
    font-weight: var(--weight-medium);
    font-size: var(--text-lg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .used-at {
    flex-shrink: 0;
    font-size: var(--text-xs);
    font-weight: var(--weight-regular);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .backing-pill {
    flex-shrink: 0;
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-wide);
    white-space: nowrap;
  }

  .collection-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collection-divider {
    height: 1px;
    background: var(--color-border);
    margin: 0.5rem 0;
  }

  /* ── Bands ───────────────────────────────────────────────── */
  .band-label {
    padding: 0.25rem 0.5rem 0.375rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  .band-label-spaced {
    /* more room above a heading than below it */
    margin-top: 0.875rem;
  }

  .collections-list {
    max-height: 46vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    display: flex;
    flex-direction: column;
    /* room for the focus ring on the last row */
    padding-bottom: 2px;
  }

  /* Fade the cut edge so a half-row reads as continuation, not a clipping bug.
     Only the edges that actually have more content behind them are masked. */
  .collections-list.more-below {
    mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
  }

  .collections-list.more-above {
    mask-image: linear-gradient(to bottom, transparent, #000 24px);
  }

  .collections-list.more-above.more-below {
    mask-image: linear-gradient(
      to bottom,
      transparent,
      #000 24px,
      #000 calc(100% - 28px),
      transparent
    );
  }

  /* ── Loading ─────────────────────────────────────────────── */
  .skeleton-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 0.5rem;
  }

  .skeleton-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    animation: skeleton-pulse 1.4s ease-in-out infinite;
    animation-delay: var(--skeleton-delay, 0ms);
  }

  .skeleton-tile {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    background: var(--color-bg-secondary);
  }

  .skeleton-bars {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .skeleton-bar {
    height: 9px;
    border-radius: 999px;
    background: var(--color-bg-secondary);
  }

  .skeleton-bar-sub {
    height: 7px;
    opacity: 0.7;
  }

  @keyframes skeleton-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  /* ── Empty ───────────────────────────────────────────────── */
  .empty-state {
    padding: 1.75rem 1rem;
    text-align: center;
  }

  .empty-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .empty-hint {
    margin: 0.375rem auto 0;
    max-width: 42ch;
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
  }

  /* ── Footer ──────────────────────────────────────────────── */
  .footer-summary {
    margin-right: auto;
    align-self: center;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .btn {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-family: inherit;
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    cursor: pointer;
    border: 1px solid transparent;
    transition: background-color 0.2s ease;
  }

  .btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .btn-secondary {
    background: transparent;
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .btn-secondary:hover {
    background: var(--color-bg-secondary);
  }

  .btn-primary {
    background: var(--color-primary);
    color: #ffffff;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-dark);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 640px) {
    .collection-name {
      font-size: var(--text-base);
    }

    .collections-list {
      max-height: 52vh;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .collection-row,
    .tile,
    .search-row,
    .btn {
      transition: none;
    }

    .tile-check {
      animation: none;
    }

    .skeleton-row {
      animation: none;
      opacity: 0.7;
    }
  }
</style>
