// What the reader can be told about the Margin highlight sync: whether a poll is
// out, when one last finished, whether it was partial, and whether it stopped
// because the Margin grant lapsed. The poll itself runs silently app-wide (see
// services/marginHighlightImport.ts); this is what lets /highlights and Settings
// say it is happening at all.
//
// The last-synced time is kept per device and per account in localStorage, so
// "Synced 5m ago" survives a reload but never shows one account another's.

const STORAGE_KEY = 'skyreader-margin-sync';

interface Stored {
  did: string;
  at: number;
}

function readStored(did: string | null | undefined): number | null {
  if (!did) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return parsed.did === did && typeof parsed.at === 'number' ? parsed.at : null;
  } catch {
    return null;
  }
}

function writeStored(did: string, at: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ did, at } satisfies Stored));
  } catch {
    // Storage blocked: the time just won't outlive this page.
  }
}

let syncing = $state(false);
let truncated = $state(false);
let lapsed = $state(false);
let failed = $state(false);
let syncedAt = $state<{ did: string; at: number } | null>(null);

export const marginSyncStore = {
  get syncing() {
    return syncing;
  },
  get truncated() {
    return truncated;
  },
  /** The last poll couldn't reach Margin; cleared by the next one that does. */
  get failed() {
    return failed;
  },
  /** The Margin grant lapsed and the sync switched itself off. */
  get lapsed() {
    return lapsed;
  },
  /** When a poll last finished for this account on this device, or null. */
  lastSyncedAt(did: string | null | undefined): number | null {
    if (!did) return null;
    if (syncedAt?.did === did) return syncedAt.at;
    return readStored(did);
  },
  started() {
    syncing = true;
  },
  finished(
    did: string | null | undefined,
    result: { truncated: boolean } | null,
    options: { failed?: boolean } = {}
  ) {
    syncing = false;
    failed = options.failed ?? false;
    if (!result) return;
    truncated = result.truncated;
    lapsed = false;
    if (did) {
      const at = Date.now();
      syncedAt = { did, at };
      writeStored(did, at);
    }
  },
  markLapsed() {
    syncing = false;
    failed = false;
    lapsed = true;
  },
  /** The reader turned it back on, or off: the lapse is no longer news. */
  clearLapsed() {
    lapsed = false;
  },
  /** Turned off: nothing is partial any more. */
  clearTruncated() {
    truncated = false;
  },
  /** Test seam: forget everything but the stored time. */
  reset() {
    syncing = false;
    truncated = false;
    lapsed = false;
    failed = false;
  },
};
