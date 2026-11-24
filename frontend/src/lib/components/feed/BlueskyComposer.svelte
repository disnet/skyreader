<script lang="ts">
  // Posting to Bluesky from inside the app. Planned live like the share
  // composer's cross-post: the note becomes the post's text (trimmed to 300),
  // and the passages chosen (the highlight it opened on, plus any more of the
  // article's highlights, up to four) go out as text shots with the link in
  // the text, or, with that off, quoted in the text over the article's link
  // card. Without a passage (the discussion's "Add yours") it's a plain link
  // post.
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import Modal from '$lib/components/common/Modal.svelte';
  import BlueskyCountRing from './BlueskyCountRing.svelte';
  import QuoteModeToggle from './QuoteModeToggle.svelte';
  import {
    blueskyComposerStore as composer,
    blueskyPostBlocks,
  } from '$lib/stores/blueskyComposer.svelte';
  import { domainOf } from '$lib/services/blueskyCrossPost';
  import {
    BLUESKY_MAX_GRAPHEMES,
    BLUESKY_MAX_IMAGES,
    DISCUSSION_LABEL,
    planBlueskyPost,
  } from '$lib/utils/blueskyPost';
  import { renderTextShot } from '$lib/utils/textShot';
  import { highlightQuote } from '$lib/utils/highlightSource';
  import type { Highlight } from '$lib/types';
  import { auth } from '$lib/stores/auth.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import {
    QUOTE_FILTER_AT,
    quoteOrder,
    quoteRows,
    type QuoteCandidate,
  } from '$lib/utils/quotePicker';
  import { linkPageUrl } from '$lib/constants/linkPages';

  let session = $derived(composer.session);

  // The article's highlights, offered as more passages to post. Found by where
  // they're kept when the opener knows it, else by the article's URL (stamped
  // on every highlight since source metadata existed).
  let highlights = $derived.by((): QuoteCandidate[] => {
    if (!session) return [];
    const asCandidate = (h: Highlight) => ({
      text: highlightQuote(h),
      note: h.note ?? '',
    });
    if (session.itemKey) {
      const kept = itemLabelsStore.getHighlights(session.itemKey);
      if (kept.length > 0) return kept.map(asCandidate);
    }
    const url = session.source.url;
    return itemLabelsStore.allHighlights
      .filter(({ itemKey, highlight }) => highlight.sourceUrl === url || itemKey === url)
      .map(({ highlight }) => asCandidate(highlight));
  });

  // Everything on offer, in a stable order: what it opened with, then the
  // highlights, each passage once.
  let candidates = $derived.by((): QuoteCandidate[] => {
    if (!session) return [];
    const notes = new Map(highlights.map((h) => [h.text, h.note]));
    const seen = new Set<string>();
    const out: QuoteCandidate[] = [];
    for (const text of [...session.offered, ...highlights.map((h) => h.text), ...session.quotes]) {
      if (!text.trim() || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, note: notes.get(text) ?? '' });
    }
    return out;
  });

  // Worth showing only when there's a choice to make beyond what's already in.
  let canPick = $derived(
    Boolean(session) &&
      (candidates.length > 1 || candidates.some((c) => !session!.quotes.includes(c.text)))
  );
  let pickerOpen = $state(false);

  // A long list gets a filter, and lists what's chosen first. The order is a
  // snapshot, taken on opening the list and on each new filter, so ticking a
  // row never moves it out from under the pointer.
  let filter = $state('');
  let showFilter = $derived(candidates.length > QUOTE_FILTER_AT);
  let order = $state<string[]>([]);
  $effect(() => {
    if (!pickerOpen) return;
    void filter;
    untrack(() => {
      if (session) order = quoteOrder(candidates, session.quotes);
    });
  });
  let rows = $derived(
    session ? quoteRows(candidates, session.quotes, order, showFilter ? filter : '') : []
  );
  let atLimit = $derived((session?.quotes.length ?? 0) >= BLUESKY_MAX_IMAGES);

  // The text shots themselves, drawn once per passage so the reader sees the
  // images that will go out. A failed draw means posting will fall back to the
  // quotes as text over the link card, so the preview does too. A shot that
  // drew but won't display (a policy blocking blob: images, say) still goes out
  // as an image; the preview can only say so.
  type Shot = { state: 'drawing' | 'ready' | 'failed' | 'hidden'; url: string | null };
  const shots = new SvelteMap<string, Shot>();
  // Each opening draws its own; a draw still running from the last one is dropped.
  let generation = 0;
  let shotSource = $derived(session?.source ?? null);
  $effect(() => {
    void shotSource;
    pickerOpen = false;
    filter = '';
    return () => {
      generation++;
      for (const shot of shots.values()) if (shot.url) URL.revokeObjectURL(shot.url);
      shots.clear();
    };
  });
  $effect(() => {
    const current = session;
    if (!current) return;
    untrack(() => {
      const gen = generation;
      const meta = { title: current.source.title, domain: domainOf(current.source.url) };
      // A passage taken out lets its image go; ticked again, it's drawn again.
      for (const [quote, shot] of shots) {
        if (current.quotes.includes(quote)) continue;
        if (shot.url) URL.revokeObjectURL(shot.url);
        shots.delete(quote);
      }
      for (const quote of current.quotes) {
        // A failed draw gets another go: the post draws afresh, so may the preview.
        if (shots.has(quote) && shots.get(quote)!.state !== 'failed') continue;
        const marker: Shot = { state: 'drawing', url: null };
        shots.set(quote, marker);
        // Settles only the draw that's still wanted: not one from an earlier
        // opening, nor one for a passage taken out (or out and back) since.
        const wanted = () => gen === generation && shots.get(quote) === marker;
        renderTextShot(quote, meta)
          .then((shot) => {
            if (wanted()) shots.set(quote, { state: 'ready', url: URL.createObjectURL(shot.blob) });
          })
          .catch(() => {
            if (wanted()) shots.set(quote, { state: 'failed', url: null });
          });
      }
    });
  });

  let shotList = $derived(
    (session?.quotes ?? []).map((quote) => ({
      quote,
      ...(shots.get(quote) ?? { state: 'drawing' as const, url: null }),
    }))
  );
  // Images once any has drawn: a passage still drawing holds its place in the
  // grid, so ticking another doesn't flip the preview back to text.
  let imagesReady = $derived(
    shotList.some((s) => s.state === 'ready') &&
      shotList.every((s) => (s.state === 'ready' && s.url) || s.state === 'drawing')
  );

  // Whether the post goes out with the quotes as images: one failed draw sends
  // them all as text, as the post itself does.
  let asShot = $derived(
    shotList.length > 0 && composer.textShots && !shotList.some((s) => s.state === 'failed')
  );

  let plan = $derived(
    session
      ? planBlueskyPost(blueskyPostBlocks(session.quotes, composer.text), session.source.url, {
          // What the post will carry: a failed draw sends the quotes as text.
          textShots: asShot,
          discussionUrl: linkPageUrl(session.source.url),
        })
      : null
  );

  function hideShot(quote: string) {
    const shot = shots.get(quote);
    if (shot) shots.set(quote, { ...shot, state: 'hidden' });
  }

  // Only what the preview can't show: an image it can't display yet, or text
  // cut to fit.
  let summary = $derived(
    [
      asShot && shotList.some((s) => s.state === 'drawing')
        ? shotList.length > 1
          ? 'Drawing the images'
          : 'Drawing the image'
        : '',
      asShot && shotList.some((s) => s.state === 'hidden')
        ? 'Image preview unavailable, posts as an image'
        : '',
      plan?.trimmed ? 'Text trimmed to fit' : '',
    ]
      .filter(Boolean)
      .join(' · ')
  );

  // The dialog can open over the reader, whose shortcuts listen on the page:
  // while it's up, Escape closes only the dialog and no key reaches the reader.
  // Captured at the window, ahead of everyone; the text box still gets its
  // typing (nothing here prevents the default).
  function handleWindowKeydown(e: KeyboardEvent) {
    if (!session) return;
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      // In a filter with something typed, Escape clears it first.
      if (e.target instanceof HTMLInputElement && e.target.type === 'search' && filter) {
        filter = '';
        return;
      }
      composer.close();
    } else if (e.target instanceof HTMLTextAreaElement) {
      handleTextKeydown(e);
    }
  }

  function handleTextKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && composer.access !== 'missing') {
      e.preventDefault();
      composer.post();
    }
  }
