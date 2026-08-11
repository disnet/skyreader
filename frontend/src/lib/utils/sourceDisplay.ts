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
// URI alone can't identify it. Every linkblog subscription — minted in-app from
// discovery, or by the Subscribe button on the public site — carries the author's
// Skyreader linkblog page as its siteUrl, and the backend persists it, so it
// survives to other devices. That page is always `<linkblog origin>/<did>/`: the
// DID-keyed path is the shape-level tell, which also holds on the dev/staging
// origins (matching hostnames alone both missed those and matched unrelated
// third-party hosts named `linkblogs.*`).
//
// The WHOLE path has to be that shape — a bare "contains a DID" test would pill
// any publication whose home app happens to key pages by DID as a linkblog, and
// siteUrl is client-supplied on create.
const LINKBLOG_PAGE_PATH = /^\/(blogs\/)?did:[a-z]+:[a-zA-Z0-9._:%-]+\/?$/;

function isLinkblogSiteUrl(siteUrl?: string): boolean {
  if (!siteUrl) return false;
  try {
    const { hostname, pathname } = new URL(siteUrl);
    if (hostname === 'linkblogs.skyreader.app') return true;
    // /<did:method:id>/ — the canonical linkblog page path (the legacy
    // `/blogs/<did>/` form, still redirected, matches too).
    return LINKBLOG_PAGE_PATH.test(pathname);
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
