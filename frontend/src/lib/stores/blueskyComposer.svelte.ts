// Posting to Bluesky from inside the app. For a highlight: the passage as a
// text shot (or quoted in the text), the reader's note on it as the post's
// words, and the article's link. The reader can add more of the article's
// highlights, up to Bluesky's four images. Without any (the discussion's "Add
// yours"), it's the reader's words over the article's link card. One global dialog,
// mounted once in AppShell. The post itself goes out through the same path as
// a share's "Also on Bluesky" cross-post.

import { api } from '$lib/services/api';
import { grantPermissions } from '$lib/services/permissions';
import { crossPostToBluesky, type BlueskySource } from '$lib/services/blueskyCrossPost';
import { preferences } from '$lib/stores/preferences.svelte';
import { BLUESKY_MAX_IMAGES } from '$lib/utils/blueskyPost';
import type { ShareDraftBlock } from '$lib/types';

export interface BlueskyComposerOpenOptions {
  source: BlueskySource;
  /** The highlighted passage; absent for a plain link post. */
  quote?: string;
  /** The reader's note on it, seeded as the post's text. */
  note?: string;
  /** Where the article's highlights are kept, so more of them can be added. */
  itemKey?: string;
}

interface Session {
  source: BlueskySource;
  /** The passages going out, in order; empty for a plain link post. */
  quotes: string[];
  /** What it opened with, kept on offer after being taken out. */
  offered: string[];
  itemKey?: string;
}

/** Set before leaving for a permission grant: which account, and what post. */
// The key keeps its old name so a grant in flight across a deploy still resumes.
const GRANT_KEY = 'skyreader:grant-bluesky-highlight';

export function blueskyPostBlocks(quotes: string[], text: string): ShareDraftBlock[] {
  const blocks: ShareDraftBlock[] = [{ kind: 'text', text }];
  for (const quote of quotes) blocks.push({ kind: 'quote', text: quote });
  return blocks;
}

function createBlueskyComposerStore() {
  let session = $state<Session | null>(null);
  let text = $state('');
  let textShots = $state(true);
  // Whether this account can post to Bluesky, checked on open so the dialog can
  // ask for access before Post rather than after.
  let access = $state<'unknown' | 'granted' | 'missing'>('unknown');

  function open(options: BlueskyComposerOpenOptions) {
    start(options, options.quote ? [options.quote] : []);
  }

  function start(options: BlueskyComposerOpenOptions, quotes: string[]) {
    session = {
      source: options.source,
      quotes: quotes.slice(0, BLUESKY_MAX_IMAGES),
      offered: quotes.slice(0, BLUESKY_MAX_IMAGES),
      ...(options.itemKey ? { itemKey: options.itemKey } : {}),
    };
    text = options.note?.trim() ?? '';
    // The same sticky choice as the share composer's "Quotes as" toggle.
    textShots = preferences.blueskyTextShots;
    access = 'unknown';
    void checkAccess();
  }

  function close() {
    session = null;
    text = '';
  }

  /** Add a passage to the post, or take it out; at most four go out as images. */
  function toggleQuote(quote: string) {
    if (!session) return;
    const { quotes } = session;
    if (quotes.includes(quote)) {
      session = { ...session, quotes: quotes.filter((q) => q !== quote) };
    } else if (quotes.length < BLUESKY_MAX_IMAGES) {
      session = { ...session, quotes: [...quotes, quote] };
    }
  }

  async function checkAccess() {
    const asked = session;
    try {
      const status = await api.getIntegrationStatus();
      // Closed, or opened on another post, while this was in flight.
      if (session !== asked) return;
      access = status.scopeStatus.blueskyPost ? 'granted' : 'missing';
    } catch {
      // Offline or a blip: leave it unknown and let the post itself find out.
    }
  }

  /** Post in the background (reported by toast) and close the dialog. */
  function post() {
    if (!session) return;
    const { source, quotes } = session;
    const blocks = blueskyPostBlocks(quotes, text);
    const shots = textShots;
    close();
    void crossPostToBluesky(source, blocks, {
      textShots: shots,
      failureMessage: 'Couldn’t post to Bluesky',
    });
  }

  /**
   * "Allow access" from the dialog. The grant leaves the page, so remember the
   * post being written and reopen it on return (resumeAfterGrant).
   */
  function allowAccess(did: string | undefined) {
    if (session && did) {
      try {
        localStorage.setItem(
          GRANT_KEY,
          JSON.stringify({
            did,
            source: session.source,
            quotes: session.quotes,
            itemKey: session.itemKey,
            text,
          })
        );
      } catch {
        // Storage blocked: the grant still works, the dialog just won't reopen.
      }
    }
    grantPermissions(['blueskyPost'], window.location.pathname + window.location.search);
  }

  /** Back from a grant asked for in the dialog: reopen it where it was. */
  function resumeAfterGrant(did: string) {
    let pending: {
      did?: unknown;
      source?: { url?: unknown };
      quotes?: unknown;
      /** One passage, as a grant asked for before a post could carry several. */
      quote?: unknown;
      itemKey?: unknown;
      text?: unknown;
    };
    try {
      const raw = localStorage.getItem(GRANT_KEY);
      if (!raw) return;
      localStorage.removeItem(GRANT_KEY);
      pending = JSON.parse(raw);
    } catch {
      return;
    }
    if (!pending || pending.did !== did || typeof pending.source?.url !== 'string' || session) {
      return;
    }
    const quotes = Array.isArray(pending.quotes)
      ? pending.quotes.filter((q): q is string => typeof q === 'string' && q !== '')
      : typeof pending.quote === 'string' && pending.quote
        ? [pending.quote]
        : [];
    start(
      {
        source: pending.source as BlueskySource,
        note: typeof pending.text === 'string' ? pending.text : '',
        itemKey: typeof pending.itemKey === 'string' ? pending.itemKey : undefined,
      },
      quotes
    );
  }

  return {
    open,
    close,
    post,
    toggleQuote,
    allowAccess,
    resumeAfterGrant,
    get session() {
      return session;
    },
    get text() {
      return text;
    },
    set text(value: string) {
      text = value;
    },
    get textShots() {
      return textShots;
    },
    setTextShots(value: boolean) {
      textShots = value;
      preferences.setBlueskyTextShots(value);
    },
    get access() {
      return access;
    },
  };
}

export const blueskyComposerStore = createBlueskyComposerStore();
