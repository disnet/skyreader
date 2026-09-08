// Links into the user docs (docs.skyreader.app, from the docs-site/ package).
// Every in-app "Learn more" goes through this map so a renamed docs page is a
// one-line fix here, not a hunt through components. Keep these paths in step
// with docs-site/src/content/docs/ and its astro.config.mjs sidebar; docs-site
// prefers adding a redirect over breaking a slug.

import { browser } from '$app/environment';

export const docsPages = {
  home: '/',
  gettingStarted: '/getting-started/',
  addingSources: '/guide/adding-sources/',
  saveFromAnywhere: '/guide/adding-sources/#save-and-subscribe-from-anywhere',
  reading: '/guide/reading/',
  savingAndHighlights: '/guide/saving-and-highlights/',
  saveBacking: '/guide/saving-and-highlights/#backing-your-saves-with-semble-or-margin',
  highlights: '/guide/saving-and-highlights/#highlights',
  sharingAndLinkblog: '/guide/sharing-and-your-linkblog/',
  yourData: '/your-data/',
  atmosphericSync: '/your-data/#subscriptions-and-atmospheric-sync',
  supporter: '/supporter/',
  faq: '/faq/',
} as const;

export type DocsPage = keyof typeof docsPages;

// Docs origin for a given app hostname, mirroring linkblog-site's apiBaseFor
// convention: prod maps to its sibling subdomain, every other *.skyreader.app
// host is a staging flavor, and local dev points at the Astro dev server
// (docs-site runs on port 5176; 5175 belongs to linkblog-site).
export function docsOriginFor(hostname: string): string {
  if (hostname === 'skyreader.app') return 'https://docs.skyreader.app';
  if (hostname.endsWith('.skyreader.app')) return 'https://staging-docs.skyreader.app';
  if (hostname === '127.0.0.1' || hostname === 'localhost') return 'http://localhost:5176';
  return 'https://docs.skyreader.app';
}

export function docsUrl(page: DocsPage = 'home'): string {
  const origin = browser ? docsOriginFor(window.location.hostname) : 'https://docs.skyreader.app';
  return `${origin}${docsPages[page]}`;
}
