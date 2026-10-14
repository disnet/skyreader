<script lang="ts">
  import { onMount } from 'svelte';
  import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
  import type {
    PDFDocumentLoadingTask,
    PDFDocumentProxy,
    PDFPageProxy,
    RenderTask,
  } from 'pdfjs-dist';
  import Icon from '$lib/components/Icon.svelte';

  /**
   * A saved PDF as it was printed: every page drawn by PDF.js, with its text
   * layer on top so passages can be selected and copied. It is the companion to
   * the reflowed text the reader shows by default (where highlights and notes
   * live) — the place to look at figures, tables, equations and layout.
   *
   * PDF.js is loaded on first use, so readers who never open an original never
   * download it. Pages are drawn only near the viewport and dropped again when
   * they scroll far away, so a 300-page paper costs what a few pages cost.
   */
  interface Props {
    /** Where the PDF's bytes come from (sent with the session cookie). */
    src?: string;
    /** The bytes themselves, when the caller already has them (the dev harness). */
    data?: Uint8Array;
    /** What a failure offers instead: the PDF itself, in a new tab. */
    fallbackHref?: string;
    /** Height of chrome fixed over the bottom edge (the mobile reader bar), in px. */
    bottomInset?: number;
  }

  let { src, data: givenData, fallbackHref, bottomInset = 0 }: Props = $props();

  type Status = 'loading' | 'ready' | 'error';
  let status = $state<Status>('loading');
  let errorMessage = $state('');

  // Natural page sizes (PDF points at scale 1), known before anything is drawn
  // so every page holds its place and the scrollbar is honest from the start.
  let pageSizes = $state<{ width: number; height: number }[]>([]);
  let currentPage = $state(1);

  // 1 = fit the column's width. Zoom multiplies it.
  const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  let zoom = $state(1);
  let availableWidth = $state(0);

  // Pages are capped at a comfortable reading width on a wide screen; fit-width
  // on a phone. Every page shares the first page's scale so mixed sizes stay true.
  const MAX_FIT_WIDTH = 900;
  let scale = $derived.by(() => {
    const first = pageSizes[0];
    if (!first || availableWidth <= 0) return 0;
    // Less the page's 1px border each side, so a fitted page never overflows.
    return ((Math.min(availableWidth, MAX_FIT_WIDTH) - 2) / first.width) * zoom;
  });

  let containerEl = $state<HTMLDivElement | null>(null);
  const pageEl = (n: number) =>
    containerEl?.querySelector<HTMLDivElement>(`.pdf-page[data-page="${n}"]`) ?? null;

  let doc: PDFDocumentProxy | null = null;
  let loadingTask: PDFDocumentLoadingTask | null = null;
  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null = null;

  interface Drawn {
    scale: number;
    task: RenderTask | null;
    textLayer: { cancel: () => void } | null;
  }
  const drawn = new Map<number, Drawn>();
  const nearViewport = new Set<number>();
  let destroyed = false;

  // iOS Safari refuses canvases past ~16.7M pixels; stay under it at any zoom.
  const MAX_CANVAS_PIXELS = 16_000_000;

  async function fetchBytes(url: string): Promise<Uint8Array> {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? 'The original PDF is no longer available.'
          : "Couldn't open the original PDF."
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async function load() {
    status = 'loading';
    try {
      const [lib, data] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        givenData ? Promise.resolve(givenData.slice()) : fetchBytes(src ?? ''),
      ]);
      pdfjs = lib;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      if (destroyed) return;
      // The image decoders (JPEG 2000, JBIG2, ICC colour) load from here, as
      // WebAssembly or their JS fallbacks; vite.config.ts's pdfjsDecoders()
      // ships them at this versioned path. They run in PDF.js's worker, a static
      // asset the page's CSP doesn't apply to.
      const wasmUrl = new URL(`/_app/immutable/pdfjs/${pdfjs.version}/`, location.origin).href;
      loadingTask = pdfjs.getDocument({ data, wasmUrl });
      doc = await loadingTask.promise;
      if (destroyed) {
        void loadingTask.destroy();
        return;
      }
      const sizes: { width: number; height: number }[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const vp = (await doc.getPage(n)).getViewport({ scale: 1 });
        sizes.push({ width: vp.width, height: vp.height });
      }
      pageSizes = sizes;
      status = 'ready';
    } catch (err) {
      if (destroyed) return;
      console.error('[PdfViewer] load failed:', err);
      const name = (err as { name?: string })?.name;
      errorMessage =
        name === 'PasswordException'
          ? 'This PDF is password-protected.'
          : err instanceof Error && err.message.startsWith('The original')
            ? err.message
            : "Couldn't open the original PDF.";
      status = 'error';
    }
  }

  function clearPage(n: number) {
    const d = drawn.get(n);
    if (!d) return;
    d.task?.cancel();
    d.textLayer?.cancel();
    drawn.delete(n);
    const el = pageEl(n);
    if (!el) return;
    el.querySelector('canvas')?.remove();
    const text = el.querySelector<HTMLDivElement>('.textLayer');
    if (text) text.replaceChildren();
  }

  async function drawPage(n: number) {
    if (!doc || !pdfjs || scale <= 0) return;
    const existing = drawn.get(n);
    if (existing && existing.scale === scale) return;
    clearPage(n);
    const el = pageEl(n);
    if (!el) return;

    const entry: Drawn = { scale, task: null, textLayer: null };
    drawn.set(n, entry);
    let page: PDFPageProxy;
    try {
      page = await doc.getPage(n);
    } catch {
      return;
    }
    if (drawn.get(n) !== entry) return;

    const viewport = page.getViewport({ scale });
    let ratio = window.devicePixelRatio || 1;
    const pixels = viewport.width * viewport.height * ratio * ratio;
    if (pixels > MAX_CANVAS_PIXELS)
      ratio = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.setAttribute('aria-hidden', 'true');
    el.prepend(canvas);

    entry.task = page.render({
      canvas,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    });
    try {
      await entry.task.promise;
    } catch (err) {
      // A cancelled render (scrolled away, rescaled) is expected.
      if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
        console.error('[PdfViewer] render failed:', err);
      }
      return;
    }
    if (drawn.get(n) !== entry) return;

    const textEl = el.querySelector<HTMLDivElement>('.textLayer');
    if (!textEl) return;
    textEl.replaceChildren();
    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textEl,
      viewport,
    });
    entry.textLayer = textLayer;
    await textLayer.render().catch(() => {});
  }

  // Draw what's near the viewport at the current scale; let the rest go.
  function sync() {
    for (const n of [...drawn.keys()]) {
      if (!nearViewport.has(n)) clearPage(n);
    }
    for (const n of nearViewport) void drawPage(n);
  }

  $effect(() => {
    void scale;
    if (status === 'ready') sync();
  });

  // Track which pages are near the viewport, and which one is in view.
  $effect(() => {
    if (status !== 'ready' || !containerEl) return;
    const near = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) nearViewport.add(n);
          else nearViewport.delete(n);
        }
        sync();
      },
      { rootMargin: '1200px 0px' }
    );
    const visible = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) currentPage = Number((e.target as HTMLElement).dataset.page);
        }
      },
      { rootMargin: '-45% 0px -45% 0px' }
    );
    for (const el of containerEl.querySelectorAll('.pdf-page')) {
      near.observe(el);
      visible.observe(el);
    }
    return () => {
      near.disconnect();
      visible.disconnect();
    };
  });

  onMount(() => {
    const resize = new ResizeObserver(([entry]) => {
      // Rounded so sub-pixel jitter doesn't redraw every page.
      const width = Math.floor(entry.contentRect.width);
      if (Math.abs(width - availableWidth) > 2) availableWidth = width;
    });
    if (containerEl) resize.observe(containerEl);
    void load();
    return () => {
      destroyed = true;
      resize.disconnect();
      for (const n of [...drawn.keys()]) clearPage(n);
      void loadingTask?.destroy();
      loadingTask = null;
      doc = null;
    };
  });

  function stepZoom(direction: 1 | -1) {
    const i = ZOOM_STEPS.indexOf(zoom);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + direction))];
    if (next !== undefined) zoom = next;
  }
