<script lang="ts">
  // Posting one highlight to Bluesky. Planned live like the share composer's
  // cross-post: the note becomes the post's text (trimmed to 300), and the
  // passage goes out as a text shot with the link in the text, or, with that
  // off, quoted in the text over the article's link card.
  import Modal from '$lib/components/common/Modal.svelte';
  import BlueskyCountRing from './BlueskyCountRing.svelte';
  import {
    blueskyHighlightStore as composer,
    highlightPostBlocks,
  } from '$lib/stores/blueskyHighlight.svelte';
  import { domainOf } from '$lib/services/blueskyCrossPost';
  import { planBlueskyPost } from '$lib/utils/blueskyPost';
  import { renderTextShot } from '$lib/utils/textShot';
  import { auth } from '$lib/stores/auth.svelte';

  let session = $derived(composer.session);

  let plan = $derived(
    session
      ? planBlueskyPost(highlightPostBlocks(session.quote, composer.text), session.source.url, {
          textShots: composer.textShots,
        })
      : null
  );

  let summary = $derived.by(() => {
    if (!plan) return '';
    const parts = [plan.shots.length > 0 ? 'Image, link in the text' : 'Link card'];
    if (plan.trimmed) parts.push('text trimmed to fit');
    return parts.join(' · ');
  });

  // The text shot itself, drawn once per highlight so the reader sees the image
  // that will go out. A failed draw just leaves the preview off; posting falls
  // back to the link card on its own.
  let shotUrl = $state<string | null>(null);
  $effect(() => {
    const current = session;
    if (!current) return;
    let url: string | null = null;
    let cancelled = false;
    renderTextShot(current.quote, {
      title: current.source.title,
      domain: domainOf(current.source.url),
    })
      .then((shot) => {
        if (cancelled) return;
        url = URL.createObjectURL(shot.blob);
        shotUrl = url;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      shotUrl = null;
    };
  });

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

<Modal open={Boolean(session)} onclose={composer.close} title="Post to Bluesky" zIndex={250}>
  {#if session}
    <div class="body">
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        class="post-text"
        bind:value={composer.text}
        placeholder="Say something about it…"
        aria-label="Post text"
        rows="2"
        autofocus></textarea>

      <figure class="preview">
        {#if composer.textShots && shotUrl}
          <img class="shot" src={shotUrl} alt={session.quote} />
        {:else}
          <blockquote class="quote">{session.quote}</blockquote>
        {/if}
        <figcaption class="caption">
          {#if composer.access === 'missing'}
            <span>Posting to Bluesky needs your permission.</span>
            <button type="button" class="allow" onclick={() => composer.allowAccess(auth.user?.did)}
              >Allow access</button
            >
          {:else}
            <span>{summary}</span>
          {/if}
        </figcaption>
      </figure>

      <div class="footer">
        <label class="option">
          <input
            type="checkbox"
            checked={composer.textShots}
            onchange={(e) => composer.setTextShots(e.currentTarget.checked)}
          />
          Quote as image
        </label>
        {#if plan && composer.access !== 'missing'}<BlueskyCountRing length={plan.length} />{/if}
        <button type="button" class="btn" onclick={composer.close}>Cancel</button>
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
  .body {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Written like the share composer: the post's own text, not a form field.
     No frame, no grab handle; it grows with what's typed (field-sizing), up to
     a cap where it scrolls instead. */
  .post-text {
    display: block;
    width: 100%;
    box-sizing: border-box;
    min-height: 2lh;
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
    font-size: max(var(--text-lg), 16px);
    line-height: var(--leading-normal);
  }

  /* The muted-ink token at full strength keeps the placeholder over the
     contrast bar. */
  .post-text::placeholder {
    color: var(--color-text-secondary);
  }

  .shot {
    display: block;
    width: 100%;
    height: auto;
    max-height: 22rem;
    object-fit: contain;
    object-position: top left;
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
  }

  /* Drawn like a quoted highlight: the article serif, the gold rule. */
  .quote {
    margin: 0;
    padding: 0.125rem 0 0.125rem 0.875rem;
    border-left: 3px solid rgba(245, 197, 24, 0.7);
    max-height: 12rem;
    overflow-y: auto;
    font-family: var(--font-serif, Georgia, serif);
    line-height: 1.6;
    color: var(--color-text);
    white-space: pre-wrap;
  }

  .preview {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0;
  }

  .caption {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.25rem 0.625rem;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }

  /* One row: the option on the left, the count and the actions on the right. */
  .footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-top: 0.25rem;
  }

  .footer :global(.count-ring) {
    margin-left: auto;
    margin-right: 0.25rem;
  }

  /* Without the ring (permission missing), the buttons still sit right. */
  .footer .option + .btn {
    margin-left: auto;
  }

  .option {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .option input {
    margin: 0;
    cursor: pointer;
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

  .btn {
    min-height: 2.25rem;
    padding: 0.4375rem 1rem;
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .btn:hover {
    background: var(--color-bg-secondary);
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
