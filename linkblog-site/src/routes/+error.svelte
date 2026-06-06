<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head>
  <title>{page.status === 404 ? 'Not found' : 'Error'} · Skyreader</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="empty">
  <p class="empty-title">
    {page.status === 404 ? "We couldn't find that linkblog." : 'Something went wrong.'}
  </p>
  {#if page.error?.message && page.status !== 404}
    <p class="empty-sub">{page.error.message}</p>
  {/if}
</div>
<footer class="foot">
  <a href="https://skyreader.app">Skyreader</a>, stored in the Atmosphere.
</footer>
