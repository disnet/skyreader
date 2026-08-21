<script lang="ts">
  // The share composer: a non-modal card floating at the bottom of the screen
  // for drafting a linkblog share. The article stays scrollable behind and below
  // it — that's the point: draft on one side of your attention, gather quotes
  // with the other. Minimize it to a slim bar to read; quotes added from the
  // article land in the draft either way.
  //
  // The draft is an ordered list of blocks: commentary text and atomic quoted
  // passages. Quotes render as real blockquotes (the gold quotation rule), not
  // `> ` Markdown — serialization to the wire format happens on post. Create
  // mode auto-saves to a local draft; nothing is public until Post.
  //
  // Mounted once in AppShell and driven by shareComposerStore, so the drawer —
  // and the draft — survive closing the reader or navigating.
  import { tick } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import MentionAutocomplete from './MentionAutocomplete.svelte';
  import ShareConfirmModal from './ShareConfirmModal.svelte';
  import { shareComposerStore } from '$lib/stores/shareComposer.svelte';
  import { bottomBarInset } from '$lib/stores/bottomBarInset.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { formatQuoteSeed } from '$lib/utils/linkPost';
  import { positionFloating } from '$lib/utils/floating';

  const MAX = 3000;

  const composer = shareComposerStore;

  let session = $derived(composer.session);
  let article = $derived(session?.article);
  let isEdit = $derived(session?.mode === 'edit');

  let domain = $derived.by(() => {
    if (!article?.url) return '';
    try {
      return new URL(article.url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  });
  let faviconUrl = $derived(article?.url ? getFaviconUrl(article.url) : '');

  let noteLength = $derived(composer.note.length);
  let nearLimit = $derived(noteLength > MAX - 200);
  let overLimit = $derived(noteLength > MAX);

  // ── Quote picker ────────────────────────────────────────────────────────────
  // Saved highlights on the article, shown in full with their surrounding
  // context (prefix/suffix from the W3C selector) — no more one-line ellipsis.
  // The article's own excerpt is offered too, as the last entry.
  let quotesOpen = $state(false);
  let quotesBtnEl = $state<HTMLButtonElement | null>(null);
  let quotesPopupEl = $state<HTMLDivElement | null>(null);

  let highlightEntries = $derived.by(() => {
    if (!session) return [];
    const key = session.itemKey ?? session.article.guid ?? session.article.url;
    return itemLabelsStore.getHighlights(key);
  });
  let excerptQuote = $derived.by(() => {
    const seed = formatQuoteSeed(article?.summary);
    // formatQuoteSeed returns Markdown ('> …'); the picker wants the bare text.
    return seed ? seed.replace(/^>\s*/, '') : undefined;
  });
  let hasQuoteSources = $derived(highlightEntries.length > 0 || Boolean(excerptQuote));

  function positionQuotesPopup() {
    if (!quotesBtnEl || !quotesPopupEl) return;
    positionFloating(quotesBtnEl.getBoundingClientRect(), quotesPopupEl, {
      gap: 6,
      edge: 8,
      align: 'start',
      capHeight: true,
      minHeight: 120,
    });
  }

  $effect(() => {
    if (!quotesOpen) return;
    const reposition = () => positionQuotesPopup();
    requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  });

  function pickQuote(text: string) {
    composer.appendQuote(text);
    quotesOpen = false;
    void focusLastTextBlock();
  }

  // ── Blocks editing ──────────────────────────────────────────────────────────
  let blocksEl = $state<HTMLDivElement | null>(null);
  let textareaEls = $state<(HTMLTextAreaElement | null)[]>([]);

  function autosize(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }

  function autosizeAll() {
    for (const el of textareaEls) autosize(el);
  }

  async function focusLastTextBlock() {
    await tick();
    autosizeAll();
    for (let i = composer.blocks.length - 1; i >= 0; i--) {
      if (composer.blocks[i].kind === 'text') {
        const el = textareaEls[i];
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
        return;
      }
    }
  }

  // Textarea heights are set inline from their content, so a width change
  // (viewport resize, rotation) must re-measure every block.
  $effect(() => {
    if (!session || composer.minimized) return;
    const remeasure = () => autosizeAll();
    window.addEventListener('resize', remeasure);
    return () => window.removeEventListener('resize', remeasure);
  });

  // Focus the composer when a session opens or expands.
  let lastFocusKey = '';
  $effect(() => {
    const key = session && !composer.minimized ? `${session.article.url}:${session.mode}` : '';
    if (key && key !== lastFocusKey) {
      lastFocusKey = key;
      void focusLastTextBlock();
    }
    if (!key) lastFocusKey = '';
  });

  function handleBlockKeydown(e: KeyboardEvent) {
    // Keep typing from reaching feed/reader keyboard shortcuts.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (quotesOpen) quotesOpen = false;
      else composer.setMinimized(true);
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handlePost();
    }
  }

  // ── Discard (two-step) ──────────────────────────────────────────────────────
  let confirmingDiscard = $state(false);
  let discardTimer: ReturnType<typeof setTimeout> | undefined;

  function handleDiscard() {
    if (confirmingDiscard) {
      clearTimeout(discardTimer);
      confirmingDiscard = false;
      void composer.discard();
    } else {
      confirmingDiscard = true;
      discardTimer = setTimeout(() => (confirmingDiscard = false), 3000);
    }
  }

  // ── Post ────────────────────────────────────────────────────────────────────
  let showShareConfirm = $state(false);
  let postError = $state(false);

  async function handlePost() {
    if (!session || composer.posting || overLimit) return;
    if (session.mode === 'create' && !preferences.linkblogShareConfirmed) {
      showShareConfirm = true;
      return;
    }
    postError = false;
    const ok = await composer.post();
    if (!ok) postError = true;
  }

  // ── Height budget ───────────────────────────────────────────────────────────
  // The card is capped to the *visible* viewport, not the layout one. On mobile
  // the keyboard overlays the window without shrinking it — 100dvh still
  // reports the full screen — so a long draft grows the card down behind the
  // keyboard and takes the foot row (Post included) with it.
  // visualViewport.height is the strip actually left on screen. The blocks
  // region is the only part with min-height:0, so the whole squeeze lands there
  // and it scrolls; head, link card and foot keep their content height.
  //
  // The bottom of that strip isn't free either: with the keyboard up, iOS
  // Safari shrinks its URL bar into a floating pill that sits *over* the page
  // instead of below it, so a card resting at the usual float gap comes out
  // with the address bar across its foot row. Keyboard-up on a phone therefore
  // buys some clearance — enough to clear the pill and leave a sliver of
  // article between the two. Phones only: iPad and desktop Safari keep the URL
  // bar at the top, where it overlays nothing.
  const KEYBOARD_CLEARANCE = 44;
  const PHONE_WIDTH = 640;

  let visibleHeight = $state(0);
  let keyboardClearance = $state(0);
  let composerMax = $derived(
    visibleHeight > 0
      ? `${Math.max(Math.round(visibleHeight) - 16 - keyboardClearance, 0)}px`
      : undefined
  );

  $effect(() => {
    if (!session || composer.minimized) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const measure = () => {
      visibleHeight = vv.height;
      // The keyboard takes a big bite; the URL bar alone is a much smaller gap
      // between the layout and visual viewports, so the threshold separates them.
      const keyboardUp = window.innerHeight - vv.height > 150;
      keyboardClearance = keyboardUp && window.innerWidth <= PHONE_WIDTH ? KEYBOARD_CLEARANCE : 0;
    };
    measure();
    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);
    return () => {
      vv.removeEventListener('resize', measure);
      vv.removeEventListener('scroll', measure);
    };
  });

  // ── Keep drags inside the card ──────────────────────────────────────────────
  // A finger drag on the card would otherwise fall through to the feed behind
  // it, so the page scrolls while you're trying to move around the draft. The
  // blocks region is the one part that legitimately scrolls; when it has room
  // to move in the drag's direction the browser handles it (and
  // overscroll-behavior:contain stops the chain at its edges). Every other drag
  // — head, foot, link card, or the blocks region when the draft is short
  // enough to fit — gets swallowed.
  //
  // The listener is non-passive by necessity, so it's registered here rather
  // than as an event attribute. A live text selection is left alone: dragging
  // an iOS selection handle fires touchmove too, and preventing it there would
  // freeze the handle.
  $effect(() => {
    if (!session || composer.minimized) return;
    const card = composerEl;
    if (!card) return;

    let lastY = 0;

    function onStart(e: TouchEvent) {
      lastY = e.touches[0]?.clientY ?? 0;
    }

    function onMove(e: TouchEvent) {
      const y = e.touches[0]?.clientY ?? lastY;
      const dy = y - lastY;
      lastY = y;

      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;

      const el = blocksEl;
      if (!el || !(e.target instanceof Node) || !el.contains(e.target)) {
        e.preventDefault();
        return;
      }
      const room = el.scrollHeight - el.clientHeight;
      // Dragging down reveals earlier content (scrollTop falls), and vice versa.
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop >= room - 1;
      if (room <= 0 || (dy > 0 && atTop) || (dy < 0 && atBottom)) e.preventDefault();
    }

    card.addEventListener('touchstart', onStart, { passive: true });
    card.addEventListener('touchmove', onMove, { passive: false });
    return () => {
      card.removeEventListener('touchstart', onStart);
      card.removeEventListener('touchmove', onMove);
    };
  });

  // ── Dismiss on touch outside ────────────────────────────────────────────────
  // On mobile the soft keyboard shifts the visual viewport out from under
  // fixed positioning, so an expanded composer drifts with the page as soon as
  // you scroll the feed behind it. Rather than fight the browser for that,
  // treat any touch outside the card as a signal to put the draft away: the
  // start of a scroll minimizes immediately, a plain tap minimizes once it
  // lands (so the tap still reaches whatever it hit). Blurring first sends the
  // keyboard down. Nothing is lost — the draft keeps saving, and quotes picked
  // from the article still land in it while it rests.
  //
  // Touch events only, so a desktop pointer selecting text in the article
  // leaves the composer alone.
  let composerEl = $state<HTMLElement | null>(null);
  const DRAG_SLOP = 8;

  $effect(() => {
    if (!session || composer.minimized || showShareConfirm) return;

    let tracking = false;
    let startX = 0;
    let startY = 0;

    function isOutside(target: EventTarget | null): boolean {
      return !(target instanceof Node) || !composerEl || !composerEl.contains(target);
    }

    function dismiss() {
      tracking = false;
      const active = document.activeElement;
      if (active instanceof HTMLElement && composerEl?.contains(active)) active.blur();
      quotesOpen = false;
      composer.setMinimized(true);
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 1 || !isOutside(e.target)) {
        tracking = false;
        return;
      }
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }

    function onTouchMove(e: TouchEvent) {
      if (!tracking) return;
      const t = e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientX - startX) > DRAG_SLOP || Math.abs(t.clientY - startY) > DRAG_SLOP) {
        dismiss();
      }
    }

    function onTouchEnd() {
      if (tracking) dismiss();
    }

    const opts = { capture: true, passive: true } as const;
    document.addEventListener('touchstart', onTouchStart, opts);
    document.addEventListener('touchmove', onTouchMove, opts);
    document.addEventListener('touchend', onTouchEnd, opts);
    document.addEventListener('touchcancel', onTouchEnd, opts);
    return () => {
      document.removeEventListener('touchstart', onTouchStart, opts);
      document.removeEventListener('touchmove', onTouchMove, opts);
      document.removeEventListener('touchend', onTouchEnd, opts);
      document.removeEventListener('touchcancel', onTouchEnd, opts);
    };
  });
