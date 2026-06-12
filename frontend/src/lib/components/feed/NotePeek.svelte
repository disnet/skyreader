<script lang="ts">
  import { positionFloating } from '$lib/utils/floating';

  interface Props {
    note: string;
    anchorRect: DOMRect;
  }

  let { note, anchorRect }: Props = $props();

  let el = $state<HTMLDivElement | null>(null);

  // Reposition whenever the anchor (i.e. the hovered marker) changes.
  $effect(() => {
    const rect = anchorRect;
    const node = el;
    if (!node) return;
    requestAnimationFrame(() => positionFloating(rect, node, { gap: 6, align: 'center' }));
  });
</script>

<!-- Desktop hover peek: a read-only preview of a note. Floating tier (it sits
     above the page), chrome sans voice, and non-interactive — to act on the
     note you click the marker, which opens the actionable popover. -->
<div class="note-peek" bind:this={el} style="position: fixed; z-index: 200;">
  {note}
</div>

<style>
  .note-peek {
    max-width: 18rem;
    max-height: 12rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.5rem 0.625rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    box-shadow:
      0 2px 8px rgba(0, 0, 0, 0.1),
      0 1px 2px rgba(0, 0, 0, 0.06);
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--color-text);
    white-space: pre-wrap;
    overflow-wrap: break-word;
    pointer-events: none;
    animation: note-peek-in 120ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  @keyframes note-peek-in {
    from {
      opacity: 0;
      transform: translateY(0.125rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-color-scheme: dark) {
    .note-peek {
      box-shadow:
        0 2px 8px rgba(0, 0, 0, 0.4),
        0 1px 2px rgba(0, 0, 0, 0.3);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .note-peek {
      animation: none;
    }
  }
</style>
