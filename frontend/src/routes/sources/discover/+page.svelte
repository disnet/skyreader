<script lang="ts">
  import LinkblogDiscovery from '$lib/components/LinkblogDiscovery.svelte';
  import FeedPageHeader from '$lib/components/feed/FeedPageHeader.svelte';
</script>

<svelte:head>
  <title>Discover Linkblogs - Skyreader</title>
</svelte:head>

<FeedPageHeader title="Discover Linkblogs" hideControls />

<div class="discover-page">
  <header class="discover-header">
    <h1>Discover linkblogs</h1>
    <p class="header-desc">
      Linkblogs are portable — anyone on Skyreader gets one in their PDS. Follow the people you
      already know from Bluesky, then explore others sharing across the Atmosphere.
    </p>
  </header>

  <LinkblogDiscovery variant="full" />
</div>

<style>
  .discover-page {
    max-width: 640px;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
  }

  .discover-header {
    margin-bottom: 1.5rem;
  }

  h1 {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0 0 0.5rem;
  }

  .header-desc {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    line-height: 1.5;
    margin: 0;
    max-width: 52ch;
  }
</style>
