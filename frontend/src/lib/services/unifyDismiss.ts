/**
 * "Keep both" dismissals for the unify notice (a site followed by both RSS and
 * standard.site), persisted by host so the notice doesn't nag once dismissed.
 * Both the /sources notice and the add-feed dialogs record dismissals here, but
 * only /sources reads them to suppress the notice — the add dialogs always show
 * it, since adding a feed on a host is a deliberate act worth re-confirming.
 */
const UNIFY_DISMISS_KEY = 'skyreader:unify-dismissed';

export function loadDismissedUnifyHosts(): Set<string> {
  try {
    const raw = localStorage.getItem(UNIFY_DISMISS_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // ignore
  }
  return new Set();
}

export function dismissUnifyHost(host: string): void {
  try {
    const next = loadDismissedUnifyHosts();
    next.add(host);
    localStorage.setItem(UNIFY_DISMISS_KEY, JSON.stringify([...next]));
  } catch {
    // ignore
  }
}
