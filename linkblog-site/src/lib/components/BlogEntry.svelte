<script lang="ts">
  import {
    articleExcerpt,
    clampText,
    entryUrlFor,
    externalArticleUrl,
    formatDate,
    hostnameOf,
    linkPostMentions,
    linkPostNote,
    renderBodyHtml,
    rkeyFromUri,
    safeHttpUrl,
    socialCountsText,
  } from '$lib/fields';
  import type { ProxyDocument, SocialContext } from '$lib/types';
  import Meta from './Meta.svelte';

  interface Props {
    origin: string;
    did: string;
    doc: ProxyDocument;
    ctx?: SocialContext;
  }
  let { origin, did, doc, ctx = undefined }: Props = $props();

  const rkey = $derived(rkeyFromUri(doc.recordUri));
  const permalink = $derived(rkey ? entryUrlFor(origin, did, rkey) : null);

  // Two distinct things: the user's own note (their voice, plain text) and a
  // snippet quoted from the article (the article's voice). The excerpt is dropped
  // when it just repeats the note.
  const note = $derived(linkPostNote(doc).trim());
  const mentions = $derived(linkPostMentions(doc));
  const excerpt = $derived(articleExcerpt(doc));
  const articleUrl = $derived(safeHttpUrl(externalArticleUrl(doc) || doc.canonicalUrl));
  // Daring-Fireball-style: the headline links out to the source article; the date
  // (in the meta row) is the subtle permalink to the commentary. Note-only posts
  // with no source fall back to the permalink as the headline link.
  const headlineHref = $derived(articleUrl ?? permalink);
  const host = $derived(hostnameOf(articleUrl ?? undefined));
  const date = $derived(formatDate(doc.createdAt || doc.publishedAt));
  const social = $derived(socialCountsText(ctx));
</script>

<li class="entry">
  <!-- The headline anchor stretches over the whole row (its ::after covers the
       <li>), so the entire entry is one calm tap target to the source article. The
       date in the meta row is raised above it as the permalink to the commentary. -->
  <h2 class="entry-title">
    {#if headlineHref}
      <a href={headlineHref}>{doc.title || 'Untitled'}</a>
    {:else}
      {doc.title || 'Untitled'}
    {/if}
  </h2>
  {#if note}
    <!-- Restricted Markdown (blockquotes only) + @mention links; the 280-char clamp
         keeps the preview short. -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div class="entry-note">{@html renderBodyHtml(note, mentions, 280)}</div>
  {/if}
  {#if excerpt && excerpt !== note}
    <!-- Legacy standalone quote (records predating the in-note quote). -->
    <blockquote class="entry-quote"><p>{clampText(excerpt, 200)}</p></blockquote>
  {/if}
  <Meta {host} {date} {permalink} {social} />
</li>
