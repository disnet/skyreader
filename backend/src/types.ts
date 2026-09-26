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
  // The scope string this authorization requested.
  scope?: string;
  // Set by a permission upgrade: the session the new one replaces.
  replaceSessionId?: string;
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
  // Set at ingest when `content` exceeded the inline stored-content cap and was
  // dropped from the row (routes/ingest.ts). The reader fetches the stored body
  // (routes/item-bodies.ts), falling back to /extract for the full text.
  contentTruncated?: boolean;
  // Set alongside `contentTruncated` once the dropped body is in R2 under this
  // item's (feed_url, guid). Absent means no stored copy is known — the reader
  // still asks (a row cached before the flag existed may have been backfilled).
  bodyStored?: boolean;
  // The opening of a dropped body (≤ MAX_CONTENT_LEAD_BYTES, cut at a safe
  // boundary), kept in the row so the feed's collapsed card can preview the
  // article itself. Set only alongside `contentTruncated`; never the full body.
  contentLead?: string;
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
