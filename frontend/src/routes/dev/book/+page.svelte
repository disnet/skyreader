<script lang="ts">
  // Harness for paged reading of a long book: the real SavedReader over a
  // generated EPUB-shaped body (one <section data-epub-chapter> per chapter).
  // ?chapters=N sets the length (default 120, ~1.2M characters); ?at=P opens
  // with saved progress at paragraph P, to watch the restore land; ?pictures=1
  // adds a picture per chapter.
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';

  const chapters = Number(page.url.searchParams.get('chapters') ?? 120);
  const at = Number(page.url.searchParams.get('at') ?? 0);
  // ?pictures=1 opens each chapter with a picture, as an EPUB's arrive: a path
  // in the kept book, fetched from the (here absent) asset endpoint.
  const pictures = page.url.searchParams.get('pictures') === '1';
  const KEY = `at://did:plc:devharness/app.skyreader.feed.saved/book${chapters}`;

  const words =
    'the reader turned another page and found the sentence waiting where they had left it quiet patient and a little longer than expected as sentences in old books tend to be'.split(
      ' '
    );
  function paragraph(seed: number): string {
    const n = 60 + (seed % 70);
    let out = '';
    for (let i = 0; i < n; i++) out += (i ? ' ' : '') + words[(seed * 7 + i * 13) % words.length];
    return `<p>${out[0].toUpperCase()}${out.slice(1)}.</p>`;
  }
  let content = '';
  for (let c = 0; c < chapters; c++) {
    content += `<section data-epub-chapter="${c}"><h2>Chapter ${c + 1}</h2>`;
    if (pictures) content += `<p><img data-epub-src="images/ch${c}.png" alt=""></p>`;
    for (let p = 0; p < 40; p++) content += paragraph(c * 40 + p);
    content += '</section>';
  }

  const readerItem: FeedDisplayItem = {
    type: 'saved',
    key: KEY,
    item: {
      rkey: `book${chapters}`,
      uri: KEY,
      url: `https://example.com/books/${chapters}.epub`,
      title: 'A Long Book',
      author: 'A. Writer',
      description: 'Generated for the paged-reading harness.',
      content,
      contentType: 'epub',
      domain: 'example.com',
      image: null,
      wordCount: chapters * 40 * 95,
      publishedAt: '2026-09-01T12:00:00Z',
      savedAt: '2026-09-20T12:00:00Z',
      source: 'upload',
    },
  } as FeedDisplayItem;

  let ready = $state(false);
  onMount(async () => {
    if (at > 0) {
      itemLabelsStore.setReadProgress(KEY, 'saved', at, chapters * 40);
      await new Promise((r) => setTimeout(r, 2500));
    }
    ready = true;
  });
</script>

{#if ready}
  <SavedReader {readerItem} onClose={() => {}} />
{/if}
