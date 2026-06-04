<script lang="ts">
  import LinkblogDiscovery from '$lib/components/LinkblogDiscovery.svelte';
  import FollowingPublications from '$lib/components/FollowingPublications.svelte';
  import FeedPageHeader from '$lib/components/feed/FeedPageHeader.svelte';
</script>

<svelte:head>
  <title>Discover - Skyreader</title>
</svelte:head>

<FeedPageHeader title="Discover" hideControls />

<div class="discover-page">
  <header class="discover-header">
    <h1>Discover</h1>
    <p class="header-desc">
      Follow the people you already know from Bluesky, then explore others sharing across the
      Atmosphere.
    </p>
  </header>

  <section class="discover-section">
    <h2 class="section-title">Linkblogs</h2>
    <p class="section-desc">Linkblogs are portable — anyone on Skyreader gets one in their PDS.</p>
    <LinkblogDiscovery variant="full" />
  </section>

  <section class="discover-section">
    <h2 class="section-title">Publications from people you follow</h2>
    <p class="section-desc">
      Standard.site publications owned by the accounts you follow on Bluesky.
    </p>
    <FollowingPublications />
  </section>
</div>

<style>
  .discover-page {
    max-width: 640px;
    margin: 0 auto;
    /* Clear the floating page-header pill (matches the Sources page). */
    padding: 3.5rem 1rem 4rem;
  }

  @media (max-width: 1000px) {
    .discover-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 4rem);
    }
  }

  .discover-header {
    margin-bottom: 1.5rem;
  }

  h1 {
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    margin: 0 0 0.5rem;
  }

  .header-desc {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
    margin: 0;
    max-width: 52ch;
  }

  .discover-section {
    margin-bottom: 2.5rem;
  }

  .discover-section:last-child {
    margin-bottom: 0;
  }

  .section-title {
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
    margin: 0 0 0.25rem;
  }

  .section-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
    margin: 0 0 1rem;
    max-width: 52ch;
  }
</style>
