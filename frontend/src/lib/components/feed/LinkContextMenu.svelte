<script lang="ts" module>
  import type { IntegrationStatus } from '$lib/types';

  // Which of Semble and Margin this session may read, asked once a page load:
  // a membership lookup without the scope answers 403, and that raises the
  // app-wide "needs your permission" banner for a reader who only tapped a
  // link. A scope upgrade is a sign-in round trip, which reloads the page.
  let scopes: Promise<IntegrationStatus['scopeStatus'] | null> | null = null;
</script>

<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import SaveToLibraryPanel from '$lib/components/shelf/SaveToLibraryPanel.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { linkTitleHint } from '$lib/utils/articleLinks';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { shelfStore } from '$lib/stores/shelf.svelte';
  import { keyboardStore } from '$lib/stores/keyboard.svelte';
  import { integrationSaveStore } from '$lib/stores/integrationSave.svelte';
  import {
    sembleConnectionStore,
    type SembleConnectionSource,
  } from '$lib/stores/sembleConnection.svelte';
  import { sameArticle } from '$lib/stores/recentReads.svelte';
  import type { IntegrationKind } from '$lib/stores/collections.svelte';
  import { api, UrlSaveLimitError } from '$lib/services/api';
  import { saveLimitLine } from '$lib/utils/limitCopy';
  import { failedSaveLine, blockedSaveAction, extensionCanHelp } from '$lib/utils/saveAnywhere';
  import { deskEntryFor, deskStore } from '$lib/stores/desk.svelte';
  import { DESK_LIMIT, type DeskEntry } from '$lib/utils/desk';
  import { savedItemDisplayKey } from '$lib/utils/dailyMagazine';
  import type { SavedItem } from '$lib/types';

  interface Props {
    url: string;
    linkText: string;
    anchorRect: DOMRect;
    /** The page this link sits in, to connect it to on Semble: the article a
     *  cited link appears in, or the save a New connections tile is about.
     *  Absent where there's nothing to connect from. */
    connectFrom?: SembleConnectionSource;
    /** The article this link sits in, kept on a save made from here as where it
     *  came from ("From …"). Absent where the link isn't in an article. */
    savedFrom?: { url: string; title?: string };
    /** The menu item's wording; "Connect on Semble…" by default. */
    connectLabel?: string;
    onClose: () => void;
  }

  let {
    url,
    linkText,
    anchorRect,
    connectFrom,
    savedFrom,
    connectLabel = 'Connect on Semble…',
    onClose,
  }: Props = $props();

  let menuEl = $state<HTMLDivElement | null>(null);
  let copyState = $state<'idle' | 'copied'>('idle');
  let placed = $state(false);

  // Only a web page can be saved or collected: a mailto:, tel: or in-page
  // anchor still opens and copies, but a save would fetch nothing.
  let webUrl = $derived.by(() => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
    } catch {
      return null;
    }
  });

  let host = $derived(webUrl ? webUrl.hostname.replace(/^www\./, '') : '');

  // The header leads with where the link goes; the link's own text sits under
  // it when it says something the host doesn't (not a bare URL, not empty).
  let label = $derived.by(() => {
    const t = linkText.trim();
    if (t && !/^(https?:\/\/|www\.)/i.test(t)) return t;
    if (!webUrl) return url;
    const path = webUrl.pathname + webUrl.search;
    if (path === '/') return '';
    // A stray `%` (e.g. /100%-off) or a non-UTF-8 escape passes URL parsing
    // but makes decodeURIComponent throw; show the raw path instead.
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  });

  let canSave = $derived(!!webUrl && !auth.isGuest);
  let alreadySaved = $derived(canSave && savesStore.isSaved(url));

  // Save turns the menu into the reader's Save panel (Shelf, collections,
  // Remove), the one the feed card's and the reader's Save buttons open, in
  // the same box: Back returns to the link's actions.
  let panelOpen = $state(false);
  // Save was pressed and its row hasn't landed: the panel says "Saving…".
  let saving = $state(false);
  let panelSave = $derived(panelOpen ? savesStore.find(url) : undefined);
  // For picks made before the save lands; read only while the panel is up.
  let landingKey = $derived(panelOpen ? url : undefined);

  // Where a saved link is kept, for the header's quiet status line.
  let savedRow = $derived(alreadySaved && !panelOpen ? savesStore.find(url) : undefined);
  let keptLine = $derived.by(() => {
    if (!savedRow) return '';
    const n = shelfStore.collectionIdsFor(savedRow).length;
    if (n > 0) return `In ${collectionCount(n)}`;
    return shelfStore.isOnShelf(savedRow) ? 'On your Shelf' : 'In your Queue';
  });
  // Closed (the host is clearing its state, so the props throw from here on)
  // or gone.
  let destroyed = false;

  function closePanel() {
    if (destroyed) return;
    destroyed = true;
    // panelSave stops reading the url before the host clears it.
    panelOpen = false;
    onClose();
  }

  // Whether the link is already in the reader's Semble or Margin, and in how
  // many collections there: read live, as the collection picker does, so the
  // rows say "Saved" before the picker opens on an edit. Unknown (null) until
  // it answers, or when it can't (offline, no scope): the row then just offers
  // to save, as it always has.
  type Stored = { collections: number } | null;
  let stored = $state<Record<IntegrationKind, Stored | undefined>>({
    semble: undefined,
    margin: undefined,
  });

  function collectionCount(n: number): string {
    return `${n} ${n === 1 ? 'collection' : 'collections'}`;
  }

  async function lookUpStored(kind: IntegrationKind, link: string) {
    try {
      scopes ??= api
        .getIntegrationStatus()
        .then((status) => status.scopeStatus)
        .catch(() => {
          scopes = null; // Ask again next time.
          return null;
        });
      if (!(await scopes)?.[kind] || destroyed) return;
      const res = await api.getIntegrationMemberships(kind, link);
      if (destroyed) return;
      // Two cards for one page can sit in the same collection: count it once.
      const collections = new Set(res.memberships.map((m) => m.collectionUri)).size;
      stored[kind] = res.items.length > 0 ? { collections } : null;
    } catch {
      // Left unknown: the row offers to save, and the picker reads it again.
    }
  }
  // The Desk (stores/desk.svelte.ts) names a piece by its reader key, and only
  // a save resolves from a key after a reload, so a link goes on the Desk as a
  // save: saved first when it isn't yet, then put on.
  let deskKey = $derived.by(() => {
    const save = canSave ? savesStore.find(url) : undefined;
    return save ? savedItemDisplayKey(save) : null;
  });
  let onDesk = $derived(deskKey !== null && deskStore.has(deskKey));
  let deskFull = $derived(!onDesk && deskStore.entries.length >= DESK_LIMIT);
  const deskFullLine = `The Desk holds ${DESK_LIMIT}. Take one off first.`;

  function deskEntryForSave(save: SavedItem, source: string): DeskEntry {
    return deskEntryFor(
      { type: 'saved', item: save, key: savedItemDisplayKey(save) },
      save.domain?.replace(/^www\./, '') || source
    );
  }

  // A connection is written from the reader's account, as every other way into
  // the dialog requires; between two web pages (a document can fall back to a
  // bare path); and a page can't be connected to itself.
  let canConnect = $derived(
    !!webUrl &&
      !!auth.user &&
      !!connectFrom?.url &&
      /^https?:\/\//i.test(connectFrom.url) &&
      !sameArticle(url, connectFrom.url)
  );

  function handleOpenInNewTab() {
    window.open(url, '_blank', 'noopener');
    onClose();
  }

  // Link text makes a fallback title for a save whose page can't be fetched,
  // but only when it reads like one: not a bare URL, not "here" or "this".
  const titleHint = linkTitleHint;

  // Save, then show the Save panel in the menu's place; a saved link opens
  // it straight away, to file it or take it out.
  function handleOpenPanel() {
    // Copy link is about to close the menu: a panel opened now would go with it.
    if (copyState === 'copied') return;
    panelOpen = true;
    // A save still on its way (Back, then Save again) is the same save.
    if (!alreadySaved && !saving) save();
    void tick().then(() => positionMenu(false));
  }

  // Back to the link's actions; a save made on the way stays made.
  function backToMenu() {
    panelOpen = false;
    void tick().then(() => positionMenu());
  }

  // The props are read up front, as in handleCollect: once the menu or panel
  // closes, the host clears its state and they throw.
  function save() {
    const saveUrl = url;
    const title = titleHint(linkText);
    const from = savedFrom?.url ? { url: savedFrom.url, title: savedFrom.title } : undefined;
    const settle = () => toastStore.add('');
    saving = true;
    savesStore
      .saveFromUrl(saveUrl, { title, from })
      .then((saved) => {
        // Only the link was kept: say so, and offer the way to the full text.
        if (saved.fetchFailed) {
          toastStore.update(
            settle(),
            'success',
            failedSaveLine(saved.fetchFailed),
            extensionCanHelp(saved.fetchFailed) ? blockedSaveAction() : undefined
          );
        } else if (destroyed) {
          // The panel that would have said so is gone.
          toastStore.update(settle(), 'success', 'Saved to your Queue');
        }
      })
      .catch((err) => {
        // The panel goes with the save; the link's actions, if that's where the
        // reader went back to, stay.
        if (panelOpen) closePanel();
        const id = settle();
        // The monthly save cap has a reason and a way out, so it says so
        // instead of hiding behind a generic failure.
        if (err instanceof UrlSaveLimitError) {
          toastStore.update(id, 'error', saveLimitLine(err.limit, err.resetsAt), {
            label: 'Become a Supporter',
            href: '/supporter',
          });
          return;
        }
        toastStore.update(id, 'error', 'Failed to save article');
      })
      .finally(() => {
        saving = false;
      });
  }

  // Put the link on the Desk, saving it first when it isn't saved; or take it
  // off. The menu closes at once: a save can take a few seconds, and the toast
  // says when it's there. Props are read up front, as in save().
  function handleDesk() {
    if (copyState === 'copied') return;
    if (onDesk && deskKey) {
      deskStore.remove(deskKey);
      closePanel();
      return;
    }
    if (deskFull) {
      toastStore.update(toastStore.add(''), 'error', deskFullLine);
      return;
    }
    const saveUrl = url;
    const source = host;
    const existing = savesStore.find(saveUrl);
    if (existing) {
      const added = deskStore.add(deskEntryForSave(existing, source));
      closePanel();
      if (added) toastStore.update(toastStore.add(''), 'success', 'Added to your Desk');
      return;
    }
    const title = titleHint(linkText);
    const from = savedFrom?.url ? { url: savedFrom.url, title: savedFrom.title } : undefined;
    closePanel();
    const id = toastStore.add('Saving to your Desk…');
    savesStore
      .saveFromUrl(saveUrl, { title, from })
      .then((saved) => {
        const row = savesStore.find(saveUrl) ?? (saved.url ? saved : undefined);
        const added = row ? deskStore.add(deskEntryForSave(row, source)) : false;
        if (saved.fetchFailed) {
          toastStore.update(
            id,
            'success',
            failedSaveLine(saved.fetchFailed),
            extensionCanHelp(saved.fetchFailed) ? blockedSaveAction() : undefined
          );
        } else {
          toastStore.update(
            id,
            'success',
            added ? 'Saved and added to your Desk' : 'Saved to your Queue'
          );
        }
      })
      .catch((err) => {
        if (err instanceof UrlSaveLimitError) {
          toastStore.update(id, 'error', saveLimitLine(err.limit, err.resetsAt), {
            label: 'Become a Supporter',
            href: '/supporter',
          });
          return;
        }
        toastStore.update(id, 'error', 'Failed to save article');
      });
  }

  function unsaveFromPanel() {
    const save = panelSave;
    closePanel();
    if (!save) return;
    savesStore.remove(save.rkey).catch(() => {
      toastStore.update(toastStore.add(''), 'error', 'Could not remove that save');
    });
  }

  // Unsaved some other way while the panel is up (another device): nothing
  // left to file.
  $effect(() => {
    if (panelOpen && !saving && !panelSave) closePanel();
  });

  // While the panel is up, its keys are its own: j/k mustn't move the page.
  $effect(() => {
    if (!panelOpen) return;
    return keyboardStore.suspend();
  });

  // Hand the link to the one app-wide collection picker, which reads the URL's
  // existing memberships, so a link already in a collection opens as an edit.
  // Read the props before closing: the host clears its menu state on close, and
  // these props read through to it, so afterwards they throw instead of answering.
  function handleCollect(kind: IntegrationKind) {
    const target = { url, title: titleHint(linkText) };
    onClose();
    integrationSaveStore.openPicker(kind, target);
  }

  // The cited link is the other end, already filled; the reader picks how the
  // two relate. Props are read before closing, as in handleCollect.
  function handleConnect() {
    const source = connectFrom;
    if (!source) return;
    const target = { url, title: titleHint(linkText) };
    onClose();
    sembleConnectionStore.openFor(source, { target });
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      copyState = 'copied';
      setTimeout(onClose, 600);
    } catch {
      copyState = 'idle';
    }
  }

  function menuItems(): HTMLButtonElement[] {
    return menuEl ? Array.from(menuEl.querySelectorAll<HTMLButtonElement>('.menu-item')) : [];
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePanel();
      return;
    }
    // The panel's boxes and fields take their own keys.
    if (panelOpen) return;
    // One order for every key: the side-by-side buttons sit in it left to right.
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    if (!forward && !back && e.key !== 'Home' && e.key !== 'End') return;
    const items = menuItems().filter((b) => !b.disabled);
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (forward) next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    items[next].focus();
  }

  function handleClickOutside(e: MouseEvent) {
    if (menuEl && !menuEl.contains(e.target as Node)) {
      closePanel();
    }
  }

  function positionMenu(focus = true) {
    if (!menuEl) return;
    const gap = 8;
    // With a phone's keyboard up, the visible strip is above the keys.
    const viewport = window.visualViewport;
    const visibleTop = viewport ? viewport.offsetTop : 0;
    const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    // The Save panel never runs off the visible screen: it scrolls inside.
    menuEl.style.maxHeight = panelOpen ? `${visibleBottom - visibleTop - 2 * gap}px` : '';
    const menuRect = menuEl.getBoundingClientRect();

    // Below the link by default, above it when there's no room, and pinned
    // inside the viewport when neither side fits.
    let top: number;
    if (anchorRect.bottom + gap + menuRect.height <= visibleBottom - gap) {
      top = anchorRect.bottom + gap / 2;
    } else if (anchorRect.top - gap - menuRect.height >= visibleTop + gap) {
      top = anchorRect.top - gap / 2 - menuRect.height;
    } else {
      top = Math.max(visibleTop + gap, visibleBottom - menuRect.height - gap);
    }

    // The visible strip's edges too: a page wider than the phone's screen
    // makes the layout viewport wider than what can be seen.
    const visibleLeft = viewport ? viewport.offsetLeft : 0;
    const visibleRight = viewport ? viewport.offsetLeft + viewport.width : window.innerWidth;
    let left = Math.min(anchorRect.left, visibleRight - menuRect.width - gap);
    left = Math.max(visibleLeft + gap, left);

    menuEl.style.top = `${top}px`;
    menuEl.style.left = `${left}px`;
    placed = true;
    // Focus without a ring on tap (:focus-visible), so arrow keys work at once.
    if (focus) menuItems()[0]?.focus({ preventScroll: true });
  }

  // Any scroll puts the menu away. With the panel up, only a scroll gesture
  // outside it does: the page also scrolls on its own (a phone lifting a
  // focused field above its keyboard), and the panel's list scrolls.
  function handleScroll() {
    if (!panelOpen) closePanel();
  }

  // The panel grows as collections load and the save lands, and a phone's
  // keyboard shrinks the room it has: place it again, and keep the field being
  // typed in visible (iOS won't scroll it into view inside a fixed box).
  function replacePanel() {
    if (!panelOpen) return;
    positionMenu(false);
    const field = document.activeElement;
    if (field instanceof HTMLInputElement && field.type !== 'checkbox' && menuEl?.contains(field)) {
      field.scrollIntoView({ block: 'nearest' });
    }
  }

  $effect(() => {
    if (!panelOpen || !menuEl || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => replacePanel());
    observer.observe(menuEl);
    return () => observer.disconnect();
  });

  function handleScrollGesture(e: Event) {
    if (panelOpen && menuEl && !menuEl.contains(e.target as Node)) closePanel();
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('click', handleClickOutside, true);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('wheel', handleScrollGesture, { capture: true, passive: true });
    document.addEventListener('touchmove', handleScrollGesture, { capture: true, passive: true });
    window.visualViewport?.addEventListener('resize', replacePanel);
    window.visualViewport?.addEventListener('scroll', replacePanel);
    requestAnimationFrame(() => positionMenu());
    // For the saved link's status line: which collections hold it.
    if (alreadySaved) void shelfStore.load();
    // Semble and Margin write to the reader's own repo, so only an account
    // has anything there to find.
    if (canSave && auth.user && navigator.onLine) {
      const link = url;
      void lookUpStored('semble', link);
      void lookUpStored('margin', link);
    }
  });

  onDestroy(() => {
    destroyed = true;
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('click', handleClickOutside, true);
    document.removeEventListener('scroll', handleScroll, true);
    document.removeEventListener('wheel', handleScrollGesture, true);
    document.removeEventListener('touchmove', handleScrollGesture, true);
    window.visualViewport?.removeEventListener('resize', replacePanel);
    window.visualViewport?.removeEventListener('scroll', replacePanel);
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="link-menu"
  class:placed
  class:wide={panelOpen}
  role={panelOpen ? undefined : 'menu'}
  aria-label={panelOpen ? undefined : 'Link actions'}
  tabindex="-1"
  bind:this={menuEl}
  onclick={(e) => e.stopPropagation()}
>
  {#if panelOpen}
    <SaveToLibraryPanel
      inline
      save={panelSave}
      anchorEl={null}
      onBack={backToMenu}
      backLabel="Back to link actions"
      {landingKey}
      onUnsave={unsaveFromPanel}
      onClose={closePanel}
    />
  {:else}
    <div class="link-head" title={url}>
      {#if host}
        <div class="link-host">
          <Icon name="globe" size={12} />
          <span>{host}</span>
        </div>
      {/if}
      {#if label}
        <div class="link-label">{label}</div>
      {/if}
      {#if keptLine}
        <div class="link-kept">
          <Icon name="check" size={12} />
          <span>{keptLine}</span>
        </div>
      {/if}
    </div>

    <!-- The two quick ones side by side: everything else is a row of its own. -->
    <div class="menu-pair">
      <button
        class="menu-item tile"
        role="menuitem"
        title="Open in a new tab"
        onclick={handleOpenInNewTab}
      >
        <Icon name="external-link" size={16} />
        <span>Open link</span>
      </button>
      <button
        class="menu-item tile"
        class:done={copyState === 'copied'}
        role="menuitem"
        onclick={handleCopy}
      >
        <Icon name={copyState === 'copied' ? 'check' : 'copy'} size={16} />
        <span>{copyState === 'copied' ? 'Copied' : 'Copy link'}</span>
      </button>
    </div>

    {#if canSave}
      <!-- A URL save runs server-side extraction, and Semble/Margin write to the
         reader's own repo — both need a session, so guests don't see them. -->
      <div class="menu-group">
        <button class="menu-item" role="menuitem" onclick={handleOpenPanel}>
          <Icon name="bookmark" size={16} />
          <span>{alreadySaved ? 'Edit save…' : saving ? 'Saving…' : 'Save to Skyreader'}</span>
        </button>
        <button
          class="menu-item"
          class:done={onDesk}
          role="menuitem"
          title={onDesk ? 'On your Desk: tap to take it off' : undefined}
          onclick={handleDesk}
        >
          <Icon name={onDesk ? 'check' : 'layers'} size={16} />
          <span>{onDesk ? 'On your Desk' : 'Add to Desk'}</span>
          {#if onDesk}
            <span class="hint">Take off</span>
          {:else if deskFull}
            <span class="hint">Full</span>
          {/if}
        </button>
      </div>

      <div class="menu-also" role="group" aria-labelledby="link-menu-also">
        <span class="also-label" id="link-menu-also">Save to</span>
        {#each [{ kind: 'semble', name: 'Semble' }, { kind: 'margin', name: 'Margin' }] as const as row (row.kind)}
          {@const there = stored[row.kind]}
          <button
            class="menu-item chip"
            class:done={Boolean(there)}
            role="menuitem"
            aria-haspopup="dialog"
            aria-label={there
              ? `Saved to ${row.name}${there.collections > 0 ? `, in ${collectionCount(there.collections)}` : ''}`
              : `Save to ${row.name}…`}
            title={there && there.collections > 0
              ? `In ${collectionCount(there.collections)} on ${row.name}`
              : undefined}
            onclick={() => handleCollect(row.kind)}
          >
            <Icon name={row.kind} size={14} />
            <span>{row.name}</span>
            {#if there}
              <Icon name="check" size={12} />
            {/if}
          </button>
        {/each}
      </div>
    {/if}

    {#if canConnect}
      <div class="menu-group">
        <button class="menu-item" role="menuitem" onclick={handleConnect}>
          <Icon name="link" size={16} />
          <span>{connectLabel}</span>
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .link-menu {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 200;
    /* One width, the Save panel's, whatever the rows say: the side-by-side
       buttons need it, and the box doesn't jump when it turns into the panel. */
    width: min(300px, calc(100vw - 16px));
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    overflow: hidden;
    outline: none;
    /* Measured before it's shown, so it never flashes at the corner. */
    visibility: hidden;
    opacity: 0;
    transform: translateY(-2px);
  }

  .link-menu.wide {
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .link-kept {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .link-kept :global(svg) {
    color: var(--color-primary, #0066cc);
  }

  .link-menu.placed {
    visibility: visible;
    opacity: 1;
    transform: none;
    transition:
      opacity 0.12s ease-out,
      transform 0.12s ease-out;
  }

  .link-head {
    padding: 10px 14px 8px;
    min-width: 0;
  }

  .link-host {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    min-width: 0;
  }

  .link-host span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link-label {
    margin-top: 2px;
    font-size: var(--text-sm);
    font-weight: 500;
    line-height: 1.4;
    color: var(--color-text);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  .menu-group {
    border-top: 1px solid var(--color-border);
    padding: 4px 0;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 14px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: var(--text-md);
    font-weight: 500;
    line-height: 1.4;
    color: var(--color-text);
    text-align: left;
    transition: background-color 0.15s;
  }

  .menu-item :global(svg) {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .menu-item:hover:not(:disabled),
  .menu-item:focus-visible {
    background: var(--color-bg-secondary);
    outline: none;
  }

  .menu-item.done,
  .menu-item.done :global(svg) {
    color: var(--color-primary, #0066cc);
  }

  .hint {
    margin-left: auto;
    padding-left: 12px;
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--color-text-secondary);
  }

  .menu-item:disabled {
    cursor: default;
  }

  .menu-item > span:not(.hint) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Open and Copy: two halves of one row. */
  .menu-pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    padding: 4px 6px 6px;
  }

  .menu-item.tile {
    justify-content: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--color-bg-secondary);
    font-size: var(--text-sm);
  }

  .menu-item.tile:hover:not(:disabled),
  .menu-item.tile:focus-visible {
    background: var(--color-border);
  }

  /* Semble and Margin: where else to keep it, on one line. */
  .menu-also {
    display: flex;
    align-items: center;
    gap: 6px;
    border-top: 1px solid var(--color-border);
    padding: 8px 14px;
  }

  .also-label {
    flex-shrink: 0;
    margin-right: auto;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .menu-item.chip {
    width: auto;
    flex: 0 1 auto;
    min-width: 0;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: var(--text-sm);
  }

  .menu-item.chip.done {
    border-color: color-mix(in srgb, var(--color-primary, #0066cc) 40%, var(--color-border));
  }

  @media (hover: none) and (pointer: coarse) {
    .menu-item {
      min-height: 44px;
    }

    /* The chips keep their pill, with the tap target reaching past it. */
    .menu-item.chip {
      min-height: 36px;
      padding-inline: 12px;
    }

    .menu-also {
      padding-block: 6px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .link-menu,
    .link-menu.placed {
      transform: none;
      transition: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .link-menu {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }
  }
</style>
