// Drawing a Semble connection — a typed edge from the article you're reading to
// another URL — as one global session.
//
// Deliberately the same architecture as integrationSave: a store here, a dialog
// mounted once in AppShell, so any reading surface can open it without threading
// props. What differs is the write path.
//
// Online-only, no offline queue. A connection is a deliberate act on the context
// in front of the reader — unlike a card save there's nothing to reconcile later,
// and queueing would add sync-queue surface for a write nobody makes blind. A
// failure keeps the toast and invites a retry.
//
// Semble's own API dedupes identical edges; a direct PDS write doesn't, so a
// double-click would mint two records. `submitting` is what stops that.
import { api, ScopeUpgradeError } from '$lib/services/api';
import { auth } from '$lib/stores/auth.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { mentionLaneItemsStore } from '$lib/stores/mentionLaneItems.svelte';
import { recentReadsStore } from '$lib/stores/recentReads.svelte';
import { sembleCardUrl, sembleSourceUrl } from '$lib/utils/semble';
import { segments } from '$lib/utils/blueskyPost';
import type { SembleConnectionType } from '$lib/types';

export interface SembleConnectionSource {
  /** The article the reader is on — the fixed end of the edge. */
  url: string;
  title?: string;
  /** This URL's card page on semble.so, when the panel already resolved one. */
  cardUrl?: string | null;
}

/** The other end, already chosen by the surface that opened the dialog. */
export interface SembleConnectionTarget {
  url: string;
  title?: string;
}

export interface SembleConnectionSubmission {
  /** The other end: pasted, or picked out of the reader's Saved list. */
  targetUrl: string;
  targetTitle?: string;
  connectionType: SembleConnectionType;
  note?: string;
  /** True when the reader flipped the arrow, making the target the source. */
  reversed: boolean;
}

/** Semble's lexicon caps a connection's note here (atproto maxLength = UTF-8 bytes). */
export const MAX_NOTE_BYTES = 1000;
/** The most a quoted passage takes of the note, leaving the rest for the reader's words. */
const QUOTE_MAX_BYTES = 600;

const utf8 = new TextEncoder();

function byteLength(text: string): number {
  return utf8.encode(text).length;
}

/**
 * `text` cut to fit `budget` UTF-8 bytes, ellipsis included: by whole
 * graphemes, then back to a word break when there's one near the end.
 */
function fitBytes(text: string, budget: number): string {
  if (byteLength(text) <= budget) return text;
  const room = budget - byteLength('…');
  if (room <= 0) return '';
  let cut = '';
  let used = 0;
  // Each grapheme is at least a byte, so nothing past `room` of them can fit.
  for (const grapheme of segments(text.slice(0, room * 2))) {
    const size = byteLength(grapheme);
    if (used + size > room) break;
    cut += grapheme;
    used += size;
  }
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > cut.length * 0.6) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

/**
 * The note a connection drawn from a passage opens with. The connection record
 * has no passage field, so the note carries the quote: that's what says why the
 * two pieces meet. A highlight's own note follows it. Both are cut to fit the
 * lexicon's limit, the quote to at most `QUOTE_MAX_BYTES` so the reader keeps
 * room for a line of their own. Empty when the passage is only whitespace.
 */
export function noteFromPassage(passage: string, highlightNote?: string): string {
  const text = passage.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const quoted = `“${fitBytes(text, QUOTE_MAX_BYTES - byteLength('“”'))}”`;
  const own = highlightNote?.trim();
  if (!own) return quoted;
  const rest = fitBytes(own, MAX_NOTE_BYTES - byteLength(quoted) - byteLength('\n\n'));
  return rest ? `${quoted}\n\n${rest}` : quoted;
}

