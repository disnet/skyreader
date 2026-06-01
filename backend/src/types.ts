// Re-export the global Env interface from worker-configuration.d.ts
export interface Env extends globalThis.Env {
  // Set to 'true' only in `.dev.vars` for local/CI e2e runs; gates the test-only
  // D1 exec endpoint (see routes/test-utils.ts). Never set in production.
  E2E_TEST_MODE?: string;
}

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