</script>

<svelte:window onkeydowncapture={handleWindowKeydown} />

{#snippet postTail()}
  <!-- Where the post's text ends: the article's short link (with an image, where
       there's no card to carry it) and the article's Discussion page. Bluesky
       draws the card or image under all of the text, so this sits above it. -->
  {#if plan?.discussionText}
    <p class="post-tail">
      {#if asShot && plan.linkText}<span class="tail-link">{plan.linkText}</span><br />{/if}
      {DISCUSSION_LABEL}<span class="tail-link">{plan.discussionText}</span>
    </p>
  {/if}
{/snippet}

{#snippet linkCard()}
  <!-- What Bluesky will draw under the post: the article's link card. -->
  {#if session}
    <div class="link-card">
      {#if session.source.imageUrl}
        <img class="link-card-image" src={session.source.imageUrl} alt="" />
      {/if}
      <div class="link-card-text">
        {#if session.source.title}
          <span class="link-card-title">{session.source.title}</span>
        {/if}
        <span class="link-card-domain">{domainOf(session.source.url)}</span>
      </div>
    </div>
  {/if}
{/snippet}

<Modal
  open={Boolean(session)}
  onclose={composer.close}
  title="Post to Bluesky"
  icon="bluesky"
  zIndex={250}
  maxWidth="520px"
  bodyPadding="0"
>
  {#if session}
    <div class="body">
      <!-- Shaped like the post it becomes: who's posting on the left, the words
           and what hangs under them on the right. -->
      <div class="post">
        {#if auth.user?.avatarUrl}
          <img class="avatar" src={auth.user.avatarUrl} alt="" />
        {:else}
          <span class="avatar" aria-hidden="true"></span>
        {/if}
        <div class="post-main">
          {#if auth.user}
            <div class="byline">
              {#if auth.user.displayName}<span class="name">{auth.user.displayName}</span>{/if}
              <span class="handle">@{auth.user.handle}</span>
            </div>
          {/if}
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            class="post-text"
            bind:value={composer.text}
            placeholder="Say something about it…"
            aria-label="Post text"
            rows="1"
            autofocus></textarea>

          <figure class="preview">
            {#if session.quotes.length === 0}
              {@render postTail()}
              {@render linkCard()}
            {:else if asShot && imagesReady}
              {@render postTail()}
              <div class="shots" class:grid={shotList.length > 1}>
                {#each shotList as shot (shot.quote)}
                  {#if shot.url}
                    <img
                      class="shot"
                      src={shot.url}
                      alt={shot.quote}
                      onerror={() => hideShot(shot.quote)}
                    />
                  {:else}
                    <div class="shot pending" role="img" aria-label={shot.quote}></div>
                  {/if}
                {/each}
              </div>
            {:else}
              <!-- While drawing, or when a shot won't display, the quotes show
                   as text and the caption says what actually goes out. -->
              {#each session.quotes as quote (quote)}
                <blockquote class="quote">{quote}</blockquote>
              {/each}
              {@render postTail()}
              <!-- As text, the quote rides in the post and the link card hangs
                   under it, as it will on Bluesky. -->
              {#if !asShot}{@render linkCard()}{/if}
            {/if}
            {#if summary}
              <figcaption class="caption">{summary}</figcaption>
            {/if}
          </figure>

          {#if canPick}
            <!-- More of the article's highlights, picked in place: no popover
                 to aim, and what's in stays checked where it was. -->
            <div class="picker">
              <button
                type="button"
                class="picker-toggle"
                aria-expanded={pickerOpen}
                onclick={() => (pickerOpen = !pickerOpen)}
              >
                {session.quotes.length > 0 ? 'Choose quotes' : 'Add quotes from your highlights'}
                {#if session.quotes.length > 0}
                  <span class="picker-count">{session.quotes.length} chosen</span>
                {/if}
              </button>
              {#if pickerOpen}
                {#if showFilter}
                  <input
                    type="search"
                    class="picker-filter"
                    bind:value={filter}
                    placeholder="Filter {candidates.length} highlights"
                    aria-label="Filter highlights"
                  />
                {/if}
                <ul class="picker-list" aria-label="Quotes to post">
                  {#each rows as row (row.text)}
                    {@const quote = row.text}
                    {@const checked = session.quotes.includes(quote)}
                    <li>
                      <label class="picker-item" class:disabled={!checked && atLimit}>
                        <input
                          type="checkbox"
                          {checked}
                          disabled={!checked && atLimit}
                          onchange={() => composer.toggleQuote(quote)}
                        />
                        <span class="picker-text">{quote}</span>
                      </label>
                    </li>
                  {/each}
                </ul>
                {#if rows.length === 0}
                  <p class="picker-hint">No highlights match.</p>
                {/if}
                {#if candidates.length > BLUESKY_MAX_IMAGES}
                  <p class="picker-hint">Up to {BLUESKY_MAX_IMAGES} per post.</p>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      </div>

      {#if composer.access === 'missing'}
        <div class="notice">
          <span>Posting to Bluesky needs your permission.</span>
          <button type="button" class="allow" onclick={() => composer.allowAccess(auth.user?.did)}
            >Allow access</button
          >
        </div>
      {/if}

      <div class="footer">
        {#if session.quotes.length > 0}
          <QuoteModeToggle
            textShots={composer.textShots}
            onchange={(on) => composer.setTextShots(on)}
            label={session.quotes.length > 1 ? 'Quotes as' : 'Quote as'}
          />
        {/if}
        <!-- The ring only near the limit: a part-filled ring beside the button
             otherwise reads as a spinner, and far from 300 it says nothing. -->
        {#if plan && composer.access !== 'missing' && plan.length > BLUESKY_MAX_GRAPHEMES - 100}
          <BlueskyCountRing length={plan.length} />
        {/if}
        <button
          type="button"
          class="btn primary"
          disabled={composer.access === 'missing'}
          onclick={composer.post}>Post</button
        >
      </div>
    </div>
  {/if}
</Modal>

<style>
  /* The body runs edge to edge (bodyPadding="0") so the footer can; the post
     sets its own inset. */
  .body {
    display: flex;
    flex-direction: column;
  }

  .post {
    display: grid;
    grid-template-columns: 2.25rem minmax(0, 1fr);
    gap: 0.75rem;
    padding: 1rem 1.25rem 1.25rem;
  }

  .avatar {
    display: block;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    background: var(--color-bg-secondary);
    object-fit: cover;
  }

  .post-main {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .byline {
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
    min-width: 0;
    font-size: var(--text-md);
    line-height: var(--leading-snug);
    white-space: nowrap;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--color-text);
    font-weight: var(--weight-semibold);
  }

  .handle {
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--color-text-secondary);
  }

  /* Written like the share composer: the post's own text, not a form field.
     No frame, no grab handle; it grows with what's typed (field-sizing), up to
     a cap where it scrolls instead. */
  .post-text {
    display: block;
    width: 100%;
    box-sizing: border-box;
    min-height: 1lh;
    max-height: 12rem;
    margin: 0;
    padding: 0;
    border: none;
    outline: none;
    resize: none;
    overflow-y: auto;
    field-sizing: content;
    background: transparent;
    color: var(--color-text);
    font: inherit;
    /* iOS won't zoom on focus at >=16px. */
    font-size: max(var(--text-base), 16px);
    line-height: var(--leading-normal);
  }

  /* The muted-ink token at full strength keeps the placeholder over the
     contrast bar. */
  .post-text::placeholder {
    color: var(--color-text-secondary);
  }

  .post-tail {
    margin: 0;
    color: var(--color-text);
    overflow-wrap: anywhere;
  }

  .tail-link {
    color: var(--color-primary);
  }

  .preview {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin: 0.625rem 0 0;
  }

  .shots.grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.375rem;
  }

  .shot {
    display: block;
    width: 100%;
    height: auto;
    max-height: 18rem;
    object-fit: contain;
    object-position: top left;
    border: 1px solid var(--color-border);
    border-radius: 0.625rem;
  }

  /* Drawn like a quoted highlight: the article serif, the gold rule. */
  .quote {
    margin: 0;
    padding: 0.125rem 0 0.125rem 0.875rem;
    border-left: 3px solid rgba(245, 197, 24, 0.7);
    max-height: 12rem;
    overflow-y: auto;
    font-family: var(--font-serif, Georgia, serif);
    line-height: var(--leading-relaxed);
    color: var(--color-text);
    white-space: pre-wrap;
  }

  .shots.grid .shot {
    max-height: 10rem;
  }

  .shot.pending {
    min-height: 5rem;
    background: var(--color-bg-secondary);
  }

  .picker {
    margin-top: 0.75rem;
  }

  .picker-toggle {
    display: inline-flex;
    align-items: baseline;
    gap: 0.375rem;
    padding: 0;
    border: none;
    background: none;
    color: var(--color-primary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .picker-count {
    color: var(--color-text-secondary);
    font-weight: normal;
  }

  .picker-filter {
    display: block;
    width: 100%;
    box-sizing: border-box;
    margin: 0.5rem 0 0;
    padding: 0.375rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-sm);
  }

  .picker-filter:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }

  .picker-filter::placeholder {
    color: var(--color-text-secondary);
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .picker-filter {
      font-size: 1rem;
    }
  }

  .picker-list {
    display: flex;
    flex-direction: column;
    max-height: 14rem;
    margin: 0.5rem 0 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
    border-top: 1px solid var(--color-border);
  }

  .picker-item {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
  }

  .picker-item input {
    flex: none;
    margin: 0.25rem 0 0;
    accent-color: var(--color-primary);
  }

  .picker-item.disabled {
    cursor: default;
    opacity: 0.5;
  }

  .picker-text {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    color: var(--color-text);
    font-family: var(--font-serif, Georgia, serif);
    font-size: var(--text-sm);
    line-height: var(--leading-relaxed);
  }

  .picker-hint {
    margin: 0.375rem 0 0;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }

  .caption {
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }

  .link-card {
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 0.625rem;
  }

  .link-card-image {
    display: block;
    width: 100%;
    aspect-ratio: 1.91 / 1;
    max-height: 10rem;
    object-fit: cover;
    border-bottom: 1px solid var(--color-border);
  }

  .link-card-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.625rem 0.75rem;
  }

  .link-card-title {
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
  }

  .link-card-domain {
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }

  .notice {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.375rem 0.75rem;
    margin: 0 1.25rem 1rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.5rem;
    background: var(--color-bg-secondary);
    color: var(--color-text);
    font-size: var(--text-sm);
  }

  .allow {
    padding: 0.1875rem 0.625rem;
    border: 1px solid var(--color-primary, #0066cc);
    border-radius: 6px;
    background: none;
    color: var(--color-primary, #0066cc);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  /* One row under a hairline: the option on the left, the count and Post on
     the right. Cancel is the close button, Escape, or the backdrop. */
  .footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 0.75rem 1.25rem;
    border-top: 1px solid var(--color-border);
  }

  .footer > :global(.quote-mode) {
    margin-right: auto;
  }

  .btn {
    min-height: 2.25rem;
    padding: 0.4375rem 1.25rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    cursor: pointer;
  }

  .btn.primary {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: #fff;
  }

  .btn.primary:hover {
    background: var(--color-primary-dark);
    border-color: var(--color-primary-dark);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
