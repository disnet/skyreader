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

// A linkblog connected to an existing publication has an arbitrary rkey, so the
// URI alone can't identify it. Those subscriptions are minted by linkblog
// discovery with the author's Skyreader linkblog page as their siteUrl — that
// origin is the reliable tell.
function isLinkblogSiteUrl(siteUrl?: string): boolean {
  if (!siteUrl) return false;
  try {
    return /(^|\.)linkblogs\./i.test(new URL(siteUrl).hostname);
  } catch {
    return false;
  }
}

export function isLinkblogPublication(feedUrl?: string, siteUrl?: string): boolean {
  return (!!feedUrl && feedUrl.endsWith(LINKBLOG_PUB_SUFFIX)) || isLinkblogSiteUrl(siteUrl);
}

export function getSourceDisplay(
  sourceType: SubscriptionSourceType | undefined,
  feedUrl?: string,
  siteUrl?: string
): SourceDisplayInfo {
  switch (sourceType) {
    case 'atproto.documents':
      if (feedUrl) {
        if (isLinkblogPublication(feedUrl, siteUrl)) {
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
