<script lang="ts">
  // One labelled case inside a Showcase — a name + optional note above a framed
  // slot holding the component under test. The frame mimics the feed column: a
  // dashed border so you can see the component's own bounds against the canvas.
  import type { Snippet } from 'svelte';

  let {
    name,
    note,
    frame = true,
    width,
    pad = false,
    background,
    relative = false,
    minHeight,
    children,
  }: {
    name: string;
    /** Optional sub-line explaining what the case demonstrates. */
    note?: string;
    /** Wrap the slot in a dashed frame. Off for things that draw their own chrome. */
    frame?: boolean;
    /** Fixed frame width (any CSS length), e.g. '680px'. Defaults to fluid. */
    width?: string;
    /** Add inner padding inside the frame. */
    pad?: boolean;
    /** Frame background override (e.g. for overlay components). */
    background?: string;
    /** Make the frame a positioning context for absolutely-positioned children. */
    relative?: boolean;
    /** Minimum frame height (any CSS length) — useful for positioned overlays. */
    minHeight?: string;
    children: Snippet;
  } = $props();
</script>

<section class="case">
  <div class="case-meta">
    <span class="case-name">{name}</span>
    {#if note}<span class="case-note">{note}</span>{/if}
  </div>
  <div
    class="case-frame"
    class:framed={frame}
    class:pad
    class:relative
    style:width={width ?? undefined}
    style:min-height={minHeight ?? undefined}
    style:background={background ?? undefined}
  >
    {@render children()}
  </div>
</section>

<style>
  .case {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .case-meta {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .case-name {
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }

  .case-note {
    font-size: var(--text-sm);
    color: var(--color-text-secondary, #777);
  }

  .case-frame {
    max-width: 100%;
  }

  .case-frame.framed {
    border: 1px dashed var(--color-border, #ddd);
    border-radius: 8px;
  }

  .case-frame.pad {
    padding: 1rem;
  }

  .case-frame.relative {
    position: relative;
  }
</style>
