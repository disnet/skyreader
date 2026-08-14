<script lang="ts">
  import { blogTitle, feedUrlFor, hostnameOf, publicationUri, safeHttpUrl } from '$lib/fields';
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
  const publication = $derived(data.publication || publicationUri(data.did));
  const pageUrl = $derived(`${data.origin}/${encodeURIComponent(data.did)}`);
  const ogDescription = $derived(
    data.pub?.description || `Links shared by ${data.profile?.displayName || data.did}.`
  );

  const who = $derived(
    data.profile?.displayName || (handle ? `@${handle}` : 'This reader')
  );

  // These posts live in a publication the reader already runs somewhere else — say
  // where. The canonical is a narrower question and the server answers it
  // separately: it only points away when that site holds everything this page
  // lists, otherwise this page is its own canonical.
  const externalUrl = $derived(safeHttpUrl(data.externalUrl ?? undefined));
  const externalHost = $derived(hostnameOf(externalUrl ?? undefined));
  const canonicalUrl = $derived(safeHttpUrl(data.canonicalUrl ?? undefined) ?? pageUrl);
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="description" content={ogDescription} />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Skyreader" />
  <meta property="og:title" content={title} />
  <meta property="og:description" content={ogDescription} />
  <meta property="og:url" content={pageUrl} />
  {#if icon}
    <meta property="og:image" content={icon} />
    <meta property="og:image:alt" content={title} />
  {/if}
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content={title} />
  <meta name="twitter:description" content={ogDescription} />
  {#if icon}<meta name="twitter:image" content={icon} />{/if}
  <link rel="canonical" href={canonicalUrl} />
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
  {#if externalUrl}
    <p class="pubhome">
      Published on <a href={externalUrl} rel="noopener noreferrer">{externalHost}</a>
    </p>
  {/if}
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
