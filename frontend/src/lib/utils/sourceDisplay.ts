import type { SubscriptionSourceType } from '$lib/types';

export interface SourceDisplayInfo {
  label: string;
  iconName: string;
  pillClass: string;
}

// A Skyreader linkblog is a standard.site publication with this fixed rkey.
// Distinguishing it from a generic publication lets us label the two kinds of
// Atmosphere source apart (linkblog = curated links + notes; blog = writing).
export const LINKBLOG_PUB_SUFFIX = 'site.standard.publication/skyreader-links';

export function isLinkblogPublication(feedUrl?: string): boolean {
  return !!feedUrl && feedUrl.endsWith(LINKBLOG_PUB_SUFFIX);
}

export function getSourceDisplay(
  sourceType: SubscriptionSourceType | undefined,
  feedUrl?: string
): SourceDisplayInfo {
  switch (sourceType) {
    case 'atproto.documents':
      if (feedUrl) {
        if (isLinkblogPublication(feedUrl)) {
          return {
            label: 'Linkblog',
            iconName: 'link',
            pillClass: 'pill-linkblog',
          };
        }
        return {
          label: 'Blog',
          iconName: 'standard-site',
          pillClass: 'pill-publication',
        };
      }
      return {
        label: 'Documents',
        iconName: 'standard-site',
        pillClass: 'pill-documents',
      };
    case 'atproto.collection':
      return {
        label: 'Collection',
        iconName: 'folder',
        pillClass: 'pill-collection',
      };
    default:
      return { label: 'RSS', iconName: 'rss', pillClass: 'pill-rss' };
  }
}
