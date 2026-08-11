// Helpers for the "publish new links to" picker in Settings. The choice is
// between the Skyreader linkblog and a standard.site publication the user
// already owns, so each row has to be described well enough to pick from — and
// the content format has to follow the publication, not the previous selection.

import type { LinkblogPublication, LinkblogPublicationChoice } from '$lib/types';

export type LinkblogFormat = LinkblogPublication['format'];

/** The publication's address as a user recognizes it, e.g. `leaflet.pub`. */
export function publicationHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** How many posts a publication already holds, phrased for a metadata line. */
export function publicationPostCount(posts: number | undefined): string {
  if (!posts) return 'No posts yet';
  return posts === 1 ? '1 post' : `${posts} posts`;
}

/**
 * Which content format to write to the selected publication, strongest signal
 * first: an explicit choice the user made for it, the format already in use if
 * it's the live target, the format detected from its existing posts, and
 * finally leaflet — the format every standard.site reader in the app renders.
 */
export function resolveLinkblogFormat(
  selected: LinkblogPublicationChoice | undefined,
  current: Pick<LinkblogPublication, 'uri' | 'format'>,
  overrides: Record<string, LinkblogFormat>
): LinkblogFormat {
  if (!selected) return current.format;
  return (
    overrides[selected.uri] ??
    (selected.uri === current.uri ? current.format : undefined) ??
    selected.detectedFormat ??
    'leaflet'
  );
}

/** Is there anything to apply — a different publication, or a different format? */
export function linkblogSelectionChanged(
  selected: LinkblogPublicationChoice | undefined,
  current: Pick<LinkblogPublication, 'uri' | 'format'>,
  format: LinkblogFormat
): boolean {
  if (!selected) return false;
  if (selected.uri !== current.uri) return true;
  // Format only matters for a connected publication; the Skyreader linkblog is
  // always written in its own format.
  return !selected.isDefault && format !== current.format;
}
