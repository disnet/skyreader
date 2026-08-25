<script lang="ts">
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { tooltip } from '$lib/actions/tooltip';
  import { followAnchor, positionFloating } from '$lib/utils/floating';

  interface Props {
    mode: 'create' | 'remove' | 'view';
    anchorRect: DOMRect;
    /**
     * Live position of the passage this popover belongs to. Supplied by callers
     * whose anchor stays on screen (the reader body), so the popover tracks the
     * text as it scrolls instead of hanging at the viewport spot it opened in.
     * Without it the popover keeps the older behavior: closes once the reader
     * scrolls.
     */
    getAnchorRect?: () => DOMRect | null;
    onHighlight?: (note?: string) => void;
    onHighlightToMargin?: (note?: string) => void;
    onRemove?: () => void;
    onSaveToMargin?: () => void;
    onSaveNote?: (note: string) => void;
    /** Present while a share draft is open for this article: add the selected
     *  passage (or this highlight) to the draft as a quote block. */
    onQuoteToShare?: () => void;
    existingNote?: string;
    marginSaved?: boolean;
    // Which sub-view to open into: 'toolbar' (action buttons, the default) or
    // 'note' (jump straight into the note editor — used by callers that have a
    // dedicated "add a note" control).
    initialView?: 'toolbar' | 'note';
    onClose: () => void;
  }

  let {
    mode,
    anchorRect,
    getAnchorRect,
    onHighlight,
    onHighlightToMargin,
    onRemove,
    onSaveToMargin,
    onSaveNote,
    onQuoteToShare,
    existingNote = '',
    marginSaved = false,
    initialView = 'toolbar',
    onClose,
  }: Props = $props();

  let menuEl = $state<HTMLDivElement | null>(null);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  // 'toolbar' shows the action buttons; 'note' shows the floating text box.
  // These seed from props once at mount; later prop changes shouldn't reset the
  // open view or clobber what the user is typing, so the reads are untracked.
  let view = $state<'toolbar' | 'note'>(untrack(() => initialView));
  let noteText = $state(untrack(() => (initialView === 'note' ? (existingNote ?? '') : '')));
  let scrollArmed = false;
  let scrollArmTimer: ReturnType<typeof setTimeout> | undefined;
  let stopFollowing: (() => void) | undefined;

  function handleScroll() {
    // Don't dismiss while the user is editing a note (e.g. mobile keyboard scroll).
    if (scrollArmed && view === 'toolbar') onClose();
  }

  /** The passage's current position, falling back to where it was at open. */
  function currentAnchorRect(): DOMRect {
    return getAnchorRect?.() ?? anchorRect;
  }

  function positionMenu() {
    if (!menuEl) return;
    positionFloating(currentAnchorRect(), menuEl, { gap: 4, align: 'center' });
  }

  // The on-screen keyboard (raised by focusing the note editor) shrinks the
  // visual viewport. Re-run positioning as it animates in so the popover lifts
  // above the keyboard instead of being left behind it — visualViewport.height
  // only settles after focus, well after the initial positionMenu() call.
  function handleViewportChange() {
    positionMenu();
  }

  async function openNoteEditor() {
    noteText = existingNote ?? '';
    view = 'note';
    // Let the larger note box render, then reposition and focus.
    await tick();
    positionMenu();
    textareaEl?.focus();
    textareaEl?.select();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  function handleClickOutside(e: MouseEvent | TouchEvent) {
    if (menuEl && !menuEl.contains(e.target as Node)) {
      onClose();
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('touchstart', handleClickOutside, true);
    // Tracking the anchor replaces scroll-to-close: the popover stays on its
    // passage, and only leaves when the passage itself scrolls out of view.
    if (getAnchorRect) {
      stopFollowing = followAnchor(() => menuEl, getAnchorRect, {
        gap: 4,
        align: 'center',
        onLost: () => {
          if (view === 'toolbar') onClose();
        },
      });
    } else {
      document.addEventListener('scroll', handleScroll, true);
    }
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange);
    requestAnimationFrame(positionMenu);
    // When opened straight into the note editor, focus the textarea once it has
    // rendered so the user can type immediately.
    if (view === 'note') {
      tick().then(() => {
        positionMenu();
        textareaEl?.focus();
        textareaEl?.select();
      });
    }
    // Delay arming the scroll-to-close so residual scroll momentum
    // (e.g. from trackpad inertia) doesn't immediately dismiss the popover
    scrollArmTimer = setTimeout(() => {
      scrollArmed = true;
    }, 300);
  });

  onDestroy(() => {
    clearTimeout(scrollArmTimer);
    stopFollowing?.();
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('mousedown', handleClickOutside, true);
    document.removeEventListener('touchstart', handleClickOutside, true);
    document.removeEventListener('scroll', handleScroll, true);
    window.visualViewport?.removeEventListener('resize', handleViewportChange);
    window.visualViewport?.removeEventListener('scroll', handleViewportChange);
  });
