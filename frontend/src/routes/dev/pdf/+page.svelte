<script lang="ts">
  // Harness for the original-PDF view (PdfViewer): a multi-page PDF built in
  // memory, drawn by PDF.js with its text layer. `?src=<url>` views another PDF
  // instead (it must allow this origin to fetch it, and the dev CSP's connect-src must allow it). No auth, no backend.
  //
  // Highlighting is live but local: selecting text (mouse release, or a touch
  // selection let go of) highlights it at once, a tap on a highlight removes it,
  // and the sample opens with one that crosses from page 1 onto page 2. Page 1's
  // top line carries links: two into the document and one out of it. Zoom and
  // place are remembered per `src` (or per sample) on this device; a save's
  // place syncs as an item label instead.
  import { page } from '$app/state';
  import PdfViewer from '$lib/components/feed/PdfViewer.svelte';
  import type { Highlight, TextQuoteSelector } from '$lib/types';
  import { isPdfPlace, type PdfPlace } from '$lib/utils/pdfPlace';
  import { makePdf, type Placed, type PlacedLink } from '../_harness/pdfFixture';
  import { SAMPLE_JPX_BASE64, makeJpxPdf } from '../_harness/jpxPdf';

  const LOREM =
    'The dominant sequence transduction models are based on complex recurrent or convolutional';

  function samplePdf(): Uint8Array {
    const pages: Placed[][] = [];
    for (let p = 1; p <= 12; p++) {
      const lines: Placed[] = [[72, 720, 20, `Section ${p}: A heading on page ${p}`]];
      for (let i = 0; i < 28; i++) lines.push([72, 680 - i * 20, 11, `${LOREM} ${p}.${i + 1}`]);
      pages.push(lines);
    }
    pages[0].unshift(
      [72, 750, 9, 'Jump to Section 5'],
      [180, 750, 9, 'Section 12'],
      [250, 750, 9, 'The paper on arXiv']
    );
    const links: PlacedLink[][] = [
      [
        { rect: [70, 746, 150, 760], page: 4, top: 740 },
        { rect: [178, 746, 226, 760], page: 11 },
        { rect: [248, 746, 336, 760], url: 'https://arxiv.org/abs/1706.03762' },
      ],
    ];
    return makePdf(pages, { Title: 'Harness paper' }, links);
  }

  // `?sample=jpx`: a JPEG 2000 image, which only draws when PDF.js finds its
  // OpenJPEG decoder at `wasmUrl`.
  function jpxPdf(): Uint8Array {
    const jpx = Uint8Array.from(atob(SAMPLE_JPX_BASE64), (c) => c.charCodeAt(0));
    return makeJpxPdf(jpx, 160, 100);
  }

  const src = page.url.searchParams.get('src') ?? undefined;
  const data = src
    ? undefined
    : page.url.searchParams.get('sample') === 'jpx'
      ? jpxPdf()
      : samplePdf();

  // Stands in for the item label a save's place is synced as.
  const harnessKey = `dev-harness:${src ?? page.url.searchParams.get('sample') ?? 'sample'}`;
  const PLACE_KEY = 'skyreader-dev-pdf-place';
  function storedPlace(): PdfPlace | null {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(PLACE_KEY) ?? '{}')[harnessKey];
      return isPdfPlace(value) ? value : null;
    } catch {
      return null;
    }
  }
  const harnessPlace = storedPlace();
  function rememberPlace(place: PdfPlace) {
    try {
      const all = JSON.parse(localStorage.getItem(PLACE_KEY) ?? '{}');
      localStorage.setItem(PLACE_KEY, JSON.stringify({ ...all, [harnessKey]: place }));
    } catch {
      // The harness forgets.
    }
  }

  const make = (selector: TextQuoteSelector): Highlight => ({
    id: Math.random().toString(36).slice(2),
    selector,
    createdAt: Date.now(),
  });
  let highlights = $state<Highlight[]>(
    src
      ? []
      : [
          make({
            type: 'TextQuoteSelector',
            exact: 'recurrent or convolutional 1.28 Section 2: A heading',
          }),
        ]
  );
  const add = (selector: TextQuoteSelector) => {
    highlights = [...highlights, make(selector)];
    window.getSelection()?.removeAllRanges();
  };
</script>

<div class="harness">
  <h1>PDF viewer</h1>
  <p class="count" data-testid="highlight-count">{highlights.length} highlights</p>
  <PdfViewer
    {src}
    {data}
    fallbackHref={src}
    {highlights}
    onselect={add}
    oncommit={add}
    onhighlight={(id) => (highlights = highlights.filter((h) => h.id !== id))}
    zoomKey={harnessKey}
    place={harnessPlace}
    onplace={rememberPlace}
  />
</div>

<style>
  .harness {
    min-height: 100vh;
    background: var(--color-bg);
    color: var(--color-text);
    padding: 1.5rem 1rem;
    max-width: 1100px;
    margin: 0 auto;
  }

  h1 {
    font-size: var(--text-lg);
    margin: 0 0 0.25rem;
  }

  .count {
    margin: 0 0 1rem;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
</style>
