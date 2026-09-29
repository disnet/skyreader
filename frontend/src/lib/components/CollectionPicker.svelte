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
  // Speed is the other job. Most saves go to the same handful of collections, so
  // those sit one tap away as "quick picks": the reader's starred favorites, then
  // the ones they filed into most recently. Neither Semble nor Margin reports
  // either, so both are local (collections.svelte.ts). Everything else is one
  // alphabetical list, so a name you know stays where you left it, and the filter
  // field narrows it as you type — Enter takes the top match, so a keyboard save
  // is "type, Enter, type, Enter, ⌘Enter".
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

  /** How many recently used collections join the favorites as quick picks. */
  const RECENT_LIMIT = 4;

  let searchQuery = $state('');
  let selectedUris = $state<Set<string>>(new Set());
  // Anything checked while the picker is open joins the quick picks and stays
  // there until it closes — even if unchecked again — so a collection found by
  // filtering a long list is visible (and undoable) without finding it twice,
  // and chips never jump out from under a pointer.
  let keptUris = $state<Set<string>>(new Set());
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
  let listingShort = $derived(collectionsStore.truncated?.[integration] === true);
  let favorites = $derived(collectionsStore.favorites ?? {});
  let isOffline = $derived(loadError === 'offline');
  // Nothing to list and no way to get one. The picker still opens: saving
  // without a collection is exactly the escape hatch this state needs, so the
  // notice replaces the list, not the whole body.
  let noListing = $derived(!!loadError && list.length === 0);

  function collectionName(c: CollectionEntry): string {
    return c.name?.trim() || 'Untitled';
  }

  function isFavorite(uri: string): boolean {
    return uri in favorites;
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

  function compareNames(a: CollectionEntry, b: CollectionEntry): number {
    return collectionName(a).localeCompare(collectionName(b), undefined, { sensitivity: 'base' });
  }

  let byName = $derived([...list].sort(compareNames));
  let byUri = $derived(new Map(list.map((c) => [c.uri, c])));

  // The one collection that must not be edited from here: when the Saved list is
  // backed by it, its membership IS the save, and removing the link would silently
  // unsave the article on the next poll. Unknown backing (lookup failed) locks
  // nothing — see saveBacking.svelte.ts.
  let lockedUri = $derived.by(() => {
    const backing = saveBackingStore.backing;
    return backing && backing.provider === integration ? backing.collectionUri : null;
  });

  /**
   * Favorites first (in the order the list has them, so they don't reshuffle as
   * you star), then the few most recently used that aren't already favorites.
   * The Saved-list collection is left out: it can't be toggled from here, and a
   * chip that does nothing is worse than no chip.
   */
  let quickPicks = $derived.by(() => {
    const pickable = list.filter((c) => c.uri !== lockedUri);
    const favs = pickable.filter((c) => isFavorite(c.uri)).sort(compareNames);
    const recent = pickable
      .filter((c) => !isFavorite(c.uri) && typeof c.lastUsedAt === 'number')
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .slice(0, RECENT_LIMIT);
    const shown = new Set([...favs, ...recent].map((c) => c.uri));
    const extra = [...keptUris]
      .filter((u) => !shown.has(u) && u !== lockedUri)
      .map((u) => byUri.get(u))
      .filter((c): c is CollectionEntry => !!c);
    return [...favs, ...recent, ...extra];
  });
  let hasFavorites = $derived(list.some((c) => isFavorite(c.uri)));

  let query = $derived(searchQuery.trim().toLocaleLowerCase());
  let searching = $derived(query.length > 0);

  /**
   * How well a collection matches the filter, best first: the name starts with
   * it, a word in the name does, the name contains it, or every word of the query
   * turns up somewhere in the name or description. null = no match.
   */
  function matchRank(c: CollectionEntry, q: string): number | null {
    const name = collectionName(c).toLocaleLowerCase();
    const at = name.indexOf(q);
    if (at === 0) return 0;
    if (at > 0) return /[\s\-_/:.,(&+]/.test(name[at - 1]) ? 1 : 2;
    const haystack = `${name} ${(c.description ?? '').toLocaleLowerCase()}`;
    const words = q.split(/\s+/).filter(Boolean);
    return words.every((w) => haystack.includes(w)) ? 3 : null;
  }

  let filtered = $derived.by(() => {
    if (!searching) return byName;
    const ranked: Array<{ c: CollectionEntry; rank: number }> = [];
    for (const c of list) {
      const rank = matchRank(c, query);
      if (rank !== null) ranked.push({ c, rank });
    }
    // Ties go to the collections the reader reaches for, then the alphabet.
    return ranked
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          Number(isFavorite(b.c.uri)) - Number(isFavorite(a.c.uri)) ||
          (b.c.lastUsedAt ?? 0) - (a.c.lastUsedAt ?? 0) ||
          compareNames(a.c, b.c)
      )
      .map((r) => r.c);
  });

  /** The name split around the filter's match, for highlighting it in place. */
  function nameParts(c: CollectionEntry): [string, string, string] | null {
    if (!searching) return null;
    const name = collectionName(c);
    const lower = name.toLocaleLowerCase();
    // Case-folding can change a string's length (İ → i̇); skip the highlight
    // rather than mark the wrong characters.
    if (lower.length !== name.length) return null;
    const at = lower.indexOf(query);
    if (at < 0) return null;
    return [name.slice(0, at), name.slice(at, at + query.length), name.slice(at + query.length)];
  }

  let integrationName = $derived(integration === 'semble' ? 'Semble' : 'Margin');

  // Edit mode = this URL already has a card/note in the user's repo.
  let isEdit = $derived((memberships?.items.length ?? 0) > 0);
  // A capped item listing that found no match is not proof this is a first save.
  // Keep the lookup honest, but don't permanently block established users whose
  // repos are larger than the bounded scan: a possible duplicate is recoverable.
  let lookupIncomplete = $derived(memberships?.truncated === true && !isEdit);
  /** collections the save currently belongs to (the diff baseline) */
  let initialUris = $derived(new Set((memberships?.memberships ?? []).map((m) => m.collectionUri)));

  let addedUris = $derived([...selectedUris].filter((u) => !initialUris.has(u)));
  let removedUris = $derived([...initialUris].filter((u) => !selectedUris.has(u)));
  let changed = $derived(addedUris.length > 0 || removedUris.length > 0);

  let canSave = $derived.by(() => {
    if (membershipsLoading) return false;
    // Until this settles, the row whose membership IS the user's Saved entry is
    // unknown and must not be editable (or removable through "remove all").
    if (!saveBackingStore.loaded) return false;
    if (isEdit) return changed;
    return noCollection || selectedUris.size > 0;
  });

  let saveLabel = $derived(isEdit ? 'Update' : 'Save');

  // The list scrolls inside the modal, so its own edges have to say so. Without
  // this a row is sliced clean in half at the container edge and reads as a
  // rendering fault rather than as "there's more".
  let listEl = $state<HTMLDivElement | null>(null);
  let searchEl = $state<HTMLInputElement | null>(null);
  let moreAbove = $state(false);
  let moreBelow = $state(false);

  function measureScroll() {
    const el = listEl;
    if (!el) return;
    moreAbove = el.scrollTop > 2;
    moreBelow = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
  }

  // Re-measure whenever the rendered set changes (filtering, a refresh).
  $effect(() => {
    void filtered;
    measureScroll();
  });

  // A new filter starts from the top of its results, not wherever the full list
  // had been scrolled to.
  $effect(() => {
    void query;
    if (listEl) listEl.scrollTop = 0;
  });

  // Straight into the filter on a keyboard-and-mouse device. Not on touch: an
  // on-screen keyboard springing up over the list hides the quick picks, which
  // are the fastest path there.
  let autoFocused = false;
  $effect(() => {
    if (!open) {
      autoFocused = false;
      return;
    }
    if (!searchEl || autoFocused) return;
    autoFocused = true;
    if (
      typeof matchMedia === 'function' &&
      matchMedia('(hover: hover) and (pointer: fine)').matches
    )
      searchEl.focus();
  });

  const modKey =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

  /**
   * The running answer, read out beside the buttons so the choice is legible
   * without counting checkmarks — and without scrolling to find where the checked
   * rows went. In edit mode it's the pending diff.
   */
  let summary = $derived.by(() => {
    if (membershipsLoading || !saveBackingStore.loaded) return '';
    if (isEdit) {
      if (!changed) return 'No changes yet';
      const parts: string[] = [];
      if (addedUris.length > 0) parts.push(`${addedUris.length} added`);
      if (removedUris.length > 0) parts.push(`${removedUris.length} removed`);
      return parts.join(' · ');
    }
    if (noCollection) return 'Saving without a collection';
    const names = [...selectedUris]
      .map((u) => byUri.get(u))
      .filter((c): c is CollectionEntry => !!c)
      .map(collectionName);
    if (names.length === 0) return '';
    if (names.length <= 2) return names.join(', ');
    return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  });

  $effect(() => {
    if (open) {
      collectionsStore.loadAndRefresh(integration);
      saveBackingStore.load();
      loadMemberships(integration, url);
    } else {
      // Reset picker state when modal closes.
      membershipRequestId += 1;
      searchQuery = '';
      selectedUris = new Set();
      keptUris = new Set();
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
    if (!target || (typeof navigator !== 'undefined' && !navigator.onLine)) {
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
      // The list is live while this is in flight, so a fast reader may already
      // have tapped a quick pick. Keep those picks: add the existing memberships
      // to them rather than replace them.
      if (res.memberships.length > 0) {
        const existing = res.memberships.map((m) => m.collectionUri);
        selectedUris = new Set([...selectedUris, ...existing]);
        keptUris = new Set([...keptUris, ...existing]);
      }
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
    const next = new Set(selectedUris);
    if (next.has(uri)) {
      next.delete(uri);
    } else {
      next.add(uri);
      noCollection = false;
      if (!keptUris.has(uri)) keptUris = new Set([...keptUris, uri]);
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
    const collections: CollectionSelection[] = [];
    for (const uri of selectedUris) {
      const col = byUri.get(uri);
      if (col) collections.push({ uri: col.uri, cid: col.cid });
    }
    onconfirm({ mode: 'create', collections });
  }

  function rows(): HTMLButtonElement[] {
    return listEl ? Array.from(listEl.querySelectorAll<HTMLButtonElement>('.collection-row')) : [];
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && searchQuery) {
      // First Escape clears the filter; only an empty one lets the modal close.
      e.preventDefault();
      e.stopPropagation();
      searchQuery = '';
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.isComposing) {
      e.preventDefault();
      if (!searching || !saveBackingStore.loaded) return;
      const top = filtered.find((c) => c.uri !== lockedUri);
      if (!top) return;
      toggleCollection(top.uri);
      // Clear for the next name: filing into three collections is three words.
      searchQuery = '';
    } else if (e.key === 'ArrowDown') {
      const first = rows()[0];
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  /** Arrow keys walk the rows; typing from a row goes back to the filter. */
  function handleListKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (!target.classList.contains('collection-row')) return;
    const all = rows();
    const at = all.indexOf(target as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = at + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) searchEl?.focus();
      else all[Math.min(next, all.length - 1)]?.focus();
    } else if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Focus moves before the key lands, so the character types into the filter.
      searchEl?.focus();
    }
  }

  function handleWindowKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#snippet star(filled: boolean, size: number)}
  <span class="star" class:filled><Icon name="star" {size} strokeWidth={1.9} /></span>
{/snippet}

<!--
  One row of the full list. The row itself is the checkbox; the star beside it is
  a separate button, so starring never toggles membership.
-->
{#snippet collectionRow(collection: CollectionEntry)}
  {@const checked = selectedUris.has(collection.uri)}
  {@const locked = collection.uri === lockedUri}
  {@const fav = isFavorite(collection.uri)}
  {@const parts = nameParts(collection)}
  <div class="row-wrap" class:selected={checked} class:locked class:fav>
    <button
      class="collection-row"
      role="checkbox"
      aria-checked={checked}
      aria-disabled={locked}
      onclick={() => toggleCollection(collection.uri)}
      disabled={!saveBackingStore.loaded}
      type="button"
    >
      <span class="tile" aria-hidden="true">
        {#if checked}
          <span class="tile-check"><Icon name="check" size={16} /></span>
        {:else}
          {monogram(collection)}
        {/if}
      </span>
      <span class="collection-info">
        <span class="collection-line">
          <span class="collection-name">
            {#if parts}{parts[0]}<mark>{parts[1]}</mark>{parts[2]}{:else}{collectionName(
                collection
              )}{/if}
          </span>
          {#if locked}
            <span class="backing-pill">
              <Icon name="bookmark" size={11} />
              Saved list
            </span>
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
      </span>
    </button>
    {#if !locked}
      <button
        class="fav-btn"
        class:on={fav}
        aria-pressed={fav}
        aria-label={`Favorite ${collectionName(collection)}`}
        title={fav ? 'Remove from quick picks' : 'Keep in quick picks'}
        onclick={() => collectionsStore.toggleFavorite(collection.uri)}
        type="button"
      >
        {@render star(fav, 15)}
      </button>
    {/if}
  </div>
{/snippet}

<Modal {open} {onclose} maxWidth="520px" bodyPadding="0.75rem 1.5rem 1rem">
  {#snippet header()}
    <!--
      One line: what this is, and where the article already stands. The status
      used to be a sentence of its own under a full-size title; together they
      spent a fifth of the modal before the first collection.
    -->
    <div class="picker-head">
      <span class="head-mark" aria-hidden="true"><Icon name={integration} size={18} /></span>
      <h2 class="head-title">
        {isEdit ? `Saved to ${integrationName}` : `Save to ${integrationName}`}
      </h2>
      <span class="head-status" aria-live="polite">
        {#if membershipsLoading}
          <span class="pulse-dot" aria-hidden="true"></span>Checking existing saves…
        {:else if isEdit}
          {initialUris.size === 0
            ? 'No collection yet'
            : `In ${initialUris.size} collection${initialUris.size === 1 ? '' : 's'}`}
        {/if}
      </span>
      <button class="head-close" onclick={onclose} aria-label="Close" type="button">
        <Icon name="x" size={18} />
      </button>
    </div>
  {/snippet}

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
          <span>{loadError}</span>
        </p>
      {:else if isOffline}
        <p class="notice notice-warn">
          <span class="notice-icon" aria-hidden="true"><Icon name="alert-circle" size={15} /></span>
          <span>Offline, showing cached collections. Your save will go out when you're back.</span>
        </p>
      {/if}

      {#if isEdit && memberships?.truncated}
        <p class="notice notice-quiet">Some older saves may not be shown.</p>
      {/if}
      {#if membershipsLoading || isEdit}
        <!-- the status lives in the header -->
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
            bind:this={searchEl}
            type="text"
            placeholder={list.length > 1
              ? `Filter ${list.length} collections`
              : 'Filter collections'}
            bind:value={searchQuery}
            onkeydown={handleSearchKeydown}
            class="search-input"
            aria-label="Filter collections"
            autocomplete="off"
            spellcheck="false"
          />
          {#if searchQuery}
            <button
              class="search-clear"
              onclick={() => {
                searchQuery = '';
                searchEl?.focus();
              }}
              aria-label="Clear filter"
              type="button"
            >
              <Icon name="x" size={14} />
            </button>
          {:else if isRefreshing}
            <span class="refreshing-badge" aria-live="polite">Refreshing…</span>
          {/if}
        </div>
      {/if}

      {#if !searching && list.length > 0}
        {#if quickPicks.length > 0}
          <div class="quick" role="group" aria-label="Quick picks">
            {#each quickPicks as collection (collection.uri)}
              {@const checked = selectedUris.has(collection.uri)}
              {@const fav = isFavorite(collection.uri)}
              <button
                class="chip"
                class:on={checked}
                aria-pressed={checked}
                title={fav
                  ? 'Favorite'
                  : collection.lastUsedAt
                    ? `Used ${formatRelativeTime(collection.lastUsedAt)}`
                    : undefined}
                onclick={() => toggleCollection(collection.uri)}
                disabled={!saveBackingStore.loaded}
                type="button"
              >
                {#if checked}
                  <span class="chip-glyph"><Icon name="check" size={13} strokeWidth={2.25} /></span>
                {:else if fav}
                  <span class="chip-glyph">{@render star(true, 12)}</span>
                {:else}
                  <span class="chip-glyph chip-glyph-recent">
                    <Icon name="clock" size={12} strokeWidth={2} />
                  </span>
                {/if}
                <span class="chip-label">{collectionName(collection)}</span>
              </button>
            {/each}
          </div>
        {/if}
        {#if !hasFavorites && list.length >= 6}
          <p class="quick-hint">
            Star the collections you file into most and they'll wait up here.
          </p>
        {/if}
      {/if}

      <!--
        Create mode this is a checkbox ("No collection", on or off). Edit mode it
        is a one-shot action ("Remove from all collections") that clears the
        selection and never sets noCollection, so it keeps plain button
        semantics — a checkbox permanently announcing "not checked" would report
        a state that never changes.
      -->
      {#if !searching}
        <button
          class="no-collection"
          class:selected={!isEdit && noCollection}
          role={isEdit ? undefined : 'checkbox'}
          aria-checked={isEdit ? undefined : noCollection}
          onclick={toggleNoCollection}
          disabled={!saveBackingStore.loaded}
          type="button"
        >
          <span class="tile tile-none" aria-hidden="true">
            {#if !isEdit && noCollection}
              <span class="tile-check"><Icon name="check" size={14} /></span>
            {:else}
              <Icon name="minus" size={13} />
            {/if}
          </span>
          <span class="no-collection-label">
            {isEdit && initialUris.size > 0 ? 'Remove from all collections' : 'No collection'}
          </span>
        </button>
      {/if}

      {#if !noListing}
        <div class="list-head">
          <span class="band-label">{searching ? 'Matches' : 'All collections'}</span>
          <span class="list-count" aria-live="polite">
            {searching ? `${filtered.length} of ${list.length}` : list.length}
          </span>
        </div>

        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="collections-list"
          class:more-above={moreAbove}
          class:more-below={moreBelow}
          bind:this={listEl}
          onscroll={measureScroll}
          onkeydown={handleListKeydown}
        >
          {#if filtered.length === 0}
            <div class="empty-state">
              {#if searching}
                <p class="empty-title">No collection matches “{searchQuery.trim()}”</p>
                <p class="empty-hint">
                  {#if listingShort}
                    It may be past the ones Skyreader could load. Make or find it in {integrationName}.
                  {:else}
                    Try a shorter word, or save without a collection.
                  {/if}
                </p>
              {:else}
                <p class="empty-title">No collections in {integrationName} yet</p>
                <p class="empty-hint">Make one there and it will show up here.</p>
              {/if}
            </div>
          {:else}
            {#each filtered as collection (collection.uri)}
              {@render collectionRow(collection)}
            {/each}
            {#if listingShort && !searching}
              <p class="list-foot">
                Showing the first {list.length.toLocaleString()} collections from {integrationName}.
              </p>
            {/if}
          {/if}
        </div>
        {#if searching && filtered.length > 0}
          <p class="kbd-hint" aria-hidden="true">
            <kbd>↵</kbd> adds the top match · <kbd>↓</kbd> to browse · <kbd>{modKey}</kbd><kbd
              >↵</kbd
            > saves
          </p>
        {/if}
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    <!-- always present so the live region can announce a change into it -->
    <span class="footer-summary" aria-live="polite">{summary}</span>
    <button class="btn btn-secondary" onclick={onclose} type="button">Cancel</button>
    <button
      class="btn btn-primary"
      onclick={handleSave}
      disabled={!canSave}
      type="button"
      title={`${saveLabel} (${modKey}+Enter)`}
    >
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

  .notice-quiet {
    padding: 0 0.125rem 0.625rem;
    font-size: var(--text-sm);
  }

  /* ── Header ──────────────────────────────────────────────── */
  .picker-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.75rem 0.625rem 0 1.5rem;
  }

  .head-mark {
    display: flex;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .head-title {
    margin: 0;
    flex-shrink: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .head-status {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .head-close {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .head-close:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .head-close:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .notice-warn,
  .notice-error {
    padding: 0.5rem 0.625rem;
    border-radius: 6px;
    background: var(--color-bg-secondary);
    margin-bottom: 0.625rem;
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

  .pulse-dot {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    margin: 0 0.25rem;
    border-radius: 50%;
    background: var(--color-primary);
    animation: skeleton-pulse 1.2s ease-in-out infinite;
  }

  /* ── Filter ──────────────────────────────────────────────── */
  .search-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.375rem 0 0.75rem;
    height: 2.5rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }

  .search-row:focus-within {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-sidebar-active);
  }

  .search-icon {
    color: var(--color-text-secondary);
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .search-input {
    flex: 1;
    align-self: stretch;
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

  .search-clear {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .search-clear:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .search-clear:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .refreshing-badge {
    padding-right: 0.375rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  /* ── Quick picks ─────────────────────────────────────────────
     Favorites, then the recently used: the whole point of the picker
     for most saves, so they sit above the list as one-tap toggles.
     Chip shape per DESIGN.md (sunken pill, wash-blue when on), sized
     up to a comfortable tap target. */
  .quick {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-top: 0.75rem;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    max-width: 100%;
    min-height: 1.875rem;
    padding: 0.25rem 0.75rem 0.25rem 0.5625rem;
    border: 1px solid transparent;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    color: var(--color-text);
    font-family: inherit;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    line-height: var(--leading-none);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .chip:hover {
    background: color-mix(in srgb, var(--color-text) 9%, var(--color-bg));
  }

  .chip.on {
    background: var(--color-sidebar-active);
    border-color: color-mix(in srgb, var(--color-primary) 35%, transparent);
    color: var(--color-primary);
  }

  .chip.on:hover {
    background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  }

  .chip:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .chip:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .chip-glyph {
    display: flex;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .chip.on .chip-glyph {
    color: var(--color-primary);
  }

  .chip-glyph-recent {
    opacity: 0.8;
  }

  .chip-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* long names shouldn't turn one chip into a full-width bar */
    max-width: 16rem;
  }

  .quick-hint {
    margin-top: 0.625rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  /* ── Star ────────────────────────────────────────────────── */
  .star {
    display: flex;
  }

  .star.filled :global(polygon) {
    fill: currentColor;
  }

  /* ── No collection ─────────────────────────────────────────── */
  .no-collection {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    align-self: flex-start;
    margin-top: 0.75rem;
    padding: 0.3125rem 0.625rem 0.3125rem 0.3125rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    font-family: inherit;
    font-size: var(--text-md);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .no-collection:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .no-collection.selected {
    background: var(--color-sidebar-active);
    color: var(--color-primary);
  }

  .no-collection:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .no-collection:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .no-collection .tile {
    width: 22px;
    height: 22px;
    border-radius: 6px;
  }

  /* ── List ────────────────────────────────────────────────── */
  .list-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.75rem;
    padding: 0.625rem 0.5rem 0.375rem;
    border-top: 1px solid var(--color-border);
  }

  .band-label {
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  .list-count {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .collections-list {
    max-height: 42vh;
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

  /* ── Rows ────────────────────────────────────────────────────
     The tile is both the collection's mark and its checkbox: at rest
     it carries the name's initial (a scan anchor in a long list), and
     selecting flips it to the wash-blue check. One element, two jobs,
     so a row of twenty reads as a list rather than a form. */
  .row-wrap {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    border-radius: 8px;
    transition: background-color 0.15s ease;
    /* A catalog can run to hundreds of rows; let the browser skip laying out
       the ones scrolled out of view. */
    content-visibility: auto;
    contain-intrinsic-size: auto 46px;
  }

  .row-wrap:hover {
    background: var(--color-bg-secondary);
  }

  .row-wrap.selected {
    background: var(--color-sidebar-active);
  }

  .row-wrap.selected:hover {
    background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  }

  .row-wrap.locked:hover {
    background: none;
  }

  .row-wrap.locked.selected,
  .row-wrap.locked.selected:hover {
    background: var(--color-sidebar-active);
  }

  .collection-row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4375rem 0.25rem 0.4375rem 0.5rem;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;
    border-radius: 8px;
    color: var(--color-text);
    font-family: inherit;
  }

  .collection-row:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .row-wrap.locked .collection-row {
    cursor: default;
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

  .row-wrap.selected .tile,
  .no-collection.selected .tile {
    background: var(--color-sidebar-active);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .tile-none {
    color: inherit;
    border-style: dashed;
    background: none;
  }

  .no-collection.selected .tile-none {
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

  .collection-name mark {
    background: none;
    color: var(--color-primary);
    font-weight: var(--weight-semibold);
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

  /* The star rests hidden on an unstarred row until the row is pointed at or
     focused, so a long list reads as names, not as a column of outlines. A
     starred row always shows it. Touch has no hover, so there it stays faintly
     visible. */
  .fav-btn {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    margin-right: 0.125rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    opacity: 0;
    transition:
      opacity 0.15s ease,
      color 0.15s ease;
  }

  .row-wrap:hover .fav-btn,
  .row-wrap:focus-within .fav-btn {
    opacity: 0.7;
  }

  .fav-btn:hover {
    opacity: 1 !important;
    color: var(--color-text);
  }

  .fav-btn.on {
    opacity: 1;
    color: var(--color-text);
  }

  .fav-btn:focus-visible {
    opacity: 1;
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  @media (hover: none) {
    .fav-btn {
      opacity: 0.4;
    }
  }

  .list-foot {
    padding: 0.625rem 0.5rem 0.25rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .kbd-hint {
    padding: 0.5rem 0.5rem 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  kbd {
    display: inline-block;
    min-width: 1.25em;
    padding: 0 0.3em;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-family: inherit;
    font-size: var(--text-2xs);
    line-height: 1.5;
    text-align: center;
  }

  kbd + kbd {
    margin-left: 0.125rem;
  }

  @media (hover: none) {
    .kbd-hint {
      display: none;
    }
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
    overflow-wrap: anywhere;
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
    flex: 1;
    min-width: 0;
    align-self: center;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .btn {
    flex-shrink: 0;
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

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .search-input {
      font-size: 1rem;
    }
  }

  @media (max-width: 640px) {
    .collection-name {
      font-size: var(--text-base);
    }

    /* One swipeable line of chips rather than a wrapped block that pushes the
       list below the fold. Bleeds to the modal edge so the cut reads as "more". */
    .quick {
      flex-wrap: nowrap;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
      margin-inline: -1.5rem;
      padding-inline: 1.5rem;
      scroll-padding-inline: 1.5rem;
    }

    .quick::-webkit-scrollbar {
      display: none;
    }

    .chip {
      flex-shrink: 0;
    }

    .collections-list {
      max-height: 46vh;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .row-wrap,
    .chip,
    .no-collection,
    .fav-btn,
    .tile,
    .search-row,
    .btn {
      transition: none;
    }

    .tile-check {
      animation: none;
    }

    .skeleton-row,
    .pulse-dot {
      animation: none;
      opacity: 0.7;
    }
  }
</style>
