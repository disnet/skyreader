<script lang="ts">
  // Note composer for sharing an article to your linkblog (Phase 1 write path).
  //
  // Tapping Share opens this composer. The note is optional — submitting with an
  // empty field is a bare share. On desktop it renders as a small popover anchored
  // to the Share button (TagMenu-style fixed positioning so it escapes any
  // overflow-clipping action bar); on mobile it becomes a BottomSheet.
  import { onMount, onDestroy } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { formatQuoteSeed } from '$lib/utils/linkPost';

  interface Props {
    open: boolean;
    /** Share button to anchor the desktop popover to. Ignored on mobile. */
    anchorEl: HTMLElement | null;
    articleTitle: string;
    /** Hostname of the shared article, shown as quiet context. */
    articleHost?: string;
    /**
     * The article's excerpt. When present, the note is seeded with it as an
     * editable Markdown quote (`> …`) the user can keep, modify, or delete
     * before posting. Their own commentary goes below it.
     */
    quote?: string;
    /** Quiet one-line hint under the field. Defaults to the linkblog-share copy. */
    hintText?: string;
    /** Called with the trimmed note (undefined when left empty = bare share). */
    onsubmit: (note: string | undefined) => void;
    onclose: () => void;
  }

  let {
    open,
    anchorEl,
    articleTitle,
    articleHost,
    quote,
    hintText = 'Posts to your linkblog.',
    onsubmit,
    onclose,
  }: Props = $props();

  let note = $state('');
  let popoverEl = $state<HTMLDivElement | null>(null);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  // Seed (with the editable quote) + focus each time the composer opens. The
  // cursor lands after the quote so the user types their note beneath it.
  $effect(() => {
    if (open) {
      const seed = formatQuoteSeed(quote);
      note = seed ? `${seed}\n\n` : '';
      requestAnimationFrame(() => {
        positionPopover();
        const el = textareaEl;
        if (!el) return;
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      });
    }
  });

  function submit() {
    const trimmed = note.trim();
    onsubmit(trimmed.length > 0 ? trimmed : undefined);
  }

  function handleKeydown(e: KeyboardEvent) {
    // Keep note typing from triggering the feed's global keyboard shortcuts.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }

  // --- Desktop popover positioning (fixed, anchored to the Share button) ---
  function positionPopover() {
    if (mobileStore.isMobile || !anchorEl || !popoverEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const popRect = popoverEl.getBoundingClientRect();
    const gap = 6;

    // Prefer above the action bar (it usually sits at the card's bottom edge),
    // flip below if there isn't room.
    let top: number;
    if (rect.top - gap - popRect.height < 8) {
      top = Math.min(rect.bottom + gap, window.innerHeight - popRect.height - 8);
    } else {
      top = rect.top - gap - popRect.height;
    }

    // Left-align with the anchor, nudged in from the right viewport edge.
    let left = Math.min(rect.left, window.innerWidth - popRect.width - 8);
    left = Math.max(8, left);

    popoverEl.style.top = `${top}px`;
    popoverEl.style.left = `${left}px`;
  }

  function handleOutsideClick(e: MouseEvent) {
    if (mobileStore.isMobile) return;
    if (popoverEl && !popoverEl.contains(e.target as Node) && e.target !== anchorEl) {
      onclose();
    }
  }

  onMount(() => {
    document.addEventListener('scroll', positionPopover, true);
    window.addEventListener('resize', positionPopover);
    document.addEventListener('click', handleOutsideClick, true);
  });

  onDestroy(() => {
    document.removeEventListener('scroll', positionPopover, true);
    window.removeEventListener('resize', positionPopover);
    document.removeEventListener('click', handleOutsideClick, true);
  });
</script>

{#if open}
  {#if mobileStore.isMobile}
    <BottomSheet {open} {onclose} title="Share to your links">
      <div class="composer sheet-body">
        <div class="article-context">
          <span class="context-title">{articleTitle}</span>
          {#if articleHost}<span class="context-host">{articleHost}</span>{/if}
        </div>
        <textarea
          bind:this={textareaEl}
          bind:value={note}
          class="note-input"
          rows="3"
          placeholder="Add a note… (optional)"
          onkeydown={handleKeydown}
        ></textarea>
        <p class="hint">{hintText}</p>
        <div class="actions">
          <button class="btn btn-ghost" onclick={onclose}>Cancel</button>
          <button class="btn btn-primary" onclick={submit}>
            <Icon name="share" size={15} />
            Share
          </button>
        </div>
      </div>
    </BottomSheet>
  {:else}
    <!-- Stops clicks/keys inside the popover from reaching the underlying card. -->
    <div
      bind:this={popoverEl}
      class="composer popover"
      role="dialog"
      aria-label="Share to your links"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={handleKeydown}
    >
      <div class="article-context">
        <span class="context-title">{articleTitle}</span>
        {#if articleHost}<span class="context-host">{articleHost}</span>{/if}
      </div>
      <textarea
        bind:this={textareaEl}
        bind:value={note}
        class="note-input"
        rows="3"
        placeholder="Add a note… (optional)"
        onkeydown={handleKeydown}
      ></textarea>
      <div class="footer">
        <span class="hint">{hintText}</span>
        <div class="actions">
          <button class="btn btn-ghost" onclick={onclose}>Cancel</button>
          <button class="btn btn-primary" onclick={submit}>
            <Icon name="share" size={15} />
            Share
          </button>
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    text-align: left;
  }

  .popover {
    position: fixed;
    z-index: 200;
    width: min(20rem, calc(100vw - 16px));
    padding: 0.75rem;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 8px;
    /* Floating shadow — this is one of the few elements that leaves the page plane. */
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    animation: pop-in 0.14s ease-out;
  }

  .sheet-body {
    padding: 0.25rem 1rem 1rem;
  }

  .article-context {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    min-width: 0;
  }

  .context-title {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    line-height: 1.35;
    /* Two-line clamp keeps the context compact. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .context-host {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note-input {
    width: 100%;
    resize: vertical;
    min-height: 3.5rem;
    padding: 0.5rem 0.625rem;
    font: inherit;
    font-size: var(--text-lg);
    line-height: 1.45;
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 6px;
    outline: none;
    transition: border-color 0.15s;
  }

  .note-input:focus {
    border-color: var(--color-primary, #0066cc);
  }

  .note-input::placeholder {
    color: var(--color-text-secondary);
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .hint {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  /* On the mobile sheet, give the buttons room and let Share dominate. */
  .sheet-body .actions {
    margin-top: 0.25rem;
  }

  .sheet-body .btn-primary {
    flex: 1;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.5rem 0.875rem;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s,
      border-color 0.15s;
  }

  .btn-ghost {
    background: transparent;
    color: var(--color-text-secondary);
  }

  .btn-ghost:hover {
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text);
  }

  .btn-primary {
    background: var(--color-primary, #0066cc);
    color: #fff;
  }

  .btn-primary:hover {
    background: var(--color-primary-dark, #0052a3);
  }

  @keyframes pop-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .popover {
      animation: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .popover {
      background: var(--color-bg, #1a1a1a);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .note-input {
      background: var(--color-bg, #1a1a1a);
    }

    .btn-ghost:hover {
      background: rgba(255, 255, 255, 0.08);
    }
  }
</style>
