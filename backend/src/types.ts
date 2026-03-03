// Re-export the global Env interface from worker-configuration.d.ts
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Env extends globalThis.Env {}

export interface User {
  did: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  pdsUrl: string;
}

export interface Session {
  did: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  pdsUrl: string;
  accessToken: string;
  refreshToken: string;
  dpopPrivateKey: string;
  expiresAt: number;
  grantedScopes?: string;
}

export interface OAuthState {
  codeVerifier: string;
  did: string;
  handle: string;
  pdsUrl: string;
  authServer: string;
  returnUrl?: string;
  frontendUrl: string;
  cliPort?: number;
}

export interface FeedItem {
  guid: string;
  url: string;
  title: string;
  author?: string;
  content?: string;
  summary?: string;
  imageUrl?: string;
  publishedAt: string;
}

export interface ParsedFeed {
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  items: FeedItem[];
  fetchedAt: number;
}

export interface Share {
  id: number;
  authorDid: string;
  recordUri: string;
  recordCid: string;
  feedUrl?: string;
  itemUrl: string;
  itemTitle?: string;
  itemAuthor?: string;
  itemDescription?: string;
  content?: string;
  itemImage?: string;
  itemGuid?: string;
  itemPublishedAt?: string;
  note?: string;
  tags?: string[];
  indexedAt: string;
  createdAt: string;
  reshareOf?: {
    uri: string;
    authorDid: string;
  };
  reshareCount: number;
}

export interface ShareWithAuthor extends Share {
  authorHandle: string;
  authorDisplayName?: string;
  authorAvatar?: string;
}

export interface Document {
  id: number;
  authorDid: string;
  recordUri: string;
  siteUri: string;
  title: string;
  publishedAt: string;
  path?: string;
  description?: string;
  coverImageCid?: string;
  textContent?: string;
  bskyPostUri?: string;
  tags?: string[];
  updatedAt?: string;
  canonicalUrl?: string;
  indexedAt: string;
  createdAt: string;
  siteIcon?: string;
}

export interface Publication {
  id: number;
  publicationUri: string;
  authorDid: string;
  baseUrl: string;
  name?: string;
  description?: string;
  cachedAt: number;
  expiresAt: number;
}
