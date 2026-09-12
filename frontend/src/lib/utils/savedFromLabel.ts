import type { SavedItem } from '$lib/types';

const MAX_TITLE_LENGTH = 40;

type Provenance = Pick<SavedItem, 'savedVia' | 'savedFromTitle' | 'savedFromUrl'>;

function truncateTitle(title: string): string {
  const clean = title.trim();
  return clean.length > MAX_TITLE_LENGTH
    ? `${clean.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : clean;
}

/**
 * Quiet provenance copy for a saved item's metadata line. Total over legacy rows
 * (no provenance → no label), and deliberately silent for the channels that have
 * nothing to say on their own: the in-app save modal ('web'), and a link saved
 * from an untitled reading surface ('reader' with no referrer). "From the save
 * modal" is noise, not information.
 */
export function savedFromLabel(item: Provenance): string | null {
  if (item.savedFromTitle?.trim()) return `from ${truncateTitle(item.savedFromTitle)}`;

  switch (item.savedVia) {
    case 'extension':
      return 'from extension';
    // `/save` serves the Android share sheet, an Apple Shortcut and (when it
    // isn't self-identified below) a bookmarklet, so the copy names none of
    // them — a desktop bookmarklet save claiming a share sheet would simply be
    // untrue.
    case 'share-target':
      return 'from a shared link';
    case 'bookmarklet':
      return 'from bookmarklet';
    case 'semble':
      return 'from Semble';
    case 'margin':
      return 'from Margin';
    default:
      return null;
  }
}

/**
 * The untruncated referrer behind a label, for its native tooltip: the full
 * title, and the source URL when the save kept one. `null` when the label
 * already says everything there is to say.
 */
export function savedFromDetail(item: Provenance): string | null {
  const title = item.savedFromTitle?.trim();
  if (!title) return null;
  const url = item.savedFromUrl?.trim();
  if (url) return `from ${title}\n${url}`;
  return title.length > MAX_TITLE_LENGTH ? `from ${title}` : null;
}
