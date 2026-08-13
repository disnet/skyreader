// Helpers for describing where a user's shared links go. The target is either
// the Skyreader linkblog or a standard.site publication the user already owns,
// which the Settings picker has to describe well enough to choose between (and
// whose content format has to follow the publication, not the previous
// selection) — and which the share confirmation has to name correctly.

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

/** The address as a person reads it: no scheme, no trailing slash. */
export function publicationAddress(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '') || undefined;
}

/** How many posts a publication already holds, phrased for a metadata line. */
export function publicationPostCount(posts: number | undefined): string {
  if (!posts) return 'No posts yet';
  return posts === 1 ? '1 post' : `${posts} posts`;
}

/**
 * Can links actually be published here? The backend marks a publication
 * unsupported when its app ignores records other apps wrote (pckt), so the post
 * would exist in the user's repo and show up nowhere. Absent means supported —
 * an older backend that doesn't send the flag keeps its old behavior.
 */
export function publicationConnectable(
  choice: Pick<LinkblogPublicationChoice, 'supported'> | undefined
): boolean {
  return choice?.supported !== false;
}

/** Is this publication's format settled by the app that owns it? */
export function linkblogFormatLocked(
  selected: LinkblogPublicationChoice | undefined
): selected is LinkblogPublicationChoice & { detectedFormat: LinkblogFormat } {
  return !!selected?.formatLocked && !!selected.detectedFormat;
}

/**
 * Which content format to write to the selected publication, strongest signal
 * first: the format its app locks it to (Leaflet, pckt and Offprint each read
 * only their own blocks, so there's nothing to choose), an explicit choice the
 * user made for it, the format already in use if it's the live target, the
 * format detected from its existing posts, and finally leaflet — the format
 * every standard.site reader in the app renders.
 */
export function resolveLinkblogFormat(
  selected: LinkblogPublicationChoice | undefined,
  current: Pick<LinkblogPublication, 'uri' | 'format'>,
  overrides: Record<string, LinkblogFormat>
): LinkblogFormat {
  if (!selected) return current.format;
  if (linkblogFormatLocked(selected)) return selected.detectedFormat;
  return (
    overrides[selected.uri] ??
    (selected.uri === current.uri ? current.format : undefined) ??
    selected.detectedFormat ??
    'leaflet'
  );
}

/**
 * Where a share is about to land, for the "this is public" confirmation. Once a
 * user connects a publication, that publication — not the Skyreader linkblog —
 * is what a new share is written to, so the warning has to name it and link its
 * own page. The Skyreader linkblog page still renders those posts, so it rides
 * along as a secondary mention rather than the headline address.
 */
export interface ShareDestination {
  /** Where the share lands, named the way the user would name it. */
  name: string;
  /** True when links go to a publication the user connected. */
  external: boolean;
  /** The destination's own public page, when it has a usable one. */
  url?: string;
  /** `url`, trimmed for display. */
  address?: string;
  /** The Skyreader linkblog page — only set when it isn't the destination itself. */
  linkblogUrl?: string;
}

export function shareDestination(
  publication: Pick<LinkblogPublication, 'name' | 'external' | 'externalUrl'> | null | undefined,
  linkblogUrl: string | null | undefined
): ShareDestination {
  const linkblog = linkblogUrl ?? undefined;
  // Not connected (or not loaded yet): the Skyreader linkblog is the destination.
  if (!publication?.external) {
    return {
      name: 'your public linkblog',
      external: false,
      url: linkblog,
      address: publicationAddress(linkblog),
    };
  }
  return {
    name: publication.name || 'the publication you connected',
    external: true,
    url: publication.externalUrl,
    address: publicationAddress(publication.externalUrl),
    linkblogUrl: linkblog,
  };
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