</script>

<div
  class="highlight-popover"
  class:note-view={view === 'note'}
  class:read-view={view === 'toolbar' && mode === 'view'}
  style="position: fixed; z-index: 200;"
  bind:this={menuEl}
  onclick={(e) => e.stopPropagation()}
  onmousedown={(e) => e.stopPropagation()}
>
  {#if view === 'note'}
    <textarea
      class="note-input"
      bind:this={textareaEl}
      bind:value={noteText}
      placeholder="Add a note…"
      rows="3"
      onkeydown={(e) => {
        // Keep typing from triggering reader keyboard shortcuts.
        if (e.key !== 'Escape') e.stopPropagation();
      }}></textarea>
    <div class="note-actions">
      {#if mode === 'create'}
        <button
          class="note-btn"
          onclick={() => {
            onHighlight?.(noteText);
            onClose();
          }}
        >
          <Icon name="highlighter" size={16} />
          Save private
        </button>
        {#if onHighlightToMargin}
          <button
            class="note-btn"
            onclick={() => {
              onHighlightToMargin?.(noteText);
              onClose();
            }}
          >
            <Icon name="margin" size={16} />
            Save to Margin
          </button>
        {/if}
      {:else}
        <button
          class="note-btn primary"
          onclick={() => {
            onSaveNote?.(noteText);
            onClose();
          }}
        >
          <Icon name="check" size={16} />
          Save note
        </button>
      {/if}
    </div>
  {:else if mode === 'create'}
    <button
      class="popover-btn icon-only highlight"
      use:tooltip={'Save private highlight'}
      aria-label="Save private highlight"
      onclick={() => {
        onHighlight?.();
        onClose();
      }}
    >
      <Icon name="highlighter" size={20} />
    </button>
    {#if onHighlightToMargin}
      <button
        class="popover-btn icon-only"
        use:tooltip={'Save public margin highlight'}
        aria-label="Save public margin highlight"
        onclick={() => {
          onHighlightToMargin?.();
          onClose();
        }}
      >
        <Icon name="margin" size={20} />
      </button>
    {/if}
    <button
      class="popover-btn icon-only"
      use:tooltip={'Add a note'}
      aria-label="Add a note"
      onclick={openNoteEditor}
    >
      <Icon name="message-circle" size={20} />
    </button>
    {#if onQuoteToShare}
      <button
        class="popover-btn icon-only"
        use:tooltip={'Quote in your share draft'}
        aria-label="Quote in your share draft"
        onclick={() => {
          onQuoteToShare?.();
          onClose();
        }}
      >
        <Icon name="quote" size={20} />
      </button>
    {/if}
  {:else if mode === 'view'}
    <p class="note-read">{existingNote}</p>
    <div class="note-actions">
      <button class="note-btn" onclick={openNoteEditor}>
        <Icon name="edit" size={16} />
        Edit note
      </button>
      <button
        class="note-btn danger"
        onclick={() => {
          onRemove?.();
          onClose();
        }}
      >
        <Icon name="trash" size={16} />
        Remove
      </button>
    </div>
  {:else}
    <button
      class="popover-btn icon-only remove"
      use:tooltip={'Remove highlight'}
      aria-label="Remove highlight"
      onclick={() => {
        onRemove?.();
        onClose();
      }}
    >
      <Icon name="x" size={20} />
    </button>
    {#if onSaveToMargin}
      {#if marginSaved}
        <span
          class="popover-status icon-only"
          use:tooltip={'Saved to Margin'}
          aria-label="Saved to Margin"
        >
          <Icon name="check" size={20} />
        </span>
      {:else}
        <button
          class="popover-btn icon-only"
          use:tooltip={'Save public margin highlight'}
          aria-label="Save public margin highlight"
          onclick={() => {
            onSaveToMargin?.();
            onClose();
          }}
        >
          <Icon name="margin" size={20} />
        </button>
      {/if}
    {/if}
    {#if onSaveNote}
      <button
        class="popover-btn icon-only"
        use:tooltip={existingNote ? 'Edit note' : 'Add a note'}
        aria-label={existingNote ? 'Edit note' : 'Add a note'}
        onclick={openNoteEditor}
      >
        <Icon name="message-circle" size={20} />
      </button>
    {/if}
    {#if onQuoteToShare}
      <button
        class="popover-btn icon-only"
        use:tooltip={'Quote in your share draft'}
        aria-label="Quote in your share draft"
        onclick={() => {
          onQuoteToShare?.();
          onClose();
        }}
      >
        <Icon name="quote" size={20} />
      </button>
    {/if}
  {/if}
</div>

<style>
  .highlight-popover {
    /* Sizing knobs — bumped up for touch via the coarse-pointer query below. */
    --btn-size: 2.25rem; /* 36px */
    --btn-radius: 0.5rem; /* 8px */
    --icon-size: 1.125rem; /* 18px */

    display: flex;
    gap: 0.125rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 0.75rem;
    padding: 0.25rem;
    /* Floating tier — this element genuinely sits above the page. */
    box-shadow:
      0 4px 16px rgba(0, 0, 0, 0.15),
      0 1px 2px rgba(0, 0, 0, 0.08);
    transform-origin: top center;
    animation: popover-in 140ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .highlight-popover.note-view,
  .highlight-popover.read-view {
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
    width: 19rem;
  }

  .note-read {
    margin: 0;
    padding: 0.125rem 0.25rem;
    max-height: 12rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--color-text);
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  @keyframes popover-in {
    from {
      opacity: 0;
      transform: scale(0.94) translateY(0.125rem);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .popover-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    border: none;
    background: none;
    border-radius: var(--btn-radius);
    cursor: pointer;
    color: var(--color-text-secondary);
    white-space: nowrap;
    transition:
      background-color 120ms ease,
      color 120ms ease,
      transform 100ms ease;
  }

  .popover-btn :global(svg) {
    width: var(--icon-size);
    height: var(--icon-size);
  }

  .popover-btn:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .popover-btn:active {
    transform: scale(0.92);
  }

  .popover-btn:focus-visible {
    outline: none;
    color: var(--color-text);
    box-shadow: 0 0 0 2px var(--color-primary);
  }

  .popover-btn.icon-only,
  .popover-status.icon-only {
    width: var(--btn-size);
    height: var(--btn-size);
    padding: 0;
  }

  /* The highlighter previews its own action: a wash of the highlight gold. */
  .popover-btn.highlight:hover {
    background: rgba(245, 197, 24, 0.22);
    color: var(--color-text);
  }

  .popover-btn.remove:hover {
    background: rgba(244, 67, 54, 0.12);
    color: #f44336;
  }

  .popover-status {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--btn-size);
    height: var(--btn-size);
    color: #4caf50;
  }

  .popover-status :global(svg) {
    width: var(--icon-size);
    height: var(--icon-size);
  }

  .note-input {
    width: 100%;
    box-sizing: border-box;
    /* No drag handle; iOS won't zoom on focus at >=16px font-size. */
    resize: none;
    min-height: 4rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    font: inherit;
    font-size: 16px;
    line-height: 1.5;
    color: var(--color-text);
    background: var(--color-bg);
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  .note-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.18);
  }

  .note-actions {
    display: flex;
    gap: 0.375rem;
    justify-content: stretch;
  }

  .note-btn {
    flex: 1;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: 0.375rem;
    min-height: 2.25rem;
    padding: 0.4375rem 0.75rem;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    border-radius: 0.5rem;
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-text);
    white-space: nowrap;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      transform 100ms ease;
  }

  /* A lone full-width button reads better centered; only paired buttons
     need left-aligned content so their icons share the same leading edge. */
  .note-btn:only-child {
    justify-content: center;
  }

  .note-btn:hover {
    background: var(--color-bg-secondary);
    border-color: var(--color-text-secondary);
  }

  .note-btn:active {
    transform: scale(0.98);
  }

  .note-btn:focus-visible {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.18);
  }

  .note-btn.primary {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: #fff;
  }

  .note-btn.primary:hover {
    background: var(--color-primary-dark);
    border-color: var(--color-primary-dark);
  }

  .note-btn.danger {
    color: var(--color-error);
  }

  .note-btn.danger:hover {
    background: rgba(244, 67, 54, 0.12);
    border-color: var(--color-error);
  }

  /* Touch devices: grow to a comfortable >=44px target and roomier icons. */
  @media (pointer: coarse) {
    .highlight-popover {
      --btn-size: 2.75rem; /* 44px — the touch-target floor, no larger */
      --btn-radius: 0.625rem; /* 10px */
      --icon-size: 1.25rem; /* 20px */
      gap: 0.1875rem;
      padding: 0.25rem;
      border-radius: 0.875rem;
    }

    .note-btn {
      min-height: 2.75rem;
    }
  }

  @media (prefers-color-scheme: dark) {
    .highlight-popover {
      box-shadow:
        0 4px 16px rgba(0, 0, 0, 0.5),
        0 1px 2px rgba(0, 0, 0, 0.4);
    }

    .note-input {
      background: var(--color-bg-secondary);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .highlight-popover {
      animation: none;
    }

    .popover-btn,
    .note-btn,
    .note-input {
      transition: none;
    }

    .popover-btn:active,
    .note-btn:active {
      transform: none;
    }
  }
</style>
