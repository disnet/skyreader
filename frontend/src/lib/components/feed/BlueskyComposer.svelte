<script lang="ts">
  // Posting to Bluesky from inside the app. Planned live like the share
  // composer's cross-post: the note becomes the post's text (trimmed to 300),
  // and a highlight's passage goes out as a text shot with the link in the
  // text, or, with that off, quoted in the text over the article's link card.
  // Without a passage (the discussion's "Add yours") it's a plain link post.
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import BlueskyCountRing from './BlueskyCountRing.svelte';
  import QuoteModeToggle from './QuoteModeToggle.svelte';
  import {
    blueskyComposerStore as composer,
    blueskyPostBlocks,
  } from '$lib/stores/blueskyComposer.svelte';
  import { domainOf } from '$lib/services/blueskyCrossPost';
  import { BLUESKY_MAX_GRAPHEMES, planBlueskyPost } from '$lib/utils/blueskyPost';
  import { renderTextShot } from '$lib/utils/textShot';
  import { auth } from '$lib/stores/auth.svelte';

  let session = $derived(composer.session);

  let plan = $derived(
    session
      ? planBlueskyPost(blueskyPostBlocks(session.quote, composer.text), session.source.url, {
          textShots: composer.textShots,
        })
      : null
  );

  // The text shot itself, drawn once per passage so the reader sees the image
  // that will go out. A failed draw means posting will fall back to the quote
  // as text over the link card, so the preview does too. A shot that drew but
  // won't display (a policy blocking blob: images, say) still goes out as an
  // image; the preview can only say so.
  let shotUrl = $state<string | null>(null);
  let shotState = $state<'drawing' | 'ready' | 'failed' | 'hidden'>('drawing');
  $effect(() => {
    const current = session;
    if (!current?.quote) return;
    let url: string | null = null;
    let cancelled = false;
    shotState = 'drawing';
    renderTextShot(current.quote, {
      title: current.source.title,
      domain: domainOf(current.source.url),
    })
      .then((shot) => {
        if (cancelled) return;
        url = URL.createObjectURL(shot.blob);
        shotUrl = url;
        shotState = 'ready';
      })
      .catch(() => {
        if (!cancelled) shotState = 'failed';
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      shotUrl = null;
    };
  });

  // Whether the post goes out with the quote as an image.
  let asShot = $derived(Boolean(session?.quote) && composer.textShots && shotState !== 'failed');

  // Only what the preview can't show: an image it can't display yet, or text
  // cut to fit.
  let summary = $derived(
    [
      asShot && shotState === 'drawing' ? 'Drawing the image' : '',
      asShot && shotState === 'hidden' ? 'Image preview unavailable, posts as an image' : '',
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

<Modal open={Boolean(session)} onclose={composer.close} zIndex={250} maxWidth="520px">
  {#snippet header()}
    <div class="head">
      <h2 class="title">Post to Bluesky</h2>
      <button type="button" class="close" onclick={composer.close} aria-label="Close">
        <Icon name="x" size={18} />
      </button>
    </div>
  {/snippet}
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
            {#if !session.quote}
              {@render linkCard()}
            {:else if asShot && shotState === 'ready' && shotUrl}
              <img
                class="shot"
                src={shotUrl}
                alt={session.quote}
                onerror={() => (shotState = 'hidden')}
              />
            {:else}
              <!-- While drawing, or when the shot won't display, the quote shows
                   as text and the caption says what actually goes out. -->
              <blockquote class="quote">{session.quote}</blockquote>
              <!-- As text, the quote rides in the post and the link card hangs
                   under it, as it will on Bluesky. -->
              {#if !asShot}{@render linkCard()}{/if}
            {/if}
            {#if summary}
              <figcaption class="caption">{summary}</figcaption>
            {/if}
          </figure>
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
        {#if session.quote}
          <QuoteModeToggle
            textShots={composer.textShots}
            onchange={(on) => composer.setTextShots(on)}
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
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.875rem 0.75rem 0 1.25rem;
  }

  .title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: none;
    border-radius: 0.375rem;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .close:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  /* The modal pads its body; this surface wants its footer to run edge to edge,
     so it takes the padding back and sets its own. */
  .body {
    display: flex;
    flex-direction: column;
    margin: -1.5rem;
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

  .preview {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin: 0.625rem 0 0;
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
