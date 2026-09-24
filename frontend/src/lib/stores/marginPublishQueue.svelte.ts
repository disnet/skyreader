import { SvelteSet } from 'svelte/reactivity';
import { db } from '$lib/services/db';

// Highlights whose Margin publish is queued (offline, or after a failed write)
// and hasn't drained yet. Until it drains the highlight has no `marginUri`, so
// this is what lets a note read "Public" the moment it's published, and lets
// "Make private" or a removal cancel the publish before it lands.
//
// Keyed by highlight id: ids are random per highlight, unique across items.
const queued = new SvelteSet<string>();

export const marginPublishQueue = {
  has(highlightId: string): boolean {
    return queued.has(highlightId);
  },
  add(highlightId: string) {
    queued.add(highlightId);
  },
  delete(highlightId: string) {
    queued.delete(highlightId);
  },
};

// Rebuild from the queue itself, so a publish queued before a reload still
// reads as one. Held entries belong to a signed-out account.
async function hydrate() {
  try {
    const entries = await db.syncQueue.where('collection').equals('integration').toArray();
    for (const entry of entries) {
      if (entry.operation !== 'create' || entry.status === 'held') continue;
      try {
        const payload = JSON.parse(entry.payload) as { kind?: unknown; highlightId?: unknown };
        if (payload.kind === 'note' && typeof payload.highlightId === 'string') {
          queued.add(payload.highlightId);
        }
      } catch {
        // An unreadable payload names no highlight.
      }
    }
  } catch (err) {
    console.error('Failed to read queued Margin publishes:', err);
  }
}

if (typeof indexedDB !== 'undefined') void hydrate();
