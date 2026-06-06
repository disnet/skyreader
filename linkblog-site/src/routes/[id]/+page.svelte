<script lang="ts">
  import { blogTitle, feedUrlFor, publicationUri, safeHttpUrl } from '$lib/fields';
  import BlogEntry from '$lib/components/BlogEntry.svelte';
  import SubscribeActions from '$lib/components/SubscribeActions.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const title = $derived(blogTitle(data.profile, data.pub));
  const icon = $derived(safeHttpUrl(data.pub?.icon || data.profile?.avatar));
  const handle = $derived(data.profile?.handle);
  const description = $derived(data.pub?.description);

  const count = $derived(data.docs.length);
  const countLabel = $derived(count > 0 ? `${count} ${count === 1 ? 'link' : 'links'}` : '');

  const feedUrl = $derived(feedUrlFor(data.origin, data.did));
  const publication = $derived(publicationUri(data.did));
  const pageUrl = $derived(`${data.origin}/${encodeURIComponent(data.did)}`);
  const ogDescription = $derived(
    data.pub?.description || `Links shared by ${data.profile?.displayName || data.did}.`
  );

  const who = $derived(
    data.profile?.displayName || (handle ? `@${handle}` : 'This reader')
  );
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="description" content={ogDescription} />
  <meta property="og:type" content="website" />
  <meta property="og:title" content={title} />
  <meta property="og:description" content={ogDescription} />
  <meta property="og:url" content={pageUrl} />
  {#if icon}<meta property="og:image" content={icon} />{/if}
  <meta name="twitter:card" content="summary" />
  <link rel="alternate" type="application/rss+xml" {title} href={feedUrl} />
</svelte:head>

<header>
  <div class="pubhead">
    {#if icon}<img class="pubicon" src={icon} alt="" />{/if}
    <div class="pubmeta">
      <h1>{title}</h1>
      {#if handle || countLabel}
        <p class="byline">
          {#if handle}
            by <a href={`https://bsky.app/profile/${handle}`}>@{handle}</a>
          {/if}
          {#if handle && countLabel}
            ·
          {/if}
          {#if countLabel}{countLabel}{/if}
        </p>
      {/if}
    </div>
    <SubscribeActions apiBase={data.apiBase} appUrl={data.appUrl} {publication} {feedUrl} />
  </div>
  {#if description}<p class="pubdesc">{description}</p>{/if}
</header>
<hr class="divider" />

{#if data.docs.length}
  <ol class="entries">
    {#each data.docs as doc (doc.recordUri)}
      <BlogEntry origin={data.origin} did={data.did} {doc} ctx={data.social.get(doc.recordUri)} />
    {/each}
  </ol>
{:else}
  <div class="empty">
    <p class="empty-title">No links yet</p>
    <p class="empty-sub">When {who} shares an article, it shows up here.</p>
  </div>
{/if}

<footer class="foot">
  A linkblog on <a href={data.appUrl}>Skyreader</a>, stored in the Atmosphere.
</footer>
