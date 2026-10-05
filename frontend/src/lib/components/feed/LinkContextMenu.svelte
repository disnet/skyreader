<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { integrationSaveStore } from '$lib/stores/integrationSave.svelte';
  import type { IntegrationKind } from '$lib/stores/collections.svelte';
  import { UrlSaveLimitError } from '$lib/services/api';
  import { saveLimitLine } from '$lib/utils/limitCopy';
  import { failedSaveLine, blockedSaveAction } from '$lib/utils/saveAnywhere';

  interface Props {
    url: string;
    linkText: string;
    anchorRect: DOMRect;
    onClose: () => void;
  }

  let { url, linkText, anchorRect, onClose }: Props = $props();

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

  // Read the props before closing, as in handleCollect: after onClose they
  // throw, which would strand the "Saving article..." toast forever.
  function handleSave() {
    const saveUrl = url;
    const title = titleHint(linkText);
    const toastId = toastStore.add('Saving article...');
    onClose();
    savesStore
      .saveFromUrl(saveUrl, { title })
      .then((saved) => {
        // Only the link was kept: say so, and offer the way to the full text.
        if (saved.fetchFailed) {
          toastStore.update(
            toastId,
            'success',
            failedSaveLine(saved.fetchFailed),
            blockedSaveAction()
          );
          return;
        }
        toastStore.update(toastId, 'success', 'Article saved');
      })
      .catch((err) => {
        // The monthly save cap has a reason and a way out, so it says so
        // instead of hiding behind a generic failure.
        if (err instanceof UrlSaveLimitError) {
          toastStore.update(toastId, 'error', saveLimitLine(err.limit, err.resetsAt), {
            label: 'Become a Supporter',
            href: '/supporter',
          });
          return;
        }
        toastStore.update(toastId, 'error', 'Failed to save article');
      });
  }

  // Hand the link to the one app-wide collection picker, which reads the URL's
  // existing memberships, so a link already in a collection opens as an edit.
  // Read the props before closing: the host clears its menu state on close, and
  // these props read through to it, so afterwards they throw instead of answering.
  function handleCollect(kind: IntegrationKind) {
    const target = { url, title: titleHint(linkText) };
    onClose();
    integrationSaveStore.openPicker(kind, target);
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
    if (menuEl && !menuEl.contains(e.target as Node)) {
      onClose();
    }
  }

  function positionMenu() {
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
    menuItems()[0]?.focus({ preventScroll: true });
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('click', handleClickOutside, true);
    document.addEventListener('scroll', onClose, true);
    requestAnimationFrame(positionMenu);
  });

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('click', handleClickOutside, true);
    document.removeEventListener('scroll', onClose, true);
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="link-menu"
  class:placed
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
        disabled={alreadySaved}
        onclick={handleSave}
      >
        <Icon name={alreadySaved ? 'check' : 'bookmark'} size={16} />
        <span>{alreadySaved ? 'Saved' : 'Save to Skyreader'}</span>
      </button>
      <button class="menu-item" role="menuitem" onclick={() => handleCollect('semble')}>
        <Icon name="semble" size={16} />
        <span>Save to Semble…</span>
      </button>
      <button class="menu-item" role="menuitem" onclick={() => handleCollect('margin')}>
        <Icon name="margin" size={16} />
        <span>Save to Margin…</span>
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
