<script lang="ts">
  // @mention typeahead for a plain <textarea>. Give it the textarea element and
  // its bound value; it watches the caret for an `@handle` token, queries the
  // public Bluesky typeahead API, and splices the chosen handle into the text.
  //
  // The backend resolves `@handle.tld` tokens into didMention facets on write
  // (see backend/src/utils/mention-facets.ts), so all this component does is help
  // the user type a real, complete handle — no DID work happens here.
  //
  // It attaches its own listeners to the textarea (capture-phase keydown so it
  // gets first dibs on the arrow/enter/escape keys before the composer's own
  // handlers). Rendered fixed-position so it escapes any overflow-clipping
  // ancestor, and kept inside the host's DOM subtree so the composer's
  // outside-click logic doesn't treat picking a result as a click-away.
  import { tick } from 'svelte';
  import { searchBlueskyActors, type BlueskySearchResult } from '$lib/services/blueskySearch';
  import { getCaretCoordinates } from '$lib/utils/caretCoordinates';
  import UserCard from '$lib/components/common/UserCard.svelte';

  interface Props {
    /** The textarea to augment. Listeners attach once it's set. */
    textareaEl: HTMLTextAreaElement | null;
    /** Two-way bound text; rewritten in place when a result is picked. */
    value: string;
  }

  let { textareaEl, value = $bindable() }: Props = $props();

  // The active `@`-token under the caret: byte-agnostic string offsets into value.
  interface Token {
    start: number; // index of the '@'
    end: number; // index just past the token (handle chars around the caret)
    query: string; // text between '@' and the caret
  }

  let active = $state<Token | null>(null);
  let results = $state<BlueskySearchResult[]>([]);
  let selectedIndex = $state(0);
  let loading = $state(false);
  let menuEl = $state<HTMLDivElement | null>(null);
  let menuTop = $state(0);
  let menuLeft = $state(0);

  let open = $derived(active !== null && results.length > 0);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let searchSeq = 0;
  let lastQuery: string | null = null;

  // Chars allowed inside a handle while typing (alphanumerics, dot, hyphen). The
  // '@' must sit at a boundary so we don't fire inside emails/paths.
  const HANDLE_CHAR = /[a-zA-Z0-9.\-]/;
  const BOUNDARY = /[\s(\[<]/;

  function detectToken(text: string, caret: number): Token | null {
    let i = caret - 1;
    while (i >= 0 && HANDLE_CHAR.test(text[i])) i--;
    if (i < 0 || text[i] !== '@') return null;
    const before = i === 0 ? '' : text[i - 1];
    if (before && !BOUNDARY.test(before)) return null;
    // Extend forward past any handle chars the caret sits in the middle of.
    let end = caret;
    while (end < text.length && HANDLE_CHAR.test(text[end])) end++;
    const query = text.slice(i + 1, caret);
    return { start: i, end, query };
  }

  function close() {
    active = null;
    results = [];
    selectedIndex = 0;
    loading = false;
    lastQuery = null;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  // Recompute the token from the live caret and (de)bounce a search.
  function refresh() {
    const el = textareaEl;
    if (!el) return;
    const token = detectToken(el.value, el.selectionStart ?? el.value.length);
    if (!token || token.query.length < 1) {
      close();
      return;
    }
    active = token;
    if (token.query.length < 2) {
      // Need at least 2 chars before the typeahead API returns anything.
      results = [];
      lastQuery = null;
      return;
    }
    if (token.query === lastQuery) return;
    lastQuery = token.query;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(token.query), 180);
  }

  async function runSearch(query: string) {
    const seq = ++searchSeq;
    loading = true;
    const found = await searchBlueskyActors(query, 6);
    if (seq !== searchSeq) return; // a newer keystroke superseded this one
    loading = false;
    // Drop stale results if the token changed out from under us.
    if (!active || active.query !== query) return;
    results = found;
    selectedIndex = 0;
    positionMenu();
  }

  async function pick(result: BlueskySearchResult) {
    const el = textareaEl;
    const token = active;
    if (!el || !token) return;
    const insert = `@${result.handle} `;
    const caret = token.start + insert.length;
    value = value.slice(0, token.start) + insert + value.slice(token.end);
    close();
    await tick();
    el.focus();
    el.setSelectionRange(caret, caret);
    // Let the host's oninput run (e.g. ShareCommentBox autosize) off the change.
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // --- Positioning: anchor to the caret (the '@'), flip above if cramped. ---
  function positionMenu() {
    const el = textareaEl;
    const token = active;
    if (!el || !token) return;
    const rect = el.getBoundingClientRect();
    const caret = getCaretCoordinates(el, token.start);
    const lineTop = rect.top + caret.top - el.scrollTop;
    const lineLeft = rect.left + caret.left - el.scrollLeft;
    const height = menuEl?.offsetHeight ?? 240;
    const width = menuEl?.offsetWidth ?? 208;
    const gap = 4;

    // Below the caret's line by default; flip above when it would overflow.
    if (lineTop + caret.height + gap + height > window.innerHeight - 8) {
      menuTop = Math.max(8, lineTop - gap - height);
    } else {
      menuTop = lineTop + caret.height + gap;
    }
    // Keep the menu within the viewport horizontally.
    menuLeft = Math.max(8, Math.min(lineLeft, window.innerWidth - width - 8));
  }

  // Capture phase: intercept navigation keys before the textarea default action
  // and before the composer's own bubble-phase keydown handler.
  function onKeydownCapture(e: KeyboardEvent) {
    if (!open) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopImmediatePropagation();
        selectedIndex = (selectedIndex + 1) % results.length;
        break;
      case 'ArrowUp':
        e.preventDefault();
        e.stopImmediatePropagation();
        selectedIndex = (selectedIndex - 1 + results.length) % results.length;
        break;
      case 'Enter':
      case 'Tab':
        e.preventDefault();
        e.stopImmediatePropagation();
        pick(results[selectedIndex]);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
        break;
    }
  }

  function onInput() {
    refresh();
  }

  // Caret moved without editing (click, arrow keys we didn't consume): re-evaluate.
  function onKeyup(e: KeyboardEvent) {
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') refresh();
  }

  function onClick() {
    refresh();
  }

  function onBlur() {
    // A real focus-out closes the menu; picking a result uses mousedown
    // (preventDefault) so focus never leaves and this doesn't fire.
    close();
  }

  // (Re)bind whenever the textarea element changes.
  $effect(() => {
    const el = textareaEl;
    if (!el) return;
    el.addEventListener('keydown', onKeydownCapture, true);
    el.addEventListener('input', onInput);
    el.addEventListener('keyup', onKeyup);
    el.addEventListener('click', onClick);
    el.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('keydown', onKeydownCapture, true);
      el.removeEventListener('input', onInput);
      el.removeEventListener('keyup', onKeyup);
      el.removeEventListener('click', onClick);
      el.removeEventListener('blur', onBlur);
    };
  });

  // Keep the menu pinned to the textarea while open.
  $effect(() => {
    if (!open) return;
    positionMenu();
    const reposition = () => positionMenu();
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  });

  $effect(() => () => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });
