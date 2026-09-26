// Posting to Bluesky from inside the app. For a highlight: the passage as a
// text shot (or quoted in the text), the reader's note on it as the post's
// words, and the article's link. Without one (the discussion's "Add yours"),
// it's the reader's words over the article's link card. One global dialog,
// mounted once in AppShell. The post itself goes out through the same path as
// a share's "Also on Bluesky" cross-post.

import { api } from '$lib/services/api';
import { grantPermissions } from '$lib/services/permissions';
import { crossPostToBluesky, type BlueskySource } from '$lib/services/blueskyCrossPost';
import { preferences } from '$lib/stores/preferences.svelte';
import type { ShareDraftBlock } from '$lib/types';

export interface BlueskyComposerOpenOptions {
  source: BlueskySource;
  /** The highlighted passage; absent for a plain link post. */
  quote?: string;
  /** The reader's note on it, seeded as the post's text. */
  note?: string;
}

interface Session {
  source: BlueskySource;
  /** '' for a plain link post. */
  quote: string;
}

/** Set before leaving for a permission grant: which account, and what post. */
// The key keeps its old name so a grant in flight across a deploy still resumes.
const GRANT_KEY = 'skyreader:grant-bluesky-highlight';

export function blueskyPostBlocks(quote: string, text: string): ShareDraftBlock[] {
  const blocks: ShareDraftBlock[] = [{ kind: 'text', text }];
  if (quote) blocks.push({ kind: 'quote', text: quote });
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
    session = { source: options.source, quote: options.quote ?? '' };
    text = options.note?.trim() ?? '';
    // The same sticky choice as the share composer's "Quotes as images".
    textShots = preferences.blueskyTextShots;
    access = 'unknown';
    void checkAccess();
  }

  function close() {
    session = null;
    text = '';
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
    const { source, quote } = session;
    const blocks = blueskyPostBlocks(quote, text);
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
          JSON.stringify({ did, source: session.source, quote: session.quote, text })
        );
      } catch {
        // Storage blocked: the grant still works, the dialog just won't reopen.
      }
    }
    grantPermissions(['blueskyPost'], window.location.pathname + window.location.search);
  }

  /** Back from a grant asked for in the dialog: reopen it where it was. */
  function resumeAfterGrant(did: string) {
    let pending: { did?: unknown; source?: { url?: unknown }; quote?: unknown; text?: unknown };
    try {
      const raw = localStorage.getItem(GRANT_KEY);
      if (!raw) return;
      localStorage.removeItem(GRANT_KEY);
      pending = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      !pending ||
      pending.did !== did ||
      typeof pending.source?.url !== 'string' ||
      typeof pending.quote !== 'string' ||
      session
    ) {
      return;
    }
    open({
      source: pending.source as BlueskySource,
      quote: pending.quote,
      note: typeof pending.text === 'string' ? pending.text : '',
    });
  }

  return {
    open,
    close,
    post,
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
