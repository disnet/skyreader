<script lang="ts">
  import Nav from '$lib/components/Nav.svelte';
  import '../app.css';

  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<Nav />
<main>
  {@render children()}
</main>

<style>
  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1.5rem;
  }
</style>
