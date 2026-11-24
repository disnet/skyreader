<script lang="ts">
  // The afterword: everything Skyreader adds below an article (links in it, a
  // connection to draw, the discussion) on one sunken band, so the line between
  // the author's text and what comes after it stays clear. Each child is a
  // section; they stack divided by hairlines, each opening the same way (its
  // label in ink over a hairline). Layout only: the sections bring their own
  // content, and a section that renders nothing leaves no gap.
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<div class="reader-afterword">
  {@render children()}
</div>

<style>
  /* The Discussion's sunken ground, stretched over every section. Flat: a
     change of ground, never a shadow. */
  .reader-afterword {
    display: flex;
    flex-direction: column;
    margin-top: 2rem;
    border-radius: 12px;
    background: var(--color-bg-secondary);
    /* Paged mode can break the band across columns; each piece keeps its
       corners rather than reading as a torn edge. */
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }

  /* Nothing to add (no links, no URL): no empty band. */
  .reader-afterword:not(:has(> *)) {
    display: none;
  }

  /* Any section, whoever renders it, gets the same room and the same divider. */
  .reader-afterword > :global(*) {
    margin: 0;
    padding: 1.25rem;
    /* A section broken across columns keeps its padding on both sides of the break. */
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }

  .reader-afterword > :global(* + *) {
    border-top: 1px solid var(--color-border);
  }

  @media (max-width: 640px) {
    .reader-afterword > :global(*) {
      padding: 1rem;
    }
  }
</style>