</script>

{#if session && article}
  {#if composer.minimized}
    <!-- Slim resting bar: the draft stays in reach while you read. -->
    <div
      class="composer-minibar"
      class:lifted={bottomBarInset.height > 0}
      style:--bar-inset={`${bottomBarInset.height}px`}
    >
      <button
        type="button"
        class="minibar-main"
        onclick={() => composer.setMinimized(false)}
        aria-label="Expand share draft"
      >
        <Icon name="share" size={15} />
        <span class="minibar-label">{isEdit ? 'Editing share' : 'Draft'}</span>
        <span class="minibar-summary">
          {#if composer.quoteCount > 0}
            {composer.quoteCount}
            {composer.quoteCount === 1 ? 'quote' : 'quotes'} ·
          {/if}
          {composer.wordCount}
          {composer.wordCount === 1 ? 'word' : 'words'}
        </span>
        <span class="minibar-title">{article.title}</span>
        <Icon name="chevron-up" size={15} />
      </button>
      <button
        type="button"
        class="minibar-close"
        onclick={() => composer.close()}
        aria-label={isEdit ? 'Close editor' : 'Close (draft is saved)'}
        title={isEdit ? 'Close' : 'Close — your draft is saved'}
      >
        <Icon name="x" size={15} />
      </button>
    </div>
  {:else}
    <section
      class="composer"
      bind:this={composerEl}
      style:--composer-max={composerMax}
      style:--kb-clear={keyboardClearance ? `${keyboardClearance}px` : undefined}
      aria-label={isEdit ? 'Edit your share' : 'Share to your linkblog'}
    >
      <header class="composer-head">
        <div class="composer-head-text">
          <span class="composer-title">
            {isEdit ? 'Edit your share' : 'Share to your linkblog'}
          </span>
          <span class="composer-article" title={article.title}>{article.title}</span>
        </div>
        <div class="composer-head-actions">
          <button
            type="button"
            class="head-btn"
            onclick={() => composer.setMinimized(true)}
            aria-label="Minimize — keep drafting while you read"
            title="Minimize (Esc)"
          >
            <Icon name="chevron-down" size={16} />
          </button>
          <button
            type="button"
            class="head-btn"
            onclick={() => composer.close()}
            aria-label={isEdit ? 'Close editor' : 'Close (draft is saved)'}
            title={isEdit ? 'Close' : 'Close — your draft is saved'}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      </header>

      <div class="composer-blocks" bind:this={blocksEl}>
        {#each composer.blocks as block, i (i)}
          {#if block.kind === 'quote'}
            <div class="quote-block">
              <textarea
                bind:this={textareaEls[i]}
                bind:value={block.text}
                class="quote-input"
                rows="1"
                aria-label="Quoted passage — edit to trim"
                oninput={(e) => {
                  composer.touch();
                  autosize(e.currentTarget);
                }}
                onkeydown={handleBlockKeydown}
              ></textarea>
              <button
                type="button"
                class="quote-remove"
                onclick={() => composer.removeBlock(i)}
                aria-label="Remove quote"
                title="Remove quote"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          {:else}
            <div class="text-block">
              <textarea
                bind:this={textareaEls[i]}
                bind:value={block.text}
                class="text-input"
                rows="1"
                placeholder={i === 0 ? 'Say something about it…' : 'Add commentary…'}
                aria-label="Commentary"
                maxlength={MAX}
                oninput={(e) => {
                  composer.touch();
                  autosize(e.currentTarget);
                }}
                onkeydown={handleBlockKeydown}
              ></textarea>
              <MentionAutocomplete textareaEl={textareaEls[i] ?? null} bind:value={block.text} />
            </div>
          {/if}
        {/each}

        <!-- What the post carries besides your words: the article's link card. -->
        <div class="link-card" title={article.url}>
          {#if faviconUrl}<img src={faviconUrl} alt="" class="link-card-favicon" />{/if}
          <span class="link-card-title">{article.title}</span>
          {#if domain}<span class="link-card-domain">{domain}</span>{/if}
        </div>
      </div>

      <footer class="composer-foot">
        <div class="foot-left">
          {#if hasQuoteSources}
            <div class="quotes-wrap">
              <button
                type="button"
                bind:this={quotesBtnEl}
                class="foot-btn"
                class:active={quotesOpen}
                aria-expanded={quotesOpen}
                aria-label="Insert a quote from your highlights"
                onclick={() => (quotesOpen = !quotesOpen)}
              >
                <Icon name="quote" size={15} />
                <span class="foot-btn-label">Add quote</span>
              </button>
              {#if quotesOpen}
                <div
                  bind:this={quotesPopupEl}
                  class="quotes-popup"
                  role="menu"
                  aria-label="Your highlights"
                >
                  <p class="quotes-head">
                    {highlightEntries.length > 0 ? 'Your highlights' : 'From the article'}
                  </p>
                  <ul class="quotes-list">
                    {#each highlightEntries as h (h.id)}
                      <li>
                        <button
                          type="button"
                          class="quote-item"
                          role="menuitem"
                          onclick={() => pickQuote(h.selector.exact)}
                        >
                          {#if h.selector.prefix}
                            <span class="quote-context">…{h.selector.prefix.slice(-80)}</span>
                          {/if}
                          <span class="quote-exact">{h.selector.exact}</span>
                          {#if h.selector.suffix}
                            <span class="quote-context">{h.selector.suffix.slice(0, 80)}…</span>
                          {/if}
                        </button>
                      </li>
                    {/each}
                    {#if excerptQuote}
                      <li>
                        <button
                          type="button"
                          class="quote-item"
                          role="menuitem"
                          onclick={() => pickQuote(excerptQuote)}
                        >
                          <span class="quote-kicker">Article excerpt</span>
                          <span class="quote-exact">{excerptQuote}</span>
                        </button>
                      </li>
                    {/if}
                  </ul>
                  {#if highlightEntries.length === 0 && !excerptQuote}
                    <p class="quotes-empty">Select text in the article to quote it.</p>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
          {#if !isEdit && composer.hasContent}
            <button
              type="button"
              class="foot-btn discard"
              class:confirming={confirmingDiscard}
              onclick={handleDiscard}
            >
              <Icon name="trash" size={14} />
              <span class="foot-btn-label">{confirmingDiscard ? 'Discard draft?' : 'Discard'}</span>
            </button>
          {/if}
        </div>

        <div class="foot-right">
          {#if postError}
            <span class="post-error" role="alert">Couldn’t post. Try again.</span>
          {:else if nearLimit}
            <span class="counter" class:over={overLimit}>{MAX - noteLength}</span>
          {:else if !isEdit && composer.hasContent}
            <span class="draft-hint">Saved as a draft</span>
          {/if}
          <button
            type="button"
            class="post-btn"
            onclick={handlePost}
            disabled={composer.posting || overLimit}
          >
            {#if composer.posting}
              {isEdit ? 'Updating…' : 'Posting…'}
            {:else}
              {isEdit ? 'Update' : 'Post'}
            {/if}
          </button>
        </div>
      </footer>
    </section>
  {/if}

  <ShareConfirmModal
    open={showShareConfirm}
    zIndex={200}
    onconfirm={() => {
      showShareConfirm = false;
      postError = false;
      void composer.post().then((ok) => {
        if (!ok) postError = true;
      });
    }}
    oncancel={() => (showShareConfirm = false)}
  />
{/if}

<style>
  /* A card that floats over the page plane (reader overlay included) rather than
     a sheet welded to the bottom edge. That's a deliberate retreat from fighting
     mobile browsers for the last row of pixels: the keyboard, Safari's URL bar
     and the home indicator all claim that strip and none of them agree on where
     `bottom: 0` lands, so the card keeps clear of the whole zone and lets the
     feed show beneath it — which reads as depth once the card has air, corners
     and a shadow on every side.

     `bottom` is the plain offset on purpose. Mobile Safari anchors fixed
     elements to the *visible* viewport, above its own URL bar, so a correction
     of `100lvh - 100dvh` (or any measured equivalent) double-counts the chrome
     and parks the card a bar's height too high whenever that bar is expanded.
     Tried, reverted, don't re-add. What's left is Safari moving fixed elements
     with the page while the URL bar animates between states and settling them
     after: browser behavior, not ours to correct.

     Centered by auto margins, not a transform: a transformed ancestor would
     become the containing block for the fixed-position quote picker and pin it
     to the drawer instead of the viewport.

     Inset by the sidebar so the card centers on the content column, not the
     whole window — .app-container is a centered max-width band, so insetting the
     left edge by the sidebar width lands the card's center exactly on the feed
     column's center at every viewport size. */
  .composer,
  .composer-minibar {
    --float-gap: 0.5rem;
    --composer-inset: var(--sidebar-width, 320px);
    position: fixed;
    bottom: calc(env(safe-area-inset-bottom, 0px) + var(--float-gap) + var(--kb-clear, 0px));
    left: var(--composer-inset);
    right: 0;
    margin: 0 auto;
    z-index: 140;
    width: min(800px, calc(100vw - var(--composer-inset) - 2 * var(--float-gap)));
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 12px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
  }

  .composer {
    display: flex;
    flex-direction: column;
    /* Never taller than what's on screen, so a long draft scrolls its blocks
       instead of running the foot row off the top or down behind the keyboard.
       The blocks region absorbs the squeeze. --composer-max is the measured
       visual viewport (see the script); the dvh fallback covers first paint and
       browsers without visualViewport. */
    max-height: var(--composer-max, calc(100dvh - 2 * var(--float-gap)));
    animation: composer-in 0.25s cubic-bezier(0.22, 1, 0.36, 1);
  }

  @keyframes composer-in {
    from {
      transform: translateY(1.5rem);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  /* ── Minimized bar ──────────────────────────────────────────────────────── */
  .composer-minibar {
    display: flex;
    align-items: stretch;
    overflow: hidden;
  }

  .minibar-main {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem;
    background: none;
    border: none;
    color: var(--color-text);
    font-size: var(--text-sm);
    cursor: pointer;
    text-align: left;
  }

  .minibar-main > :global(.icon) {
    flex-shrink: 0;
    color: var(--color-primary, #0066cc);
  }

  .minibar-label {
    flex-shrink: 0;
    font-weight: var(--weight-semibold);
  }

  .minibar-summary {
    flex-shrink: 0;
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  /* Takes the slack, so the chevron that follows it lands against the close
     button's divider instead of trailing a short title mid-bar. */
  .minibar-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-secondary);
  }

  .minibar-close {
    display: flex;
    align-items: center;
    padding: 0 0.75rem;
    background: none;
    border: none;
    border-left: 1px solid var(--color-border, #e0e0e0);
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .minibar-close:hover {
    color: var(--color-text);
  }

  /* ── Header ─────────────────────────────────────────────────────────────── */
  .composer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.625rem 1rem 0.5rem;
  }

  .composer-head-text {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 0.625rem;
  }

  .composer-title {
    flex-shrink: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .composer-article {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .composer-head-actions {
    display: flex;
    flex-shrink: 0;
    gap: 0.25rem;
  }

  .head-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.3125rem;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .head-btn:hover {
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text);
  }

  /* ── Blocks ─────────────────────────────────────────────────────────────── */
  .composer-blocks {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    /* min-height:0 so this is what gives when the drawer is capped to the
       visible viewport — the head, link row and foot keep their content height. */
    min-height: 0;
    max-height: min(42vh, 22rem);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.125rem 1rem 0.625rem;
  }

  .text-block {
    position: relative;
  }

  .text-input,
  .quote-input {
    display: block;
    width: 100%;
    resize: none;
    border: none;
    outline: none;
    padding: 0;
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-lg);
    line-height: var(--leading-normal);
  }

  /* Held to the muted-ink token at full strength: at 0.6 the placeholder lands
     near 2.5:1, under the contrast bar placeholders are held to. */
  .text-input::placeholder {
    color: var(--color-text-secondary);
  }

  /* A quote is a real blockquote in the editor: the gold quotation rule (the
     one sanctioned stripe — it's a quotation mark, not a status accent). */
  .quote-block {
    position: relative;
    padding: 0.125rem 1.75rem 0.125rem 0.875rem;
    border-left: 3px solid color-mix(in srgb, #f5c518 70%, transparent);
  }

  .quote-input {
    color: var(--color-text-secondary);
  }

  .quote-remove {
    position: absolute;
    top: 0.125rem;
    right: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--color-text-secondary);
    opacity: 0.5;
    cursor: pointer;
    transition:
      opacity 0.15s,
      color 0.15s;
  }

  .quote-block:hover .quote-remove,
  .quote-block:focus-within .quote-remove {
    opacity: 1;
  }

  .quote-remove:hover {
    color: var(--color-error, #f44336);
  }

  /* The trailing link card every share carries — shown so the draft reads as
     the finished post: your words, then the article. */
  .link-card {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.125rem;
    padding: 0.4375rem 0.625rem;
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 8px;
    font-size: var(--text-sm);
  }

  .link-card-favicon {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    border-radius: 3px;
  }

  .link-card-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
    font-weight: var(--weight-medium);
  }

  .link-card-domain {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  /* ── Footer ─────────────────────────────────────────────────────────────── */
  .composer-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 1rem 0.625rem;
    border-top: 1px solid var(--color-border, #e0e0e0);
  }

  .foot-left,
  .foot-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .foot-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3125rem 0.625rem;
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .foot-btn:hover,
  .foot-btn.active {
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text);
  }

  .foot-btn.discard:hover,
  .foot-btn.discard.confirming {
    color: var(--color-error, #f44336);
    background: transparent;
  }

  .draft-hint {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .counter {
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    color: var(--color-text-secondary);
  }

  .counter.over {
    color: var(--color-error, #f44336);
  }

  .post-error {
    font-size: var(--text-sm);
    color: var(--color-error, #f44336);
  }

  .post-btn {
    display: inline-flex;
    align-items: center;
    padding: 0.375rem 1.125rem;
    background: var(--color-primary, #0066cc);
    border: none;
    border-radius: 6px;
    color: #fff;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .post-btn:hover:not(:disabled) {
    background: var(--color-primary-dark, #0052a3);
  }

  .post-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* ── Quote picker popup ─────────────────────────────────────────────────── */
  .quotes-wrap {
    position: relative;
    display: flex;
  }

  .quotes-popup {
    position: fixed;
    z-index: 210;
    display: flex;
    flex-direction: column;
    width: min(26rem, calc(100vw - 1rem));
    padding: 0.375rem;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    text-align: left;
  }

  .quotes-head {
    flex-shrink: 0;
    margin: 0;
    padding: 0.25rem 0.5rem 0.375rem;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
  }

  .quotes-list {
    list-style: none;
    margin: 0;
    padding: 0;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .quote-item {
    display: block;
    width: 100%;
    padding: 0.5rem 0.625rem;
    font: inherit;
    font-size: var(--text-md);
    line-height: 1.45;
    color: var(--color-text);
    text-align: left;
    background: transparent;
    border: none;
    border-left: 3px solid var(--color-border, #e0e0e0);
    border-radius: 0 6px 6px 0;
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s;
  }

  .quote-item:hover {
    background: var(--color-bg-secondary, #f5f5f5);
    border-left-color: color-mix(in srgb, #f5c518 70%, transparent);
  }

  /* The passage itself, in full (clamped only when very long). */
  .quote-exact {
    display: -webkit-box;
    -webkit-line-clamp: 5;
    line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Surrounding context from the selector, muted around the passage. */
  .quote-context {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .quote-kicker {
    display: block;
    margin-bottom: 0.125rem;
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
  }

  .quotes-empty {
    margin: 0;
    padding: 0.375rem 0.5rem 0.5rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  /* ── Responsive & prefs ─────────────────────────────────────────────────── */

  /* Reading mode: the reader overlay is opaque and full-screen (it covers the
     sidebar) and centers its 800px column on the viewport, so the drawer drops
     the sidebar inset to stay under that column. */
  :global(body.reader-open) .composer,
  :global(body.reader-open) .composer-minibar {
    --composer-inset: 0px;
  }

  /* Below the sidebar breakpoint the sidebar is an off-canvas drawer, so the
     content column already spans the window. */
  @media (max-width: 1000px) {
    .composer,
    .composer-minibar {
      --composer-inset: 0px;
    }
  }

  /* On mobile the bottom edge belongs to whichever app bar is up — the feed's
     MobileBottomBar or the reader's. The resting minibar floats clear above that
     bar rather than over it, so the bar's controls stay tappable. `--bar-inset`
     is the bar's measured height, which already includes the safe-area inset it
     absorbs — hence no env() on top of it here. When the bar slides away on
     scroll the minibar settles back to its own float gap, matching the bar's
     0.25s travel so the two move as one. */
  @media (max-width: 1000px) {
    .composer-minibar {
      transition: bottom 0.25s ease;
    }

    .composer-minibar.lifted {
      bottom: calc(var(--bar-inset, 0px) + var(--float-gap));
    }
  }

  @media (max-width: 640px) {
    .composer,
    .composer-minibar {
      border-radius: 16px;
    }

    /* 16px keeps iOS Safari from auto-zooming the field on focus. */
    .text-input,
    .quote-input {
      font-size: var(--text-base);
    }

    .composer-blocks {
      max-height: 45vh;
    }

    .foot-btn-label {
      display: none;
    }

    .foot-btn.discard.confirming .foot-btn-label {
      display: inline;
    }

    .draft-hint {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .composer {
      animation: none;
    }

    .composer-minibar {
      transition: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .composer,
    .composer-minibar {
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
    }

    .quotes-popup {
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
  }

  /* Safari paints its own translucent chrome over the bottom of the window, and
     a soft shadow crossing into it tears along that boundary instead of fading.
     On phones the expanded card rides on its border alone — flat-by-default is
     the house rule anyway, and the card is large enough there to read as a
     surface without one. The minibar keeps its shadow: it's small, it floats
     clear of the chrome, and it needs the lift to separate from the feed.
     Last in the file so it also wins over the dark-mode shadow above. */
  @media (max-width: 640px) {
    .composer {
      box-shadow: none;
    }
  }
</style>
