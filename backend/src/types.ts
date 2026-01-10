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
}

export interface OAuthState {
  codeVerifier: string;
  did: string;
  handle: string;
  pdsUrl: string;
  authServer: string;
  returnUrl?: string;
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
  itemUrl: string;
  itemTitle?: string;
  itemAuthor?: string;
  itemDescription?: string;
  itemImage?: string;
  note?: string;
  tags?: string[];
  indexedAt: number;
  createdAt: number;
}

export interface ShareWithAuthor extends Share {
  authorHandle: string;
  authorDisplayName?: string;
  authorAvatar?: string;
}
