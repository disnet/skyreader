// Shared helpers for the public linkblog pages (Phase 0).
//
// These run as Cloudflare Pages Functions on skyreader.app, so the public
// linkblog lives at the canonical URL the publication records point at:
// https://skyreader.app/blogs/<did>/ (with /blogs/<handle>/ as a redirecting
// alias). Everything here is self-contained — Pages Functions are bundled
// separately from the SvelteKit app and can't import the backend service layer.

export const PUBLICATION_COLLECTION = 'site.standard.publication';
export const DOCUMENT_COLLECTION = 'site.standard.document';

// The dedicated, one-per-user linkblog publication (see LINKBLOG_PLAN.md).
export const LINKBLOG_RKEY = 'skyreader-links';

export interface BlogEnv {
  FEED_PROXY_URL: string;
  FEED_PROXY_SECRET?: string;
}

// The Pages Functions invocation context, typed just enough for our handlers.
// (We avoid depending on @cloudflare/workers-types, which isn't installed.)
export interface BlogContext {
  request: Request;
  env: BlogEnv;
  params: Record<string, string | string[]>;
}

// Subset of the proxy's ProxyDocument we render. For a linkblog "link post" the
// user's commentary lives in `content` (a pub.leaflet text block) and the shared
// article's URL in `links` — `description`/`textContent` hold the article excerpt,
// not the note. We surface both so the page renders the note + links to the
// external article (not the linkblog permalink).
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

export function isDid(value: string): boolean {
  return value.startsWith('did:');
}

export function publicationUri(did: string): string {
  return `at://${did}/${PUBLICATION_COLLECTION}/${LINKBLOG_RKEY}`;
}

// Derive the document rkey from its AT URI (at://did/collection/rkey).
export function rkeyFromUri(uri: string): string | null {
  const parts = uri.replace(/^at:\/\//, '').split('/');
  return parts.length >= 3 ? parts.slice(2).join('/') : null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Identity resolution ──────────────────────────────────────────────────────

// Resolve a handle to a DID via the Bluesky public AppView. Returns null if it
// can't be resolved (we don't fall back to DNS/well-known here — a public page
// loader should stay fast and the AppView covers the overwhelming majority).
export async function resolveHandleToDid(handle: string): Promise<string | null> {
  const normalized = handle.trim().replace(/^@/, '').toLowerCase();
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(normalized)}`
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { did?: string };
    return data.did ?? null;
  } catch {
    return null;
  }
}

// Fetch a profile (display name, handle, avatar) from the Bluesky AppView. Used
// for the page header and as the source of the default linkblog name/icon.
export async function getProfile(actor: string): Promise<Profile | null> {
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      did: string;
      handle?: string;
      displayName?: string;
      avatar?: string;
      description?: string;
    };
    return {
      did: data.did,
      handle: data.handle,
      displayName: data.displayName,
      avatar: data.avatar,
      description: data.description,
    };
  } catch {
    return null;
  }
}

// ── Publication metadata (best effort) ───────────────────────────────────────

interface DidDocService {
  id: string;
  type: string;
  serviceEndpoint: string;
}

async function resolvePdsUrl(did: string): Promise<string | null> {
  try {
    if (did.startsWith('did:plc:')) {
      const res = await fetch(`https://plc.directory/${did}`);
      if (!res.ok) return null;
      const doc = (await res.json()) as { service?: DidDocService[] };
      return pdsFromServices(doc.service);
    }
    if (did.startsWith('did:web:')) {
      const domain = did.slice('did:web:'.length).replace(/:/g, '/');
      const res = await fetch(`https://${domain}/.well-known/did.json`);
      if (!res.ok) return null;
      const doc = (await res.json()) as { service?: DidDocService[] };
      return pdsFromServices(doc.service);
    }
    return null;
  } catch {
    return null;
  }
}

function pdsFromServices(services: DidDocService[] | undefined): string | null {
  const pds = services?.find(
    (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
  );
  return pds?.serviceEndpoint ?? null;
}

// Read the user's linkblog publication record (if it exists yet) for a
// customized name/description/icon. Falls back silently — in Phase 0 the record
// usually won't exist, and the page renders fine from the profile defaults.
export async function fetchPublicationMeta(did: string): Promise<PublicationMeta | null> {
  const pdsUrl = await resolvePdsUrl(did);
  if (!pdsUrl) return null;
  try {
    const params = new URLSearchParams({
      repo: did,
      collection: PUBLICATION_COLLECTION,
      rkey: LINKBLOG_RKEY,
    });
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      value?: { name?: string; description?: string; icon?: { ref?: { $link?: string } } };
    };
    const value = data.value;
    if (!value) return null;
    const iconCid = value.icon?.ref?.$link;
    return {
      name: value.name,
      description: value.description,
      icon: iconCid ? `https://cdn.bsky.app/img/avatar/plain/${did}/${iconCid}@jpeg` : undefined,
    };
  } catch {
    return null;
  }
}

// ── Documents (via the feed proxy) ───────────────────────────────────────────