function createSembleConnectionStore() {
  let open = $state(false);
  let submitting = $state(false);
  let source = $state<SembleConnectionSource | null>(null);
  let target = $state<SembleConnectionTarget | null>(null);
  let initialNote = $state('');

  function openFor(
    data: SembleConnectionSource,
    options: { target?: SembleConnectionTarget; note?: string } = {}
  ) {
    if (!data.url) return;
    source = data;
    target = options.target?.url ? options.target : null;
    initialNote = options.note ?? '';
    open = true;
  }

  function close() {
    if (submitting) return;
    open = false;
    source = null;
    target = null;
    initialNote = '';
  }

  async function submit(input: SembleConnectionSubmission) {
    if (submitting) return;
    const article = source;
    if (!article) return;

    // Semble keys cards by the exact URL string, so the variant its card page
    // holds ("/post" vs "/post/") is the one an edge has to name if it's going
    // to roll up onto that page. When the panel gave us a cardUrl, it is
    // literally that variant, encoded — prefer it over our own copy. A host
    // that didn't pass one may still have it from a discussion panel opened
    // earlier this session.
    const cardUrl =
      article.cardUrl || mentionLaneItemsStore.get(article.url, 'semble')?.sembleContext?.cardUrl;
    const articleUrl = sembleSourceUrl(cardUrl, article.url);
    const from = input.reversed ? input.targetUrl : articleUrl;
    const to = input.reversed ? articleUrl : input.targetUrl;

    submitting = true;
    const toastId = toastStore.add('Connecting on Semble…');
    try {
      const result = await api.createSembleConnection({
        source: from,
        target: to,
        connectionType: input.connectionType,
        note: input.note?.trim() || undefined,
      });

      // Semble's AppView won't serve this edge back for a while (firehose index
      // + the proxy's mention cache), so put it in the panel ourselves rather
      // than leave the reader looking at a list their own act isn't in.
      echoIntoPanel(article.url, input, result.uri);

      open = false;
      source = null;
      target = null;
      toastStore.update(toastId, 'success', 'Connected on Semble', {
        label: 'View',
        href: cardUrl || sembleCardUrl(article.url) || undefined,
      });
    } catch (err) {
      // The global banner already offers "Allow access" for Semble — a second
      // copy of the same news in a toast is noise.
      if (err instanceof ScopeUpgradeError) {
        toastStore.remove(toastId);
        open = false;
        source = null;
        target = null;
        return;
      }
      console.error('Failed to create Semble connection:', err);
      const message = err instanceof Error ? err.message : 'Please try again';
      toastStore.update(toastId, 'error', `Couldn't connect on Semble — ${message}`);
    } finally {
      submitting = false;
    }
  }

  /** Prepend the reader's own new edge into the article's resolved Semble block. */
  function echoIntoPanel(articleUrl: string, input: SembleConnectionSubmission, uri: string) {
    const user = auth.user;
    if (!user) return;
    mentionLaneItemsStore.addSembleConnection(articleUrl, {
      id: uri,
      // Direction is read from the article's side: an unreversed edge points out
      // of what the reader is on.
      direction: input.reversed ? 'in' : 'out',
      type: input.connectionType.toLowerCase().replace(/_/g, ' '),
      note: input.note?.trim() || null,
      curator: {
        did: user.did,
        handle: user.handle,
        name: user.displayName ?? null,
        avatarUrl: user.avatarUrl ?? null,
      },
      createdAt: new Date().toISOString(),
      other: {
        url: input.targetUrl,
        title: input.targetTitle ?? null,
        description: null,
        siteName: null,
        imageUrl: null,
      },
    });
  }

  return {
    get open() {
      return open;
    },
    get submitting() {
      return submitting;
    },
    /** The article the dialog is open for — the fixed end of the edge. */
    get source() {
      return source;
    },
    /** The other end the dialog opened with, if the opener already knew it. */
    get target() {
      return target;
    },
    /** The note the dialog opened with: a quoted passage, when opened from one. */
    get initialNote() {
      return initialNote;
    },
    /** Open the dialog with `data` as the fixed end of the edge; `target` is
     *  the other end when the opener can already guess it, `note` a passage to
     *  start the note with. */
    openFor,
    close,
    submit,
  };
}

export const sembleConnectionStore = createSembleConnectionStore();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export interface ConnectSuggestion {
  /** The previous read's title, or its host when it has none. */
  label: string;
  host: string;
  /** Open the dialog with both ends filled. */
  onConnect: () => void;
  /** Open it with only this article filled, to pick from the library. */
  onPickOther: () => void;
}

/**
 * "Connect to <the article you read before this one>?" for the end of an
 * article: the dialog opens with both ends filled, so the reader only picks the
 * relation. Undefined when there's no recent previous read to offer.
 */
export function connectToPreviousRead(
  source: SembleConnectionSource
): ConnectSuggestion | undefined {
  const previous = recentReadsStore.previousBefore(source.url);
  if (!previous) return undefined;
  const host = hostOf(previous.url);
  return {
    label: previous.title || host,
    host,
    onConnect: () =>
      sembleConnectionStore.openFor(source, {
        target: { url: previous.url, title: previous.title },
      }),
    onPickOther: () => sembleConnectionStore.openFor(source),
  };
}
