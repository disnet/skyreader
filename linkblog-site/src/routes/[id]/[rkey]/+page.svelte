<script lang="ts">
  import {
    articleExcerpt,
    blogTitle,
    blogUrlFor,
    clampText,
    entryUrlFor,
    externalArticleUrl,
    feedUrlFor,
    formatDate,
    hostnameOf,
    linkPostNote,
    plainBody,
    renderBodyHtml,
    rkeyFromUri,
    safeHttpUrl,
    socialCountsText,
  } from '$lib/fields';
  import AlsoLinkedBy from '$lib/components/AlsoLinkedBy.svelte';
  import Meta from '$lib/components/Meta.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const doc = $derived(data.doc);
  const blogName = $derived(blogTitle(data.profile, data.pub));
  const title = $derived(doc.title || 'Untitled');
  const note = $derived(linkPostNote(doc).trim());
  const excerpt = $derived(articleExcerpt(doc));
  const articleUrl = $derived(safeHttpUrl(externalArticleUrl(doc) || doc.canonicalUrl));
  const host = $derived(hostnameOf(articleUrl ?? undefined));
  const date = $derived(formatDate(doc.createdAt || doc.publishedAt));
  const social = $derived(socialCountsText(data.ctx));

  const rkey = $derived(rkeyFromUri(doc.recordUri) ?? '');
  const backHref = $derived(blogUrlFor(data.origin, data.did));
  const pageUrl = $derived(entryUrlFor(data.origin, data.did, rkey));
  const feedUrl = $derived(feedUrlFor(data.origin, data.did));
  const icon = $derived(safeHttpUrl(data.pub?.icon || data.profile?.avatar));
  const summary = $derived(plainBody(note || excerpt).slice(0, 280));
</script>

<svelte:head>
  <title>{title} · {blogName}</title>
  {#if summary}<meta name="description" content={summary} />{/if}
  <meta property="og:type" content="website" />
  <meta property="og:title" content={`${title} · ${blogName}`} />
  {#if summary}<meta property="og:description" content={summary} />{/if}
  <meta property="og:url" content={pageUrl} />
  {#if icon}<meta property="og:image" content={icon} />{/if}
  <meta name="twitter:card" content="summary" />
  <link rel="alternate" type="application/rss+xml" title={blogName} href={feedUrl} />
</svelte:head>

<a class="back" href={backHref}><span aria-hidden="true">←</span> {blogName}</a>
<article class="entry-page">
  <h1 class="entry-title-lg">
    {#if articleUrl}<a href={articleUrl}>{title}</a>{:else}{title}{/if}
  </h1>
  <Meta {host} {date} {social} />
  {#if note}
    <!-- The user-controlled body: restricted Markdown (blockquotes only), rendered
         to escaped, self-generated HTML (see renderBodyHtml). -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div class="entry-note-lg">{@html renderBodyHtml(note)}</div>
  {/if}
  {#if excerpt && excerpt !== note}
    <!-- Legacy standalone quote: only records that predate the in-note quote still
         carry a top-level description. -->
    <blockquote class="entry-quote"><p>{clampText(excerpt, 600)}</p></blockquote>
  {/if}
  {#if articleUrl}
    <a class="readmore" href={articleUrl} rel="noopener noreferrer">
      Read the full article{host ? ` on ${host}` : ''}
      <span class="arrow" aria-hidden="true">→</span>
    </a>
  {/if}
  <AlsoLinkedBy ctx={data.ctx} />
</article>
<footer class="foot">
  A linkblog on <a href={data.appUrl}>Skyreader</a>, stored in the Atmosphere.
</footer>
