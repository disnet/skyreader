// The real titles of the pages an article links to, for "Links in this
// article": an article's own link text ("here", "an influential ally") rarely
// says what's behind it. Asked of the server 50 at a time, in the order given
// (the list's order, so the top rows fill first), and kept for the session so
// reopening a list costs nothing.

/** What one request asks about; the server answers for no more. */
export const PAGE_TITLES_CHUNK = 50;
/** A page still being read is asked about once more, after this long. */
export const PAGE_TITLES_RETRY_MS = 3000;

type Ask = (urls: string[]) => Promise<{ titles: Record<string, string>; pending: boolean }>;

/** url → its title, or null when the page names none (or couldn't be read). */
const known = new Map<string, string | null>();

export function knownPageTitle(url: string): string | undefined {
  return known.get(url) ?? undefined;
}

/**
 * Look up the titles of `urls` not yet known, calling `onTitles` as each answer
 * arrives. Stops early when `signal` aborts (the list closed, the article
 * changed). Never throws: a failed ask leaves those links with their text.
 */
export async function loadPageTitles(
  urls: string[],
  ask: Ask,
  onTitles: (titles: Record<string, string>) => void,
  signal?: AbortSignal,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<void> {
  let todo = [...new Set(urls)].filter((u) => !known.has(u));
  for (let attempt = 0; attempt < 2 && todo.length > 0; attempt++) {
    if (attempt > 0) await wait(PAGE_TITLES_RETRY_MS);
    const retry: string[] = [];
    for (let i = 0; i < todo.length; i += PAGE_TITLES_CHUNK) {
      if (signal?.aborted) return;
      const chunk = todo.slice(i, i + PAGE_TITLES_CHUNK);
      let answer: Awaited<ReturnType<Ask>>;
      try {
        answer = await ask(chunk);
      } catch {
        return;
      }
      for (const url of chunk) {
        const title = answer.titles[url];
        if (title) known.set(url, title);
        // Settled unless the server is still reading something in this chunk.
        else if (!answer.pending || attempt > 0) known.set(url, null);
        else retry.push(url);
      }
      if (signal?.aborted) return;
      onTitles(answer.titles);
    }
    todo = retry;
  }
}

/** For tests. */
export function forgetPageTitles(): void {
  known.clear();
}
