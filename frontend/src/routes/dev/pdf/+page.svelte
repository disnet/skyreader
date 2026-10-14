<script lang="ts">
  // Harness for the original-PDF view (PdfViewer): a multi-page PDF built in
  // memory, drawn by PDF.js with its text layer. `?src=<url>` views another PDF
  // instead (it must allow this origin to fetch it, and the dev CSP's connect-src must allow it). No auth, no backend.
  import { page } from '$app/state';
  import PdfViewer from '$lib/components/feed/PdfViewer.svelte';
  import { makePdf, type Placed } from '../_harness/pdfFixture';
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
    return makePdf(pages, { Title: 'Harness paper' });
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
</script>

<div class="harness">
  <h1>PDF viewer</h1>
  <PdfViewer {src} {data} fallbackHref={src} />
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
    margin: 0 0 1rem;
  }
</style>