</script>

{#if open}
  <div
    bind:this={menuEl}
    class="mention-menu"
    role="listbox"
    aria-label="Mention suggestions"
    style:top="{menuTop}px"
    style:left="{menuLeft}px"
  >
    {#each results as result, index (result.did)}
      <button
        type="button"
        class="result"
        class:selected={index === selectedIndex}
        role="option"
        aria-selected={index === selectedIndex}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => pick(result)}
        onmouseenter={() => (selectedIndex = index)}
      >
        <UserCard
          avatarUrl={result.avatar}
          displayName={result.displayName}
          handle={result.handle}
          size="small"
        />
      </button>
    {/each}
  </div>
{/if}

<style>
  .mention-menu {
    position: fixed;
    z-index: 300;
    min-width: 13rem;
    max-width: min(20rem, calc(100vw - 16px));
    max-height: 15rem;
    overflow-y: auto;
    padding: 0.25rem;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 8px;
    /* Floating overlay — one of the few elements that leaves the page plane. */
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }

  .result {
    display: block;
    width: 100%;
    padding: 0.375rem 0.5rem;
    background: none;
    border: none;
    border-radius: 6px;
    text-align: left;
    cursor: pointer;
    color: var(--color-text);
    font: inherit;
  }

  .result.selected {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  @media (prefers-color-scheme: dark) {
    .mention-menu {
      background: var(--color-bg, #1a1a1a);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .result.selected {
      background: rgba(255, 255, 255, 0.08);
    }
  }
</style>
