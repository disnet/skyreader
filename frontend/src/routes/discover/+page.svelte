<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { replaceState } from '$app/navigation';
  import LinkblogDiscovery from '$lib/components/LinkblogDiscovery.svelte';
  import FollowingPublications from '$lib/components/FollowingPublications.svelte';
  import DiscoveryToolbar from '$lib/components/DiscoveryToolbar.svelte';
  import ScopeTabs from '$lib/components/sources/ScopeTabs.svelte';
  import StaticPageChrome from '$lib/components/feed/StaticPageChrome.svelte';
  import { linkblogDiscoveryStore } from '$lib/stores/linkblogDiscovery.svelte';
  import { followingPublicationsStore } from '$lib/stores/followingPublications.svelte';

  // Two kinds of source, one tab each. One search and one "Hide added" cover
  // both, and each tab's count follows them, so a search shows where its
  // matches are before you switch.
  type Tab = 'linkblogs' | 'publications';
  let tab = $state<Tab>(
    page.url.searchParams.get('tab') === 'publications' ? 'publications' : 'linkblogs'
  );

  let query = $state('');
  let hideAdded = $state(false);
  let linkblogCount = $state<number | null>(null);
  let publicationCount = $state<number | null>(null);

  // Start both loads up front so the inactive tab's count fills in too.
  onMount(() => {
    linkblogDiscoveryStore.loadDiscover();
    followingPublicationsStore.load();
  });

  // Keep the tab in the URL so a reload or a shared link lands on it.
  function select(next: Tab) {
    tab = next;
    const url = new URL(page.url);
    if (next === 'linkblogs') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    replaceState(url, page.state);
  }
</script>

<svelte:head>
  <title>Discover - Skyreader</title>
</svelte:head>

<StaticPageChrome title="Discover" />

<div class="discover-page">
  <DiscoveryToolbar bind:query bind:hideAdded searchLabel="Search" />

  <div class="tabs">
    <ScopeTabs
      label="Discover"
      value={tab}
      onchange={select}
      options={[
        { id: 'linkblogs', label: 'Linkblogs', count: linkblogCount },
        { id: 'publications', label: 'Publications', count: publicationCount },
      ]}
    />
  </div>

  <!-- Both stay mounted so each keeps its count, scroll window and expanded
       accounts while the other is showing. -->
  <div role="tabpanel" hidden={tab !== 'linkblogs'}>
    <LinkblogDiscovery {query} {hideAdded} bind:shownCount={linkblogCount} />
  </div>
  <div role="tabpanel" hidden={tab !== 'publications'}>
    <FollowingPublications {query} {hideAdded} bind:shownCount={publicationCount} />
  </div>
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

  .tabs {
    margin: -0.25rem 0 1rem;
  }
</style>
