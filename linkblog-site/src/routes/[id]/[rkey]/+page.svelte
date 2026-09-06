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
    linkPostMentions,
    linkPostNote,
    linkPostTitle,
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
  // The article's own title, undecorated: the 🔗 / “…” decoration a record can
  // carry exists for foreign sites, and this page IS the linkblog. Keeps the
  // decoration out of <title>, og:title and the RSS feed (see linkPostTitle).
  const title = $derived(linkPostTitle(doc) || 'Untitled');
  const note = $derived(linkPostNote(doc).trim());
  const mentions = $derived(linkPostMentions(doc));
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
  const ogTitle = $derived(`${title} · ${blogName}`);
  const published = $derived(doc.publishedAt || doc.createdAt);

  // This entry's own page on the connected publication's site, when there is one.
  // That's the post's home, so it takes the canonical URL and gets named below the
  // note; without it this page is the only address the entry has.
  const sourceUrl = $derived(safeHttpUrl(data.sourceUrl ?? undefined));
  const sourceHost = $derived(hostnameOf(sourceUrl ?? undefined));
  const canonicalUrl = $derived(sourceUrl ?? pageUrl);
</script>

<svelte:head>
  <title>{title} · {blogName}</title>
  {#if summary}<meta name="description" content={summary} />{/if}
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content={blogName} />
  <meta property="og:title" content={ogTitle} />
  {#if summary}<meta property="og:description" content={summary} />{/if}
  <meta property="og:url" content={pageUrl} />
  {#if icon}
    <meta property="og:image" content={icon} />
    <meta property="og:image:alt" content={blogName} />
  {/if}
  {#if published}<meta property="article:published_time" content={published} />{/if}
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content={ogTitle} />
  {#if summary}<meta name="twitter:description" content={summary} />{/if}
  {#if icon}<meta name="twitter:image" content={icon} />{/if}
  <link rel="canonical" href={canonicalUrl} />
  <link rel="alternate" type="application/rss+xml" title={blogName} href={feedUrl} />
</svelte:head>

<a class="back" href={backHref}><span aria-hidden="true">←</span> {blogName}</a>
<article class="entry-page">
  <h1 class="entry-title-lg">
    {#if articleUrl}<a href={articleUrl}>{title}</a>{:else}{title}{/if}
  </h1>
  <Meta {host} {date} {social} />
  {#if note}
    <!-- The user-controlled body: restricted Markdown (blockquotes only) + @mention
         links, rendered to escaped, self-generated HTML (see renderBodyHtml). -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div class="entry-note-lg">{@html renderBodyHtml(note, mentions)}</div>
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
  {#if sourceUrl}
    <p class="pubhome">
      Published on <a href={sourceUrl} rel="noopener noreferrer">{sourceHost}</a>
    </p>
  {/if}
  <AlsoLinkedBy ctx={data.ctx} />
</article>
<footer class="foot">
  A linkblog on <a href={data.appUrl}>Skyreader</a>, stored in the Atmosphere.
</footer>
