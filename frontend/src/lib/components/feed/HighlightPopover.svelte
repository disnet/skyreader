<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { tooltip } from '$lib/actions/tooltip';
  import { positionFloating } from '$lib/utils/floating';

  interface Props {
    mode: 'create' | 'remove';
    anchorRect: DOMRect;
    onHighlight?: (note?: string) => void;
    onHighlightToMargin?: (note?: string) => void;
    onRemove?: () => void;
    onSaveToMargin?: () => void;
    onSaveNote?: (note: string) => void;
    existingNote?: string;
    marginSaved?: boolean;
    onClose: () => void;
  }

  let {
    mode,
    anchorRect,
    onHighlight,
    onHighlightToMargin,
    onRemove,
    onSaveToMargin,
    onSaveNote,
    existingNote = '',
    marginSaved = false,
    onClose,
  }: Props = $props();

  let menuEl = $state<HTMLDivElement | null>(null);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  // 'toolbar' shows the action buttons; 'note' shows the floating text box.
  let view = $state<'toolbar' | 'note'>('toolbar');
  let noteText = $state('');
  let scrollArmed = false;
  let scrollArmTimer: ReturnType<typeof setTimeout> | undefined;

  function handleScroll() {
    // Don't dismiss while the user is editing a note (e.g. mobile keyboard scroll).
    if (scrollArmed && view === 'toolbar') onClose();
  }

  function positionMenu() {
    if (!menuEl) return;
    positionFloating(anchorRect, menuEl, { gap: 4, align: 'center' });
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
    document.addEventListener('scroll', handleScroll, true);
    requestAnimationFrame(positionMenu);
    // Delay arming the scroll-to-close so residual scroll momentum
    // (e.g. from trackpad inertia) doesn't immediately dismiss the popover
    scrollArmTimer = setTimeout(() => {
      scrollArmed = true;
    }, 300);
  });

  onDestroy(() => {
    clearTimeout(scrollArmTimer);
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('mousedown', handleClickOutside, true);
    document.removeEventListener('touchstart', handleClickOutside, true);
    document.removeEventListener('scroll', handleScroll, true);
  });
</script>

<div
  class="highlight-popover"
  class:note-view={view === 'note'}
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
      }}
    ></textarea>
    <div class="note-actions">
      {#if mode === 'create'}
        <button
          class="note-btn"
          onclick={() => {
            onHighlight?.(noteText);
            onClose();
          }}
        >
          <Icon name="highlighter" size={14} />
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
            <Icon name="margin" size={14} />
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
          <Icon name="check" size={14} />
          Save note
        </button>
      {/if}
    </div>
  {:else if mode === 'create'}
    <button
      class="popover-btn icon-only"
      use:tooltip={'Save private highlight'}
      aria-label="Save private highlight"
      onclick={() => {
        onHighlight?.();
        onClose();
      }}
    >
      <Icon name="highlighter" size={16} />
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
        <Icon name="margin" size={16} />
      </button>
    {/if}
    <button
      class="popover-btn icon-only"
      use:tooltip={'Add a note'}
      aria-label="Add a note"
      onclick={openNoteEditor}
    >
      <Icon name="message-circle" size={16} />
    </button>
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
      <Icon name="x" size={16} />
    </button>
    {#if onSaveToMargin}
      {#if marginSaved}
        <span
          class="popover-status icon-only"
          use:tooltip={'Saved to Margin'}
          aria-label="Saved to Margin"
        >
          <Icon name="check" size={16} />
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
          <Icon name="margin" size={16} />
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
        <Icon name="message-circle" size={16} />
      </button>
    {/if}
  {/if}
</div>

<style>
  .highlight-popover {
    display: flex;
    gap: 2px;
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 6px;
    padding: 2px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .highlight-popover.note-view {
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    width: 260px;
  }

  .popover-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: none;
    background: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--text-xs);
    color: var(--color-text, #1a1a1a);
    white-space: nowrap;
  }

  .popover-btn:hover {
    background: var(--color-hover, #f1f5f9);
  }

  .popover-btn.icon-only,
  .popover-status.icon-only {
    padding: 6px;
  }

  .popover-btn.remove:hover {
    background: #fef2f2;
    color: #dc2626;
  }

  .popover-status {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    font-size: var(--text-xs);
    color: var(--color-text-muted, #64748b);
    white-space: nowrap;
  }

  .note-input {
    width: 100%;
    box-sizing: border-box;
    /* No drag handle; iOS won't zoom on focus at >=16px font-size. */
    resize: none;
    min-height: 60px;
    padding: 6px 8px;
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 4px;
    font: inherit;
    font-size: 16px;
    color: var(--color-text, #1a1a1a);
    background: var(--color-bg, #fff);
  }

  .note-input:focus {
    outline: none;
    border-color: var(--color-primary, #0066cc);
  }

  .note-actions {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
  }

  .note-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    border: 1px solid var(--color-border, #e2e8f0);
    background: var(--color-surface, #fff);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--text-xs);
    color: var(--color-text, #1a1a1a);
    white-space: nowrap;
  }

  .note-btn:hover {
    background: var(--color-hover, #f1f5f9);
  }

  .note-btn.primary {
    border-color: var(--color-primary, #0066cc);
    color: var(--color-primary, #0066cc);
  }

  @media (prefers-color-scheme: dark) {
    .note-input {
      background: var(--color-bg-secondary, #2a2a2a);
    }
  }
</style>
