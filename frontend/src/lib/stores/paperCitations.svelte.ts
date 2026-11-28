import { api } from '$lib/services/api';
import type { PaperCitations } from '$lib/types';
import { auth } from './auth.svelte';

/**
 * The works citing a paper, for the discussion's Cited by tab (backend
 * routes/paper-citations.ts). Signed-in and online only. Held per DOI for the
 * session: the server caches a week, so reopening a paper asks once. A failed
 * lookup is remembered as nothing, so the tab simply doesn't appear, and is
 * tried again after a few minutes.
 */

const RETRY_FAILED_MS = 5 * 60_000;

function createPaperCitationsStore() {
  let byDoi = $state<Map<string, PaperCitations>>(new Map());
  const inFlight = new Set<string>();
  const failedAt = new Map<string, number>();

  function keyOf(doi: string): string {
    return doi.toLowerCase();
  }

  return {
    /** What's held for this DOI; undefined until it has loaded. */
    get(doi: string | undefined): PaperCitations | undefined {
      return doi ? byDoi.get(keyOf(doi)) : undefined;
    },

    /** Look the paper up, once per session (a failure again after a while). */
    async load(doi: string): Promise<void> {
      const key = keyOf(doi);
      if (!auth.user || byDoi.has(key) || inFlight.has(key)) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      const failed = failedAt.get(key);
      if (failed !== undefined && Date.now() - failed < RETRY_FAILED_MS) return;
      inFlight.add(key);
      try {
        const result = await api.getPaperCitations(doi);
        byDoi = new Map(byDoi).set(key, result);
        failedAt.delete(key);
      } catch {
        // Citations are adornment: the discussion reads the same without them.
        failedAt.set(key, Date.now());
      } finally {
        inFlight.delete(key);
      }
    },
  };
}

export const paperCitationsStore = createPaperCitationsStore();