</script>

<div class="pdf-viewer" bind:this={containerEl}>
  {#if status === 'loading'}
    <p class="pdf-status">Opening the PDF…</p>
  {:else if status === 'error'}
    <div class="pdf-status">
      <p>{errorMessage}</p>
      {#if fallbackHref}
        <a href={fallbackHref} target="_blank" rel="noopener">Open it in a new tab</a>
      {/if}
    </div>
  {:else}
    <div class="pdf-pages" style:--scale-factor={scale} style:--total-scale-factor={scale}>
      {#each pageSizes as size, i (i)}
        <div
          class="pdf-page"
          data-page={i + 1}
          style:width="{Math.floor(size.width * scale) + 2}px"
          style:height="{Math.floor(size.height * scale) + 2}px"
          role="img"
          aria-label="Page {i + 1} of {pageSizes.length}"
        >
          <div class="textLayer"></div>
        </div>
      {/each}
    </div>

    <div
      class="pdf-toolbar"
      role="toolbar"
      aria-label="PDF view"
      style:bottom="calc(1rem + {bottomInset}px)"
    >
      <span class="pdf-page-count" aria-live="polite">{currentPage} / {pageSizes.length}</span>
      <button
        type="button"
        onclick={() => stepZoom(-1)}
        disabled={zoom === ZOOM_STEPS[0]}
        aria-label="Zoom out">−</button
      >
      <button
        type="button"
        class="pdf-fit"
        onclick={() => (zoom = 1)}
        disabled={zoom === 1}
        title="Fit to width">{Math.round(zoom * 100)}%</button
      >
      <button
        type="button"
        onclick={() => stepZoom(1)}
        disabled={zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
        aria-label="Zoom in">+</button
      >
      {#if fallbackHref}
        <a
          href={fallbackHref}
          target="_blank"
          rel="noopener"
          class="pdf-open"
          title="Open the PDF in a new tab"
          aria-label="Open the PDF in a new tab"
        >
          <Icon name="external-link" size={14} />
        </a>
      {/if}
    </div>
  {/if}
</div>

<style>
  .pdf-viewer {
    width: 100%;
    min-height: 50vh;
  }

  .pdf-status {
    padding: 3rem 1rem;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  .pdf-status a {
    color: var(--color-primary, #0066cc);
  }

  /* Wider than the column when zoomed in: scroll sideways within the viewer. */
  .pdf-pages {
    display: flex;
    flex-direction: column;
    /* Not align-items: center, which would push a zoomed page's left edge out
       of reach; auto margins centre a page only while it fits. */
    align-items: flex-start;
    gap: 1rem;
    padding-bottom: 4.5rem;
    overflow-x: auto;
  }

  /* A page is paper: white in either theme, the one surface here that floats
     over the reading room, so it earns a hairline rather than a shadow. */
  /* Sized as the drawing plus its 1px border (the app is border-box). */
  .pdf-page {
    position: relative;
    flex: none;
    margin: 0 auto;
    background: #fff;
    border: 1px solid var(--color-border);
  }

  .pdf-page :global(canvas) {
    display: block;
  }

  /* PDF.js's text layer (from pdfjs-dist/web/pdf_viewer.css, trimmed): the
     page's text, transparent, positioned over the drawing so it selects and
     copies like text. */
  .pdf-page :global(.textLayer) {
    position: absolute;
    inset: 0;
    overflow: clip;
    line-height: 1;
    text-align: initial;
    letter-spacing: normal;
    word-spacing: normal;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    z-index: 0;
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
  }

  .pdf-page :global(.textLayer :is(span, br)) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
    user-select: text;
  }

  .pdf-page :global(.textLayer > :not(.markedContent)),
  .pdf-page :global(.textLayer .markedContent span:not(.markedContent)) {
    z-index: 1;
    --font-height: 0;
    font-size: calc(var(--text-scale-factor) * var(--font-height));
    --scale-x: 1;
    --rotate: 0deg;
    transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
  }

  .pdf-page :global(.textLayer .markedContent) {
    display: contents;
  }

  .pdf-page :global(.textLayer ::selection) {
    background: rgba(0, 102, 204, 0.25);
    color: transparent;
  }

  .pdf-page :global(.textLayer .endOfContent) {
    display: block;
    position: absolute;
    inset: 100% 0 0;
    z-index: 0;
    cursor: default;
    user-select: none;
  }

  /* Floats over the pages, so it alone gets elevation. */
  .pdf-toolbar {
    position: sticky;
    bottom: 1rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    width: max-content;
    margin: -3.5rem auto 0;
    padding: 0.25rem 0.5rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    z-index: 2;
  }

  .pdf-page-count {
    padding: 0 0.5rem;
    font-variant-numeric: tabular-nums;
  }

  .pdf-toolbar button,
  .pdf-open {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2rem;
    height: 2rem;
    padding: 0 0.375rem;
    background: none;
    border: none;
    border-radius: 999px;
    color: var(--color-text);
    font-size: var(--text-md);
    cursor: pointer;
  }

  .pdf-toolbar .pdf-fit {
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .pdf-toolbar button:hover:not(:disabled),
  .pdf-open:hover {
    background: var(--color-bg-secondary);
  }

  .pdf-toolbar button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
