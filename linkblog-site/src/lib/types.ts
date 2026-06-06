// Shared types for the public linkblog. A linkblog "link post" stores the user's
// commentary in `content` (a pub.leaflet text block) and the shared article's URL
// in `links`; `description`/`textContent` hold the article excerpt, not the note.

export interface ProxyDocument {
  authorDid: string;
  recordUri: string;
  siteUri: string;
  title: string;
  publishedAt: string;
  path?: string;
  description?: string;
  textContent?: string;
  canonicalUrl?: string;
  createdAt: string;
  siteIcon?: string;
  links?: Array<{ uri: string; rel?: string }>;
  content?: unknown;
}

export interface Profile {
  did: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
  description?: string;
}

export interface PublicationMeta {
  name?: string;
  description?: string;
  icon?: string;
}

export interface AlsoLinkedEntry {
  did: string;
  handle: string | null;
  note: string | null;
  recordUri: string;
}

export interface SocialContext {
  key: string;
  recommendCount: number;
  quoteCount: number;
  alsoLinkedBy: AlsoLinkedEntry[];
}
