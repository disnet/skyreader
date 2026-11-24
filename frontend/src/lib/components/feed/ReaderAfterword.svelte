<script lang="ts">
  // The afterword: everything Skyreader adds below an article (links in it, a
  // connection to draw, the discussion), each a sunken tile of its own with
  // the page showing between them, so the line between the author's text and
  // what comes after it stays clear and so does each break between sections.
  // Each opens the same way: its label in ink, no rule under it. Layout only:
  // the sections bring their own content, and one that renders nothing leaves
  // no gap.
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<div class="reader-afterword">
  {@render children()}
</div>

<style>
  /* Each section is its own tile on the Discussion's sunken ground, with the
     page showing between them: the break between sections is a change of
     ground, so nothing inside a section needs a rule to mark where it starts.
     Flat: never a shadow. */
  .reader-afterword {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 2rem;
  }

  /* Nothing to add (no links, no URL): no empty space. */
  .reader-afterword:not(:has(> *)) {
    display: none;
  }

  /* Any section, whoever renders it, gets the same ground and room. */
  .reader-afterword > :global(*) {
    margin: 0;
    padding: 1.25rem;
    border-radius: 12px;
    background: var(--color-bg-secondary);
    /* Paged mode can break a tile across columns; each piece keeps its padding
       and corners rather than reading as a torn edge. */
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }

  @media (max-width: 640px) {
    .reader-afterword > :global(*) {
      padding: 1rem;
    }
  }
</style>
