// Re-export the global Env interface from worker-configuration.d.ts
export interface Env extends globalThis.Env {
  // Set to 'true' only in `.dev.vars` for local/CI e2e runs; gates the test-only
  // D1 exec endpoint (see routes/test-utils.ts). Never set in production, so the
  // value is checked (`=== 'true'`) rather than trusted to exist.
  //
  // Typed as a required `string` — not `string | undefined` — to match what
  // `wrangler types` emits. When `.dev.vars` defines E2E_TEST_MODE, the generated
  // globalThis.Env declares it `string`, and an extending interface can't widen
  // a required property to optional (TS2430). Declaring it here covers the case
  // where the generated types were produced without the var present.
  E2E_TEST_MODE: string;
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
  // Stamped by the authed batch fetch handler (feeds-v2.ts) from a per-user read
  // join. Not a stored feed field — only present on annotated responses.
  read?: boolean;
  // Set at ingest when `content` exceeded the stored-content cap and was dropped
  // (routes/ingest.ts). The reader falls back to /extract for the full text.
  contentTruncated?: boolean;
}

export interface ParsedFeed {
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  items: FeedItem[];
  fetchedAt: number;
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
