<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
  import type {
    PDFDocumentLoadingTask,
    PDFDocumentProxy,
    PDFPageProxy,
    RenderTask,
  } from 'pdfjs-dist';
  import type { TextItem } from 'pdfjs-dist/types/src/display/api';
  import Icon from '$lib/components/Icon.svelte';
  import type { Highlight, TextQuoteSelector } from '$lib/types';
  import {
    buildPdfTextModel,
    locateInPdf,
    selectorForSpan,
    textOffsetAt,
    type PdfRunSlice,
    type PdfTextModel,
  } from '$lib/utils/pdfTextModel';
  import { resolvePdfLink, type PdfLinkAnnotation, type PdfLinkTarget } from '$lib/utils/pdfLinks';
  import { claimPdfZoomShortcuts, pdfZoom, setPdfZoom } from '$lib/utils/pdfZoom';
  import type { PdfPlace } from '$lib/utils/pdfPlace';
  import { flattenPdfOutline, type PdfOutlineEntry } from '$lib/utils/pdfOutline';

  /**
   * A saved PDF as it was printed: every page drawn by PDF.js, with its text
   * layer on top so passages can be selected, copied and highlighted. It is the
   * companion to the reflowed text the reader shows by default — the place to
   * look at figures, tables, equations and layout.
   *
   * Highlights are the reflowed text's: the same selectors, matched against a
   * model of the pages' text built the way the extractor reflowed it (see
   * `utils/pdfTextModel.ts`), so a passage marked in either view is marked in
   * both. This component only draws them and reports selections and taps; the
   * host decides what they do.
   *
   * PDF.js is loaded on first use, so readers who never open an original never
   * download it. Pages are drawn only near the viewport and dropped again when
   * they scroll far away, so a 300-page paper costs what a few pages cost.
   *
   * The PDF's own links work: a reference, a footnote mark or a table of
   * contents entry jumps to the page it points at (with a way back), and a web
   * link opens in a new tab (see `utils/pdfLinks.ts`).
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
    /** Highlights to draw on the pages. Setting it (or `onselect`) turns highlighting on. */
    highlights?: Highlight[];
    /** A passage selected with a mouse, released: offer to highlight it. */
    onselect?: (selector: TextQuoteSelector, range: Range) => void;
    /**
     * A touch selection let go of. Touch never gets a toolbar mid-selection, so
     * the phone's own Copy/Look Up menu stays usable; clearing the selection is
     * what makes the highlight, as in the text view.
     */
    oncommit?: (selector: TextQuoteSelector) => void;
    /** A drawn highlight was tapped. `getRect` is where it is now (null once gone). */
    onhighlight?: (id: string, getRect: () => DOMRect | null) => void;
    /** Remember the zoom under this key, and open at the zoom it was left at. */
    zoomKey?: string;
    /** Where to open: a page and how far down it (see `utils/pdfPlace.ts`). Followed until the reader scrolls. */
    place?: PdfPlace | null;
    /** The reader scrolled to a new place; debounced. */
    onplace?: (place: PdfPlace) => void;
    /** The PDF's outline (its bookmarks), once read; empty when it has none. */
    onoutline?: (entries: PdfOutlineEntry[]) => void;
  }

  let {
    src,
    data: givenData,
    fallbackHref,
    bottomInset = 0,
    highlights,
    onselect,
    oncommit,
    onhighlight,
    zoomKey,
    place,
    onplace,
    onoutline,
  }: Props = $props();

  const highlighting = $derived(Boolean(highlights || onselect));

  type Status = 'loading' | 'ready' | 'error';
  let status = $state<Status>('loading');
  let errorMessage = $state('');

  // Natural page sizes (PDF points at scale 1), known before anything is drawn
  // so every page holds its place and the scrollbar is honest from the start.
  let pageSizes = $state<{ width: number; height: number }[]>([]);
  let currentPage = $state(1);

  // 1 = fit the column's width. Zoom multiplies it.
  const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  let zoom = $state(rememberedZoom());
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

  // Zoomed past the column, a page spills into the room beside it (the reader's
  // whole width, less a gutter), still centred on the column while it fits;
  // only a page wider than all of that scrolls sideways. `band` is that room,
  // each side of the column.
  const BAND_GUTTER = 16;
  let band = $state({ left: 0, right: 0 });

  /** Where a page `width` px wide (border included) sits in the band. */
  function pageInset(width: number): number {
    const room = band.left + availableWidth + band.right;
    const centred = band.left + (availableWidth - width) / 2;
    return Math.max(0, Math.min(centred, room - width));
  }

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
    /** The text layer's spans, one per text run, once it has rendered. */
    runs: HTMLElement[] | null;
  }
  const drawn = new Map<number, Drawn>();
  const nearViewport = new Set<number>();
  let destroyed = false;

  // The whole document's text, read once in the background when highlighting
  // is on. Highlights can't be drawn or made until it's in: a selector's
  // context can reach across pages, so it is matched against all of them.
  let model = $state.raw<PdfTextModel | null>(null);
  // The open document, once its pages are showing; the text read waits on it
  // and on `highlighting`, which can turn on after the document has loaded.
  let readyDoc = $state.raw<PDFDocumentProxy | null>(null);
  let textRequested = false;
  // Which page and run a text-layer span draws (pages 0-based, as the model's).
  const runOf = new WeakMap<Element, { page: number; run: number }>();

  // Where each followed in-document link was read from, so the reader can go
  // back: the scroller and its offset, and the page that was in view.
  type ReturnPoint = { page: number; scroller: Element; top: number };
  let returnTo = $state.raw<ReturnPoint[]>([]);
  const MAX_RETURNS = 20;

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
      // Show the pages as soon as the first is measured: every page holds the
      // first one's size until its own arrives, which for most documents is the
      // same. Measuring them all first was one worker round trip per page.
      const first = (await doc.getPage(1)).getViewport({ scale: 1 });
      if (destroyed) return;
      pageSizes = Array.from({ length: doc.numPages }, () => ({
        width: first.width,
        height: first.height,
      }));
      status = 'ready';
      void measurePages(doc);
      readyDoc = doc;
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

  // The rest of the pages' sizes, asked for together. Applied once, and only if
  // a page differs from the first, so a uniform document never reflows.
  async function measurePages(pdf: PDFDocumentProxy) {
    let sizes: { width: number; height: number }[];
    try {
      sizes = await Promise.all(
        Array.from({ length: pdf.numPages }, async (_, i) => {
          const vp = (await pdf.getPage(i + 1)).getViewport({ scale: 1 });
          return { width: vp.width, height: vp.height };
        })
      );
    } catch {
      // A page that won't open keeps the first page's size; drawing it fails quietly.
      return;
    }
    if (destroyed || doc !== pdf) return;
    const differs = sizes.some(
      (size, i) => size.width !== pageSizes[i]?.width || size.height !== pageSizes[i]?.height
    );
    if (differs) pageSizes = sizes;
  }

  // Every page's text, one page at a time so drawing the first pages isn't
  // queued behind it in the worker. The same `getTextContent()` defaults the
  // extractor and the text layer use, so the runs line up with both.
  async function readText(pdf: PDFDocumentProxy) {
    const pages: TextItem[][] = [];
    try {
      for (let i = 1; i <= pdf.numPages; i++) {
        const content = await (await pdf.getPage(i)).getTextContent();
        if (destroyed || doc !== pdf) return;
        pages.push(content.items.filter((item): item is TextItem => 'str' in item));
      }
    } catch (err) {
      // Without the text the pages still read; they just can't be highlighted.
      console.error('[PdfViewer] text read failed:', err);
      return;
    }
    model = buildPdfTextModel(pages);
  }

  // The outline is the reader's contents list here. Read once per document.
  $effect(() => {
    const pdf = readyDoc;
    // Not tracked: a new callback is no reason to read the outline again.
    const report = untrack(() => onoutline);
    if (!pdf || !report) return;
    let stale = false;
    pdf
      .getOutline()
      .then((outline) => flattenPdfOutline(pdf, outline))
      .then((entries) => {
        if (!stale) report(entries);
      })
      .catch((err) => console.error('[PdfViewer] outline read failed:', err));
    return () => {
      stale = true;
    };
  });

  /** The page in view, 1-based. */
  export function pageInView(): number {
    return currentPage;
  }

  /** Go to a place in the PDF (an outline entry's), with a way back. */
  export function goTo(target: { page: number; top: number | null }) {
    void jumpTo(target);
  }

  $effect(() => {
    if (!highlighting || !readyDoc || textRequested) return;
    textRequested = true;
    void readText(readyDoc);
  });

  // Where each highlight falls, grouped by page (0-based).
  let marksByPage = $derived.by(() => {
    // `note`: the highlight has a note and ends on this page, where it's marked.
    const byPage = new Map<number, { id: string; note: boolean; slices: PdfRunSlice[] }[]>();
    if (!model || !highlights) return byPage;
    for (const highlight of highlights) {
      const slices = locateInPdf(model, highlight.selector);
      if (!slices) continue;
      const lastPage = slices[slices.length - 1].page;
      for (const page of new Set(slices.map((s) => s.page))) {
        const list = byPage.get(page) ?? [];
        list.push({
          id: highlight.id,
          note: Boolean(highlight.note) && page === lastPage,
          slices: slices.filter((s) => s.page === page),
        });
        byPage.set(page, list);
      }
    }
    return byPage;
  });

  /**
   * Draw a page's highlights as boxes under its text layer, measured from the
   * spans they cover. Under, so the text above stays selectable; multiplied, so
   * the ink tints the paper without veiling the type.
   */
  function paintPage(n: number) {
    const el = pageEl(n);
    const layer = el?.querySelector<HTMLDivElement>('.pdf-marks');
    if (!el || !layer) return;
    layer.replaceChildren();
    const runs = drawn.get(n)?.runs;
    const marks = marksByPage.get(n - 1);
    if (!runs || !marks) return;
    const origin = el.getBoundingClientRect();
    const range = document.createRange();
    for (const { id, note, slices } of marks) {
      let last: HTMLElement | null = null;
      for (const slice of slices) {
        const text = runs[slice.run]?.firstChild;
        if (!text || text.nodeType !== Node.TEXT_NODE) continue;
        const length = text.textContent?.length ?? 0;
        range.setStart(text, Math.min(slice.from, length));
        range.setEnd(text, Math.min(slice.to, length));
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          const mark = document.createElement('div');
          mark.className = 'pdf-mark';
          mark.dataset.highlightId = id;
          mark.style.left = `${rect.left - origin.left - el.clientLeft}px`;
          mark.style.top = `${rect.top - origin.top - el.clientTop}px`;
          mark.style.width = `${rect.width}px`;
          mark.style.height = `${rect.height}px`;
          layer.append(mark);
          last = mark;
        }
      }
      // A note is marked where its passage ends, as in the text.
      if (note && last) last.classList.add('has-note');
    }
  }

  $effect(() => {
    void marksByPage;
    for (const n of drawn.keys()) paintPage(n);
  });

  /** The live mark boxes of one highlight, in page order. */
  function marksOf(id: string): HTMLElement[] {
    return Array.from(
      containerEl?.querySelectorAll<HTMLElement>(
        `.pdf-mark[data-highlight-id="${CSS.escape(id)}"]`
      ) ?? []
    );
  }

  // --- Selecting and tapping on the pages ---

  /**
   * Where a selection boundary falls in the model's text. Usually inside a
   * run's span; otherwise (between runs, on a page's edge) at the nearest run
   * on the selection's side of it.
   */
  function boundaryOffset(node: Node, offset: number, side: 'start' | 'end'): number | null {
    if (!model) return null;
    const at =
      node.nodeType === Node.TEXT_NODE && node.parentElement && runOf.get(node.parentElement);
    if (at) return textOffsetAt(model, at.page, at.run, offset);
    const point = document.createRange();
    point.setStart(node, offset);
    const spans = Array.from(
      containerEl?.querySelectorAll<HTMLElement>('.textLayer span') ?? []
    ).filter((span) => runOf.has(span));
    // comparePoint(span, 0) >= 0: the span starts at or after the boundary.
    const span =
      side === 'start'
        ? spans.find((s) => point.comparePoint(s, 0) >= 0)
        : spans.findLast((s) => point.comparePoint(s, 0) < 0);
    const run = span && runOf.get(span);
    if (!run) return null;
    return textOffsetAt(
      model,
      run.page,
      run.run,
      side === 'start' ? 0 : (span.textContent?.length ?? 0)
    );
  }

  /** The selector for the live selection, when it lies on the pages and says something. */
  function selectionSelector(): { selector: TextQuoteSelector; range: Range } | null {
    const selection = window.getSelection();
    if (!model || !selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const pages = containerEl?.querySelector('.pdf-pages');
    if (!pages?.contains(range.commonAncestorContainer)) return null;
    const start = boundaryOffset(range.startContainer, range.startOffset, 'start');
    const end = boundaryOffset(range.endContainer, range.endOffset, 'end');
    if (start === null || end === null) return null;
    const selector = selectorForSpan(model, start, end);
    if (!selector || selector.exact.length < 3) return null;
    return { selector, range };
  }

  // A press that began on the pages, so its release is a selection gesture
  // (and not, say, the zoom buttons'). Listened for on the document, so a drag
  // released past the edge of the page still counts.
  let pressOnPages = false;
  let touching = false;
  let pendingTouch: TextQuoteSelector | null = null;

  function handlePointerDown(e: PointerEvent) {
    touching = e.pointerType !== 'mouse';
    const target = e.target as Element | null;
    pressOnPages = Boolean(target?.closest?.('.pdf-page') && containerEl?.contains(target));
  }

  function handleMouseUp() {
    if (!pressOnPages || touching || !onselect) return;
    // Let the selection settle.
    setTimeout(() => {
      const found = selectionSelector();
      if (found) onselect?.(found.selector, found.range);
    }, 10);
  }

  function handleSelectionChange() {
    if (!touching || !oncommit) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      pendingTouch = selectionSelector()?.selector ?? null;
      return;
    }
    const selector = pendingTouch;
    pendingTouch = null;
    if (selector) oncommit(selector);
  }

  // A tap on a highlight. The text layer is on top, so it's found by where the
  // tap landed rather than by what it hit; a drag that selected text isn't one.
  function handleClick(e: MouseEvent) {
    if (!onhighlight || !window.getSelection()?.isCollapsed) return;
    const page = (e.target as Element | null)?.closest?.('.pdf-page');
    if (!page) return;
    for (const mark of page.querySelectorAll<HTMLElement>('.pdf-mark')) {
      const r = mark.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        continue;
      const id = mark.dataset.highlightId;
      if (!id) return;
      onhighlight(id, () => marksOf(id)[0]?.getBoundingClientRect() ?? null);
      return;
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
    el.querySelector('.pdf-marks')?.replaceChildren();
    el.querySelector('.pdf-links')?.replaceChildren();
  }

  // --- Links ---

  /**
   * The page's link annotations as anchors over the text layer: a web link
   * opens in a new tab, an in-document one jumps. Destinations are resolved
   * up front, so each link can say where it goes.
   */
  async function drawLinks(
    n: number,
    page: PDFPageProxy,
    viewport: ReturnType<PDFPageProxy['getViewport']>,
    entry: Drawn
  ) {
    const pdf = doc;
    if (!pdf) return;
    let resolved: { rect: number[]; target: PdfLinkTarget }[];
    try {
      const annotations: PdfLinkAnnotation[] = await page.getAnnotations({ intent: 'display' });
      const links = annotations.filter((a) => a.subtype === 'Link' && a.rect?.length === 4);
      resolved = (
        await Promise.all(
          links.map(async (a) => ({ rect: a.rect!, target: await resolvePdfLink(pdf, a, n - 1) }))
        )
      ).filter((l): l is { rect: number[]; target: PdfLinkTarget } => l.target !== null);
    } catch {
      // Without its links the page still reads.
      return;
    }
    if (drawn.get(n) !== entry) return;
    const layer = pageEl(n)?.querySelector<HTMLDivElement>('.pdf-links');
    if (!layer) return;
    layer.replaceChildren();
    for (const { rect, target } of resolved) {
      const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
      const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
      const link = document.createElement('a');
      link.style.left = `${Math.min(x1, x2)}px`;
      link.style.top = `${Math.min(y1, y2)}px`;
      link.style.width = `${Math.abs(x2 - x1)}px`;
      link.style.height = `${Math.abs(y2 - y1)}px`;
      link.draggable = false;
      if (target.kind === 'url') {
        link.href = target.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = target.href;
      } else {
        link.href = `#page=${target.page + 1}`;
        link.title = `Go to page ${target.page + 1}`;
        link.dataset.page = String(target.page + 1);
        link.addEventListener('click', (e) => {
          e.preventDefault();
          void jumpTo(target);
        });
      }
      // A link isn't a tap on a highlight it happens to sit on.
      link.addEventListener('click', (e) => e.stopPropagation());
      layer.append(link);
    }
  }

  /** The element that scrolls the pages vertically: the reader overlay, or the page itself. */
  function scrollerOf(el: Element): Element {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const { overflowY } = getComputedStyle(p);
      if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight)
        return p;
    }
    return document.scrollingElement ?? document.documentElement;
  }

  /** The element whose width the reader has: the reader overlay, or the page. */
  function hostOf(el: Element): Element {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const { overflowY } = getComputedStyle(p);
      if (overflowY === 'auto' || overflowY === 'scroll') return p;
    }
    return document.documentElement;
  }

  function measureBand() {
    if (!containerEl) return;
    const host = hostOf(containerEl);
    let left = 0;
    if (host !== document.documentElement)
      left = host.getBoundingClientRect().left + host.clientLeft;
    const right = left + host.clientWidth;
    const column = containerEl.getBoundingClientRect();
    const next = {
      left: Math.max(0, Math.floor(column.left - left - BAND_GUTTER)),
      right: Math.max(0, Math.floor(right - BAND_GUTTER - column.right)),
    };
    if (next.left !== band.left || next.right !== band.right) band = next;
  }

  /** Bring a point `y` px down page `n` to the top of the view. */
  function scrollToPoint(n: number, y: number) {
    const el = pageEl(n);
    if (!el) return;
    // A throwaway element at the point lets the browser find the scroller and
    // honour the scroll margin, whatever is hosting the viewer.
    const marker = document.createElement('div');
    marker.className = 'pdf-jump';
    marker.style.top = `${Math.max(0, y)}px`;
    el.append(marker);
    marker.scrollIntoView({ block: 'start', inline: 'nearest' });
    marker.remove();
  }

  async function jumpTo(target: { page: number; top: number | null }) {
    if (!doc || !containerEl) return;
    let y = 0;
    if (target.top !== null) {
      try {
        const page = await doc.getPage(target.page + 1);
        y = page.getViewport({ scale }).convertToViewportPoint(0, target.top)[1];
      } catch {
        // The page's top will do.
      }
    }
    const scroller = scrollerOf(containerEl);
    returnTo = [
      ...returnTo.slice(-(MAX_RETURNS - 1)),
      { page: currentPage, scroller, top: scroller.scrollTop },
    ];
    scrollToPoint(target.page + 1, y);
  }

  function goBack() {
    const point = returnTo[returnTo.length - 1];
    if (!point) return;
    returnTo = returnTo.slice(0, -1);
    point.scroller.scrollTo({ top: point.top });
  }

  // A saved offset means nothing at another scale.
  $effect(() => {
    void scale;
    returnTo = [];
  });

  async function drawPage(n: number) {
    if (!doc || !pdfjs || scale <= 0) return;
    const existing = drawn.get(n);
    if (existing && existing.scale === scale) return;
    clearPage(n);
    const el = pageEl(n);
    if (!el) return;

    const entry: Drawn = { scale, task: null, textLayer: null, runs: null };
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
    try {
      await textLayer.render();
    } catch {
      return;
    }
    if (drawn.get(n) !== entry) return;
    entry.runs = textLayer.textDivs;
    entry.runs.forEach((span, run) => runOf.set(span, { page: n - 1, run }));
    paintPage(n);
    await drawLinks(n, page, viewport, entry);
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
      measureBand();
    });
    if (containerEl) {
      resize.observe(containerEl);
      // The column can move without resizing (a centred column, a scrollbar).
      resize.observe(hostOf(containerEl));
    }
    window.addEventListener('resize', measureBand);
    void load();
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      destroyed = true;
      resize.disconnect();
      window.removeEventListener('resize', measureBand);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
      for (const n of [...drawn.keys()]) clearPage(n);
      void loadingTask?.destroy();
      loadingTask = null;
      doc = null;
    };
  });

  /** Where the top of the scroller's view is, in viewport px. */
  function topOf(scroller: Element): number {
    return scroller === document.scrollingElement || scroller === document.documentElement
      ? 0
      : scroller.getBoundingClientRect().top + scroller.clientTop;
  }

  /** Where the middle of the scroller's view is, in viewport px. */
  function middleOf(scroller: Element): number {
    return topOf(scroller) + scroller.clientHeight / 2;
  }

  /**
   * The page in the middle of the view, and how far down it the middle is —
   * except once the end of the last page is in view, which is the bottom of
   * the last page: the middle of the view can't get that far, so without this
   * a PDF read to the end would never count as finished.
   */
  function placeInView(): PdfPlace | null {
    if (!containerEl || status !== 'ready') return null;
    const scroller = scrollerOf(containerEl);
    const last = pageEl(pageSizes.length);
    if (last) {
      const rect = last.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom <= topOf(scroller) + scroller.clientHeight + 1) {
        return { page: pageSizes.length, at: 1, pages: pageSizes.length };
      }
    }
    const middle = middleOf(scroller);
    // Start from the page the observer last saw there, and step to the one the
    // middle is really on if a fast scroll has outrun it.
    let page = currentPage;
    let step = 0;
    for (;;) {
      const el = pageEl(page);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) return null;
      const at = (middle - rect.top) / rect.height;
      // Below this page's bottom: a later one. Above its top (past the gap
      // between pages): an earlier one. One direction only, then settle.
      const next = at > 1 ? 1 : at < 0 && middle < rect.top - 32 ? -1 : 0;
      const to = page + next;
      if (next === 0 || next === -step || to < 1 || to > pageSizes.length) {
        return { page, at: Math.min(1, Math.max(0, at)), pages: pageSizes.length };
      }
      step = next;
      page = to;
    }
  }

  /** Scroll so a place is in the middle of the view. */
  function goToPlace(place: PdfPlace) {
    if (!containerEl) return;
    const el = pageEl(Math.min(place.page, pageSizes.length));
    if (!el) return;
    const scroller = scrollerOf(containerEl);
    const rect = el.getBoundingClientRect();
    scroller.scrollTop += rect.top + place.at * rect.height - middleOf(scroller);
  }

  // Open where this PDF was left, and stay there until the reader moves: put
  // back once the pages are laid out, again if they change size (the rest of
  // the pages measured, the column resized), and if `place` arrives late (a
  // sync from another device). The place is relative to a page, so it holds
  // where an offset wouldn't. Once the reader scrolls, the view is theirs.
  let following = true;
  // Where the view was last put, to tell the reader's scrolling from ours.
  let placedTop: number | null = null;
  $effect(() => {
    void pageSizes;
    const target = place;
    if (status !== 'ready' || scale <= 0) return;
    void tick().then(() => {
      if (destroyed || !containerEl || !following) return;
      const scroller = scrollerOf(containerEl);
      if (target) goToPlace(target);
      placedTop = scroller.scrollTop;
    });
  });

  // Report the place as the reader scrolls: measured once a frame, reported a
  // moment after the scrolling stops, and on the way out. Nothing is reported
  // until the reader has scrolled, so opening at the top can't overwrite it.
  onMount(() => {
    let frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latest: PdfPlace | null = null;
    const report = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (latest) onplace?.(latest);
      latest = null;
    };
    const onScroll = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!containerEl || placedTop === null) return;
        if (following) {
          if (Math.abs(scrollerOf(containerEl).scrollTop - placedTop) <= 1) return;
          following = false;
        }
        const now = placeInView();
        if (!now) return;
        latest = now;
        if (timer) clearTimeout(timer);
        timer = setTimeout(report, 500);
      });
    };
    // Captured on the document, so it hears the reader overlay's scroll as well
    // as the page's, whichever is hosting the viewer.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('pagehide', report);
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('pagehide', report);
      if (frame !== null) cancelAnimationFrame(frame);
      report();
    };
  });

  /** Zoom, keeping what's in the middle of the view in the middle of the view. */
  async function setZoom(next: number) {
    if (next === zoom || !containerEl) return;
    const scroller = scrollerOf(containerEl);
    const pages = containerEl.querySelector<HTMLElement>('.pdf-pages');
    const middle = middleOf(scroller);
    const anchor = pageEl(currentPage);
    const before = anchor?.getBoundingClientRect();
    const across = before ? (middle - before.top) / before.height : null;
    const sideways = pages
      ? (pages.scrollLeft + pages.clientWidth / 2) / Math.max(1, pages.scrollWidth)
      : 0.5;

    zoom = next;
    if (zoomKey) setPdfZoom(zoomKey, next);
    await tick();

    if (anchor && across !== null) {
      const after = anchor.getBoundingClientRect();
      scroller.scrollTop += after.top + across * after.height - middle;
    }
    if (pages) pages.scrollLeft = sideways * pages.scrollWidth - pages.clientWidth / 2;
  }

  function rememberedZoom(): number {
    const remembered = zoomKey ? pdfZoom(zoomKey) : 1;
    return ZOOM_STEPS.includes(remembered) ? remembered : 1;
  }

  function stepZoom(direction: 1 | -1) {
    const i = ZOOM_STEPS.indexOf(zoom);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + direction))];
    if (next !== undefined) void setZoom(next);
  }

  // The font-size shortcuts zoom the pages while this view is open.
  onMount(() => claimPdfZoomShortcuts({ step: stepZoom, reset: () => void setZoom(1) }));
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
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions
         (a tap on a highlight is a pointer shortcut; the passage is text) -->
    <div
      class="pdf-pages"
      style:--scale-factor={scale}
      style:--total-scale-factor={scale}
      style:margin-left="{-band.left}px"
      style:margin-right="{-band.right}px"
      onclick={handleClick}
    >
      {#each pageSizes as size, i (i)}
        {@const width = Math.floor(size.width * scale) + 2}
        <div
          class="pdf-page"
          data-page={i + 1}
          style:width="{width}px"
          style:margin-left="{pageInset(width)}px"
          style:height="{Math.floor(size.height * scale) + 2}px"
          role="img"
          aria-label="Page {i + 1} of {pageSizes.length}"
        >
          <div class="pdf-marks" aria-hidden="true"></div>
          <div class="textLayer"></div>
          <div class="pdf-links"></div>
        </div>
      {/each}
    </div>

    <div
      class="pdf-toolbar"
      role="toolbar"
      aria-label="PDF view"
      style:bottom="calc(1rem + {bottomInset}px)"
    >
      {#if returnTo.length}
        {@const back = returnTo[returnTo.length - 1].page}
        <button
          type="button"
          class="pdf-back"
          onclick={goBack}
          title="Back to page {back}"
          aria-label="Back to page {back}"
        >
          <Icon name="arrow-left" size={14} />
          {back}
        </button>
      {/if}
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
        onclick={() => void setZoom(1)}
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

  /* Bleeds past the column into the reader's width (negative margins, set from
     `band`); a page wider than that scrolls sideways here. Each page is placed
     by its own left margin, never align-items: center, which would push a
     zoomed page's left edge out of reach. */
  .pdf-pages {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
    padding-bottom: 4.5rem;
    overflow-x: auto;
    /* A zoom puts the view back itself (setZoom); the browser's own anchoring
       would fight it. */
    overflow-anchor: none;
  }

  /* A page is paper: white in either theme, the one surface here that floats
     over the reading room, so it earns a hairline rather than a shadow. */
  /* Sized as the drawing plus its 1px border (the app is border-box). */
  .pdf-page {
    position: relative;
    flex: none;
    background: #fff;
    border: 1px solid var(--color-border);
  }

  .pdf-page :global(canvas) {
    display: block;
  }

  /* Highlights: the reader's gold, laid under the text layer and multiplied
     into the drawing, so the type stays crisp black through it. */
  .pdf-marks {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .pdf-marks :global(.pdf-mark) {
    position: absolute;
    background: color-mix(in srgb, #f5c518 55%, transparent);
    mix-blend-mode: multiply;
  }

  /* A highlight with a note carries a small ink dot where it ends. */
  .pdf-marks :global(.pdf-mark.has-note)::after {
    content: '';
    position: absolute;
    top: -3px;
    right: -3px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #b8860b;
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

  /* A pale wash of the highlight gold, as in the text view: a selection reads
     as a highlight about to happen. */
  .pdf-page :global(.textLayer ::selection) {
    background: color-mix(in srgb, #f5c518 30%, transparent);
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

  /* Link areas: invisible over the drawing, as in a PDF reader, with the
     pointer saying what they are. Above the text layer, so they take the tap. */
  .pdf-links {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 1;
  }

  .pdf-links :global(a) {
    position: absolute;
    pointer-events: auto;
    cursor: pointer;
  }

  .pdf-links :global(a:focus-visible) {
    outline: 2px solid var(--color-primary, #0066cc);
    outline-offset: 1px;
  }

  /* Where a jump lands: clear of the reader's header. */
  .pdf-page :global(.pdf-jump) {
    position: absolute;
    left: 0;
    width: 1px;
    height: 1px;
    scroll-margin-top: 3.5rem;
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

  .pdf-toolbar .pdf-back {
    gap: 0.25rem;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
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