// Fetch the user's linkblog documents through the feed proxy, scoped to the
// dedicated skyreader-links publication. Returns newest-first (the proxy sorts);
// returns [] on any error so the page still renders.
export async function fetchLinkblogDocuments(env: BlogEnv, did: string): Promise<ProxyDocument[]> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (env.FEED_PROXY_SECRET) headers['X-Proxy-Secret'] = env.FEED_PROXY_SECRET;

    const res = await fetch(`${env.FEED_PROXY_URL}/documents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ authors: [{ did, siteUri: publicationUri(did) }] }),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      authors?: Array<{ documents?: ProxyDocument[]; status?: string }>;
    };
    return data.authors?.[0]?.documents ?? [];
  } catch {
    return [];
  }
}

// ── Link-post fields ─────────────────────────────────────────────────────────

interface LeafletTextBlock {
  $type?: string;
  plaintext?: string;
}
interface LeafletPage {
  blocks?: Array<{ block?: LeafletTextBlock }>;
}
interface LeafletContent {
  $type?: string;
  pages?: LeafletPage[];
}

// The user's commentary on a link post: the plaintext of the first
// `pub.leaflet.blocks.text` block (Skyreader writes the note as the leading text
// block, before the website card). Returns '' when there's no note — the document's
// `description`/`textContent` hold the article excerpt, not the note.
export function linkPostNote(doc: ProxyDocument): string {
  const content = doc.content as LeafletContent | undefined;
  if (content && content.$type === 'pub.leaflet.content') {
    for (const page of content.pages ?? []) {
      for (const wrapper of page.blocks ?? []) {
        if (wrapper.block?.$type === 'pub.leaflet.blocks.text') {
          const text = wrapper.block.plaintext?.trim();
          if (text) return text;
        }
      }
    }
  }
  return '';
}

// The external article a link post points at: the first http(s) `links` entry.
// (`at://` repost refs are quote-reshares — ignored here.) Returns undefined for a
// plain document, so callers fall back to the document's own canonical URL.
export function externalArticleUrl(doc: ProxyDocument): string | undefined {
  return doc.links?.find((l) => /^https?:\/\//i.test(l.uri))?.uri;
}

// ── Rendering ────────────────────────────────────────────────────────────────

// One Blue (#0066cc), system sans, true-white body, flat by default — per
// DESIGN.md. The page is reading-first: generous measure, quiet chrome.
const STYLES = `
  :root {
    --blue: #0066cc;
    --ink: #16181c;
    --muted: #6b7280;
    --faint: #9aa1ab;
    --line: #e6e8eb;
    --bg: #ffffff;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.55;
    font-size: 17px;
  }
  a { color: var(--blue); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 40rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
  .pubhead { display: flex; align-items: center; gap: 0.875rem; margin-bottom: 0.5rem; }
  .pubhead img { width: 48px; height: 48px; border-radius: 12px; object-fit: cover; flex: none; }
  .pubhead h1 { font-size: 1.5rem; line-height: 1.2; margin: 0; letter-spacing: -0.01em; }
  .byline { color: var(--muted); font-size: 0.9375rem; margin: 0; }
  .byline a { color: var(--muted); }
  .pubdesc { color: var(--ink); margin: 1rem 0 0; }
  .divider { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
  .entry { padding: 1.5rem 0; border-bottom: 1px solid var(--line); }
  .entry:last-child { border-bottom: 0; }
  .entry h2 { font-size: 1.1875rem; line-height: 1.3; margin: 0 0 0.375rem; letter-spacing: -0.005em; }
  .entry h2 a { color: var(--ink); }
  .entry h2 a:hover { color: var(--blue); }
  .entry p { margin: 0.375rem 0 0; color: var(--ink); }
  .meta { font-size: 0.8125rem; color: var(--faint); margin-top: 0.625rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .meta .src { color: var(--muted); }
  .empty { color: var(--muted); padding: 2.5rem 0; text-align: center; }
  .back { display: inline-block; font-size: 0.875rem; margin-bottom: 1.5rem; color: var(--muted); }
  .readmore { display: inline-block; margin-top: 1.25rem; font-weight: 500; }
  .foot { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--line); font-size: 0.8125rem; color: var(--faint); }
  .foot a { color: var(--faint); }
`;

export interface PageHead {
  title: string;
  description?: string;
  image?: string;
  url: string;
}

export function renderPage(head: PageHead, bodyHtml: string): string {
  const desc = head.description ? escapeHtml(head.description) : '';
  const ogImage = head.image
    ? `<meta property="og:image" content="${escapeHtml(head.image)}" />`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(head.title)}</title>
${desc ? `<meta name="description" content="${desc}" />` : ''}
<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeHtml(head.title)}" />
${desc ? `<meta property="og:description" content="${desc}" />` : ''}
<meta property="og:url" content="${escapeHtml(head.url)}" />
${ogImage}
<meta name="twitter:card" content="summary" />
<style>${STYLES}</style>
</head>
<body>
<main class="wrap">
${bodyHtml}
</main>
</body>
</html>`;
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export function blogTitle(profile: Profile | null, pub: PublicationMeta | null): string {
  if (pub?.name) return pub.name;
  const who = profile?.displayName || (profile?.handle ? `@${profile.handle}` : 'Someone');
  return `${who}'s links`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Allowlist http(s) before using a value as an href/src. These URLs originate
// from user-controlled PDS records (document/publication), so a `javascript:`
// (or `data:` etc.) scheme would otherwise survive HTML-escaping and execute on
// click. Returns the normalized URL, or null to omit the link/attribute.
export function safeHttpUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
