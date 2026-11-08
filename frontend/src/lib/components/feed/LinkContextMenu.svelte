<script lang="ts" module>
  import type { IntegrationStatus } from '$lib/types';

  // Which of Semble and Margin this session may read, asked once a page load:
  // a membership lookup without the scope answers 403, and that raises the
  // app-wide "needs your permission" banner for a reader who only tapped a
  // link. A scope upgrade is a sign-in round trip, which reloads the page.
  let scopes: Promise<IntegrationStatus['scopeStatus'] | null> | null = null;
</script>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import SaveToLibraryPanel from '$lib/components/shelf/SaveToLibraryPanel.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
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

  interface Props {
    url: string;
    linkText: string;
    anchorRect: DOMRect;
    /** The page this link sits in, to connect it to on Semble: the article a
     *  cited link appears in, or the save a New connections tile is about.
     *  Absent where there's nothing to connect from. */
    connectFrom?: SembleConnectionSource;
    /** The menu item's wording; "Connect on Semble…" by default. */
    connectLabel?: string;
    onClose: () => void;
  }

  let {
    url,
    linkText,
    anchorRect,
    connectFrom,
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

  // Save swaps the menu for the reader's Save panel (Shelf, collections,
  // Remove), the one the feed card's and the reader's Save buttons open. The
  // menu stays mounted under it, so the host keeps its state until the panel
  // closes, and the panel hangs from where the link was.
  let panelOpen = $state(false);
  // Save was pressed and its row hasn't landed: the panel says "Saving…".
  let saving = $state(false);
  let panelSave = $derived(panelOpen ? savesStore.find(url) : undefined);
  let panelAnchor = $state<HTMLSpanElement | null>(null);
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
      // A longer row can widen the menu past the screen's edge. Only then is
      // it moved: the reader may be reaching for a row.
      requestAnimationFrame(() => {
        const right = menuEl?.getBoundingClientRect().right ?? 0;
        if (!panelOpen && right > window.innerWidth - 8) positionMenu(false);
      });
    } catch {
      // Left unknown: the row offers to save, and the picker reads it again.
    }
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
  function titleHint(text: string): string | undefined {
    const t = text.trim();
    if (t.length < 12 || /^(https?:\/\/|www\.)/i.test(t)) return undefined;
    return t;
  }

  // Save, then open the Save panel on it; a link already saved opens the panel
  // straight away. The props are read up front, as in handleCollect: if the
  // panel closes mid-save the host clears its state, and they throw after that.
  function handleSave() {
    // Copy link is about to close the menu: a panel opened now would go with it.
    if (copyState === 'copied') return;
    panelOpen = true;
    if (alreadySaved) return;
    const saveUrl = url;
    const title = titleHint(linkText);
    saving = true;
    savesStore
      .saveFromUrl(saveUrl, { title })
      .then((saved) => {
        // Only the link was kept: say so, and offer the way to the full text.
        if (saved.fetchFailed) {
          const id = toastStore.add('');
          toastStore.update(
            id,
            'success',
            failedSaveLine(saved.fetchFailed),
            extensionCanHelp(saved.fetchFailed) ? blockedSaveAction() : undefined
          );
        } else if (destroyed) {
          // The panel that would have said so is gone.
          toastStore.update(toastStore.add(''), 'success', 'Saved to your Queue');
        }
      })
      .catch((err) => {
        closePanel();
        const id = toastStore.add('');
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
    // The Save panel has its own keys, and closes itself.
    if (panelOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    const items = menuItems().filter((b) => !b.disabled);
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    items[next].focus();
  }

  function handleClickOutside(e: MouseEvent) {
    if (panelOpen) return;
    if (menuEl && !menuEl.contains(e.target as Node)) {
      onClose();
    }
  }

  function positionMenu(focus = true) {
    if (!menuEl) return;
    const menuRect = menuEl.getBoundingClientRect();
    const gap = 8;

    // Below the link by default, above it when there's no room, and pinned
    // inside the viewport when neither side fits.
    let top: number;
    if (anchorRect.bottom + gap + menuRect.height <= window.innerHeight - gap) {
      top = anchorRect.bottom + gap / 2;
    } else if (anchorRect.top - gap - menuRect.height >= gap) {
      top = anchorRect.top - gap / 2 - menuRect.height;
    } else {
      top = Math.max(gap, window.innerHeight - menuRect.height - gap);
    }

    let left = Math.min(anchorRect.left, window.innerWidth - menuRect.width - gap);
    left = Math.max(gap, left);

    menuEl.style.top = `${top}px`;
    menuEl.style.left = `${left}px`;
    placed = true;
    // Focus without a ring on tap (:focus-visible), so arrow keys work at once.
    if (focus) menuItems()[0]?.focus({ preventScroll: true });
  }

  // The panel follows a scroll itself, closing on a scroll gesture.
  function handleScroll() {
    if (!panelOpen) onClose();
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('click', handleClickOutside, true);
    document.addEventListener('scroll', handleScroll, true);
    requestAnimationFrame(() => positionMenu());
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
  });
</script>

{#if panelOpen}
  <!-- Where the link sits, for the panel to hang from. -->
  <span
    class="panel-anchor"
    aria-hidden="true"
    bind:this={panelAnchor}
    style:top="{anchorRect.top}px"
    style:left="{anchorRect.left}px"
    style:width="{anchorRect.width}px"
    style:height="{anchorRect.height}px"
  ></span>
  {#if panelAnchor}
    <SaveToLibraryPanel
      save={panelSave}
      anchorEl={panelAnchor}
      onUnsave={unsaveFromPanel}
      onClose={closePanel}
    />
  {/if}
{/if}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="link-menu"
  class:placed
  class:hidden={panelOpen}
  role="menu"
  aria-label="Link actions"
  tabindex="-1"
  bind:this={menuEl}
  onclick={(e) => e.stopPropagation()}
>
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
  </div>

  <div class="menu-group">
    <button class="menu-item" role="menuitem" onclick={handleOpenInNewTab}>
      <Icon name="external-link" size={16} />
      <span>Open in new tab</span>
    </button>
    <button
      class="menu-item"
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
      <button
        class="menu-item"
        class:done={alreadySaved}
        role="menuitem"
        aria-haspopup="dialog"
        onclick={handleSave}
      >
        <Icon name={alreadySaved ? 'check' : 'bookmark'} size={16} />
        <span>{alreadySaved ? 'Saved' : 'Save to Skyreader'}</span>
      </button>
      {#each [{ kind: 'semble', name: 'Semble' }, { kind: 'margin', name: 'Margin' }] as const as row (row.kind)}
        {@const there = stored[row.kind]}
        <button
          class="menu-item"
          class:done={Boolean(there)}
          role="menuitem"
          aria-haspopup="dialog"
          onclick={() => handleCollect(row.kind)}
        >
          <Icon name={row.kind} size={16} />
          <span>{there ? `Saved to ${row.name}` : `Save to ${row.name}…`}</span>
          {#if there && there.collections > 0}
            <span class="hint">{collectionCount(there.collections)}</span>
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
</div>

<style>
  .link-menu {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 200;
    width: max-content;
    min-width: 220px;
    max-width: min(300px, calc(100vw - 16px));
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

  .panel-anchor {
    position: fixed;
    pointer-events: none;
    visibility: hidden;
  }

  .link-menu.placed:not(.hidden) {
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

  @media (hover: none) and (pointer: coarse) {
    .menu-item {
      min-height: 44px;
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
