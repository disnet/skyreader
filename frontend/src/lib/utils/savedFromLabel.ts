import type { SavedItem } from '$lib/types';

const MAX_TITLE_LENGTH = 40;

function truncateTitle(title: string): string {
  const clean = title.trim();
  return clean.length > MAX_TITLE_LENGTH
    ? `${clean.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : clean;
}

/** Quiet provenance copy for a saved item's metadata line. */
export function savedFromLabel(
  item: Pick<SavedItem, 'savedVia' | 'savedFromTitle'>
): string | null {
  if (item.savedFromTitle?.trim()) return `from ${truncateTitle(item.savedFromTitle)}`;

  switch (item.savedVia) {
    case 'extension':
      return 'from extension';
    case 'share-target':
      return 'from share sheet';
    case 'semble':
      return 'from Semble';
    case 'margin':
      return 'from Margin';
    default:
      return null;
  }
}
