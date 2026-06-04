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
  // Backend API origin for the inline "Subscribe in the Atmosphere" button.
  // Optional — falls back to a hostname-derived default (see apiBaseFor).
  PUBLIC_API_URL?: string;
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

// Escape for XML text/attributes (RSS). Same five entities as HTML, but apos is
// spelled `&apos;` (the XML predefined name).
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Wrap HTML markup so it can live inside an RSS <description> verbatim (readers
// render the HTML). CDATA keeps the angle brackets literal; we only have to guard
// the one sequence that would close the section early.
export function cdata(html: string): string {
  return `<![CDATA[${html.replace(/]]>/g, ']]&gt;')}]]>`;
}

// RFC-822 date for RSS <pubDate>/<lastBuildDate>. Empty for an unparseable input.
export function toRfc822(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toUTCString();
}

// Canonical RSS feed URL for a linkblog (the DID form, mirroring the permalink
// encoding). Also the href used for feed autodiscovery on the HTML pages.
export function feedUrlFor(origin: string, did: string): string {
  return `${origin}/blogs/${encodeURIComponent(did)}/feed.xml`;
}

// Backend API origin for the inline subscribe button. Prefer an explicit env
// override; otherwise derive from the page host (prod/staging map to their
// api.* subdomain; local dev returns '' so the fetch is relative and rides the
// Vite /api proxy).
export function apiBaseFor(origin: string, env: BlogEnv): string {
  if (env.PUBLIC_API_URL) return env.PUBLIC_API_URL.replace(/\/+$/, '');
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch {
    return '';
  }
  if (host === 'skyreader.app') return 'https://api.skyreader.app';
  if (host.endsWith('.skyreader.app')) return 'https://api-staging.skyreader.app';
  return '';
}

// The inline "Subscribe in the Atmosphere" behavior for the public page. Vanilla
// JS (the page has no framework): on click it writes/removes the user's portable
// site.standard.graph.subscription via the backend, redirecting to login first if
// the visitor isn't authenticated (and resuming via ?subscribe=1 on return). The
// CSP middleware injects a nonce into this <script>, so it runs under
// strict-dynamic. apiBase/publication are server-trusted, but we still JSON-encode
// and neutralize `<` defensively.
//
// On load we reflect the visitor's existing subscription state, but ONLY when
// they're signed into Skyreader in this browser — the app persists a
// 'skyreader-auth' marker in localStorage, which is same-origin with this page.
// Gating on it keeps us from firing a credentialed request (and logging a 401)
// for every anonymous viewer of a public page. The probe is passive: a stale
// session just 401s and we leave the button idle (never a redirect to login —
// only an explicit click does that). The POST is idempotent, so a re-subscribe is
// harmless.
export function renderSubscribeScript(apiBase: string, publicationUri: string): string {
  const cfg = JSON.stringify({ apiBase, publication: publicationUri }).replace(/</g, '\\u003c');
  return `<script>(function(){
  var cfg = ${cfg};
  var btn = document.getElementById('atmo-sub');
  if (!btn) return;
  var openLink = document.getElementById('atmo-open');
  // The visible label stays "Atmosphere" (consistent with the "RSS" option) —
  // state is conveyed by the icon swap, the dimming, and the title.
  var titles = { idle: 'Subscribe in the Atmosphere', busy: 'Working\\u2026', subscribed: 'Subscribed \\u2014 click to remove' };
  function set(s){
    btn.dataset.state = s;
    btn.title = titles[s] || titles.idle;
    if (openLink) openLink.classList.toggle('show', s === 'subscribed');
  }
  function call(method){
    return fetch(cfg.apiBase + '/api/atmosphere/subscription', {
      method: method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publication: cfg.publication })
    });
  }
  function login(){ location.href = '/auth/login?returnUrl=' + encodeURIComponent(location.pathname + '?subscribe=1'); }
  function write(method, ok){
    set('busy');
    call(method).then(function(res){
      if (res.status === 401 || res.status === 403) { login(); return; }
      if (!res.ok) throw new Error('failed');
      set(ok);
    }).catch(function(){ set(method === 'POST' ? 'idle' : 'subscribed'); });
  }
  btn.addEventListener('click', function(e){
    e.preventDefault();
    var s = btn.dataset.state;
    if (s === 'busy') return;
    if (s === 'subscribed') write('DELETE', 'idle');
    else write('POST', 'subscribed');
  });
  // Reflect existing state on load — only for a signed-in visitor (see note above).
  // No 'busy' flash: we stay idle and flip to 'subscribed' only on a confirmed yes,
  // so the common anonymous/unsubscribed case never flickers.
  function probe(){
    var authed = false;
    try { authed = !!localStorage.getItem('skyreader-auth'); } catch(e){}
    if (!authed) return;
    fetch(cfg.apiBase + '/api/atmosphere/subscription?publication=' + encodeURIComponent(cfg.publication), {
      credentials: 'include'
    }).then(function(res){ return res.ok ? res.json() : null; })
      .then(function(data){ if (data && data.subscribed) set('subscribed'); })
      .catch(function(){});
  }
  // Resume an intent that bounced through login.
  var sp = new URLSearchParams(location.search);
  if (sp.get('subscribe') === '1') {
    sp.delete('subscribe');
    var qs = sp.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    write('POST', 'subscribed');
  } else {
    probe();
  }
})();</script>`;
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
      value?: {
        name?: string;
        description?: string;
        icon?: { ref?: { $link?: string } };
      };
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
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (env.FEED_PROXY_SECRET) headers['X-Proxy-Secret'] = env.FEED_PROXY_SECRET;

    const res = await fetch(`${env.FEED_PROXY_URL}/documents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        authors: [{ did, siteUri: publicationUri(did) }],
      }),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      authors?: Array<{ documents?: ProxyDocument[]; status?: string }>;
    };
    const docs = data.authors?.[0]?.documents ?? [];
    // A linkblog reads newest-shared-first. Order by when each link was shared
    // (the record's `createdAt`), not by the article's own publish date — the
    // proxy sorts its generic document feed by `publishedAt`, which would float
    // an old article shared today to the wrong place.
    docs.sort(
      (a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0)
    );
    return docs;
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

// A snippet of the shared article itself (its first paragraph or so), stored at
// share time as the document's `description`. This is the article's words — quote
// it as the article, distinct from the user's note. Empty for documents with no
// stored excerpt.
export function articleExcerpt(doc: ProxyDocument): string {
  return (doc.description || '').trim();
}

// Truncate to a max length on a word-ish boundary, preserving any newlines within
// the kept slice (callers render notes with white-space: pre-wrap).
export function clampText(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

// The external article a link post points at: the first http(s) `links` entry.
// (`at://` repost refs are quote-reshares — ignored here.) Returns undefined for a
// plain document, so callers fall back to the document's own canonical URL.
export function externalArticleUrl(doc: ProxyDocument): string | undefined {
  return doc.links?.find((l) => /^https?:\/\//i.test(l.uri))?.uri;
}

// ── Social context (Constellation, via the feed proxy) ───────────────────────

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

// Batch-fetch Constellation social context for link posts via the proxy. Keyed by
// each item's `key` (we use the document's record URI). Best-effort: returns an
// empty map on any error so the page still renders. Pass `articleUrl` to also
// surface "who else linked this" (heavier — it fetches each linker's note); omit
// it for a counts-only lookup (used on the index to keep SSR fast).
export async function fetchSocialContext(
  env: BlogEnv,
  items: Array<{
    key: string;
    docUri?: string;
    articleUrl?: string;
    excludeDid?: string;
  }>
): Promise<Map<string, SocialContext>> {
  const out = new Map<string, SocialContext>();
  if (items.length === 0) return out;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (env.FEED_PROXY_SECRET) headers['X-Proxy-Secret'] = env.FEED_PROXY_SECRET;

    const res = await fetch(`${env.FEED_PROXY_URL}/social-context`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ items: items.slice(0, 25) }),
    });
    if (!res.ok) return out;

    const data = (await res.json()) as { items?: SocialContext[] };
    for (const ctx of data.items ?? []) {
      if (ctx?.key) out.set(ctx.key, ctx);
    }
    return out;
  } catch {
    return out;
  }
}

// A quiet "3 recommends · 1 quote" fragment for the entry meta row. Returns '' when
// there's nothing to show.
export function renderSocialCounts(ctx: SocialContext | undefined): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.recommendCount > 0) {
    parts.push(`${ctx.recommendCount} ${ctx.recommendCount === 1 ? 'recommend' : 'recommends'}`);
  }
  if (ctx.quoteCount > 0) {
    parts.push(`${ctx.quoteCount} ${ctx.quoteCount === 1 ? 'quote' : 'quotes'}`);
  }
  if (parts.length === 0) return '';
  return `<span class="social">${escapeHtml(parts.join(' · '))}</span>`;
}

// The "Also linked by @alice, @bob …" block (with notes) for the permalink page.
// Handles link to the linker's Bluesky profile. Returns '' when nobody else has
// linked the article.
export function renderAlsoLinkedBy(ctx: SocialContext | undefined): string {
  if (!ctx || ctx.alsoLinkedBy.length === 0) return '';
  const items = ctx.alsoLinkedBy
    .map((e) => {
      const label = e.handle ? `@${escapeHtml(e.handle)}` : escapeHtml(e.did.slice(0, 16));
      const who = e.handle
        ? `<a href="https://bsky.app/profile/${escapeHtml(e.handle)}">${label}</a>`
        : label;
      const note = e.note ? ` <span class="alsonote">“${escapeHtml(e.note)}”</span>` : '';
      return `<li>${who}${note}</li>`;
    })
    .join('');
  return `<div class="alsolinked">
  <span class="alsolabel">Also linked</span>
  <ul>${items}</ul>
</div>`;
}

// ── Rendering ────────────────────────────────────────────────────────────────

// One Blue (#0066cc), system sans, true-white body, flat by default — per
// DESIGN.md. The page is reading-first: generous measure, quiet chrome, and a
// hairline-and-whitespace rhythm rather than cards. Light + dark both clear the
// 4.5:1 contrast bar independently (PRODUCT.md): muted text never drifts into the
// decorative light gray that the old --faint token used. The interaction blue
// lightens in dark mode — the only documented tint of the One Blue — so links
// stay legible on the dark surface.
const STYLES = `
  :root {
    --blue: #0066cc;
    --ink: #1a1d21;
    --ink-soft: #3c424b;
    --muted: #5c636e;
    --line: #e6e8eb;
    --line-soft: #eef0f2;
    --bg: #ffffff;
    --quote-bg: #f5f6f8;
    --tint: rgba(0, 102, 204, 0.055);
    --tint-strong: rgba(0, 102, 204, 0.14);
    --icon-ring: rgba(0, 0, 0, 0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --blue: #5aa3f0;
      --ink: #e7e9ec;
      --ink-soft: #c2c7ce;
      --muted: #9aa1ab;
      --line: #2a2e35;
      --line-soft: #23272d;
      --bg: #16181c;
      --quote-bg: #1d2025;
      --tint: rgba(90, 163, 240, 0.10);
      --tint-strong: rgba(90, 163, 240, 0.22);
      --icon-ring: rgba(255, 255, 255, 0.08);
    }
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
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  ::selection { background: var(--tint-strong); }
  a { color: var(--blue); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; border-radius: 3px; text-decoration: none; }
  img { max-width: 100%; }
  .wrap { max-width: 40rem; margin: 0 auto; padding: 3.5rem 1.25rem 5rem; }

  /* Masthead */
  .pubhead { display: flex; align-items: center; gap: 1rem; }
  .pubicon { width: 52px; height: 52px; border-radius: 14px; object-fit: cover; flex: none; box-shadow: inset 0 0 0 1px var(--icon-ring); background: var(--line-soft); }
  .pubmeta { min-width: 0; }
  /* Subscribe affordances — a quiet "Subscribe via:" label over the two options
     (Atmosphere, RSS), as a tidy left-aligned mini-column pinned to the
     masthead's trailing edge. Flat-by-default; the options are the One Blue. */
  .pubactions { margin-left: auto; align-self: flex-start; flex: none; display: flex; flex-direction: column; align-items: flex-start; gap: 0.25rem; font-size: 0.8125rem; }
  .pubactions-label { color: var(--muted); }
  .sub-link { display: inline-flex; align-items: center; gap: 0.375rem; color: var(--blue); font-weight: 600; }
  .sub-link:hover { text-decoration: none; opacity: 0.82; }
  .sub-link svg { width: 15px; height: 15px; display: block; }
  /* The Atmosphere option is a <button> (it subscribes inline) — strip the chrome
     so it reads as the same quiet link as RSS. Only reset the font family (NOT the
     size: a font shorthand reset would override .sub-link and render at body size). */
  .sub-action { background: none; border: 0; padding: 0; margin: 0; font-family: inherit; font-size: inherit; line-height: inherit; cursor: pointer; }
  .sub-action .ico-check { display: none; }
  .sub-action[data-state="subscribed"] .ico-follow { display: none; }
  .sub-action[data-state="subscribed"] .ico-check { display: block; }
  .sub-action[data-state="busy"] { opacity: 0.55; cursor: default; }
  /* Revealed (toggled to .show) once subscribed. Kept in flow but visibility-hidden
     so revealing it doesn't reflow the masthead (no layout shift). */
  .open-app { display: inline-flex; align-items: center; gap: 0.375rem; color: var(--muted); font-weight: 500; visibility: hidden; }
  .open-app.show { visibility: visible; }
  .open-app:hover { color: var(--blue); text-decoration: none; }
  .open-app svg { width: 15px; height: 15px; display: block; }
  .pubhead h1 { font-size: 1.625rem; line-height: 1.18; margin: 0; letter-spacing: -0.022em; font-weight: 700; text-wrap: balance; }
  .byline { color: var(--muted); font-size: 0.9375rem; margin: 0.25rem 0 0; }
  .byline a { color: var(--muted); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: var(--line); }
  .byline a:hover { color: var(--ink); text-decoration-color: currentColor; }
  .pubdesc { color: var(--ink-soft); margin: 1.125rem 0 0; font-size: 1.0625rem; line-height: 1.55; text-wrap: pretty; }
  .divider { border: 0; border-top: 1px solid var(--line); margin: 2rem 0 0.5rem; }

  /* Entry list (link-post shelf) */
  .entries { list-style: none; margin: 0; padding: 0; }
  /* No dividers between entries — whitespace alone separates them. */
  .entry { position: relative; padding: 1.5rem 1rem; margin: 0 -1rem; transition: background 0.18s ease; }
  .entry:hover { background: var(--tint); }
  .entry-title { font-size: 1.1875rem; line-height: 1.32; margin: 0; letter-spacing: -0.012em; font-weight: 600; text-wrap: balance; }
  .entry-title a { color: var(--ink); }
  .entry-title a::after { content: ""; position: absolute; inset: 0; }
  .entry:hover .entry-title a { color: var(--blue); }
  .entry-title a:focus-visible { outline: none; }
  .entry:has(.entry-title a:focus-visible) { outline: 2px solid var(--blue); outline-offset: 2px; }
  /* The user's note — their own words. Plain text, so newlines are preserved. */
  .entry-note { margin: 0.5rem 0 0; color: var(--ink); white-space: pre-wrap; overflow-wrap: break-word; }
  /* A snippet quoted FROM the article (not the user). The recessed surface and the
     opening quotation mark mark it as a quotation; a side-stripe accent border is
     deliberately avoided per the design system. */
  .entry-quote { position: relative; margin: 0.75rem 0 0; padding: 0.625rem 0.875rem 0.625rem 2rem; background: var(--quote-bg); border-radius: 10px; color: var(--ink-soft); font-size: 0.9375rem; line-height: 1.55; }
  .entry-quote::before { content: "\\201C"; position: absolute; left: 0.6rem; top: 0.35rem; font-size: 1.5rem; line-height: 1; color: var(--muted); }
  .entry-quote p { margin: 0; }
  .meta { font-size: 0.8125rem; color: var(--muted); margin-top: 0.75rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .meta .src { color: var(--ink-soft); font-weight: 500; }
  .meta .sep { color: var(--line); }
  .meta .social { color: var(--muted); }

  /* Permalink entry */
  .back { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.875rem; margin-bottom: 1.75rem; color: var(--muted); }
  .back:hover { color: var(--ink); text-decoration: none; }
  .entry-page { }
  .entry-page .entry-title-lg { font-size: 1.625rem; line-height: 1.22; margin: 0 0 0.625rem; letter-spacing: -0.02em; font-weight: 700; text-wrap: balance; }
  .entry-page .entry-note-lg { margin: 1.375rem 0 0; font-size: 1.0625rem; line-height: 1.6; color: var(--ink); white-space: pre-wrap; overflow-wrap: break-word; }
  .entry-page .entry-quote { margin: 1.375rem 0 0; }
  .readmore { display: inline-flex; align-items: center; gap: 0.4rem; margin-top: 1.625rem; font-weight: 600; }
  .readmore .arrow { transition: transform 0.18s ease; }
  .readmore:hover { text-decoration: none; }
  .readmore:hover .arrow { transform: translateX(3px); }

  /* Also-linked-by */
  .alsolinked { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid var(--line); font-size: 0.9375rem; }
  .alsolabel { display: block; color: var(--muted); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; margin-bottom: 0.75rem; }
  .alsolinked ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .alsolinked li { color: var(--ink); }
  .alsonote { color: var(--muted); }

  /* Empty + footer */
  .empty { padding: 3rem 0; text-align: center; }
  .empty-title { color: var(--ink); font-weight: 600; margin: 0; font-size: 1.0625rem; }
  .empty-sub { color: var(--muted); margin: 0.375rem 0 0; }
  .foot { margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--line); font-size: 0.8125rem; color: var(--muted); }
  .foot a { color: var(--muted); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: var(--line); }
  .foot a:hover { color: var(--ink); text-decoration-color: currentColor; }

  @media (max-width: 30rem) {
    .wrap { padding: 2.25rem 1.125rem 4rem; }
    .pubhead h1 { font-size: 1.4375rem; }
  }

  @media (prefers-reduced-motion: no-preference) {
    body { animation: pagein 0.42s cubic-bezier(0.22, 1, 0.36, 1) both; }
    @keyframes pagein { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  }
`;

export interface PageHead {
  title: string;
  description?: string;
  image?: string;
  url: string;
  // When set, emits an RSS autodiscovery <link> so browsers/readers find the feed.
  feedUrl?: string;
}

export function renderPage(head: PageHead, bodyHtml: string): string {
  const desc = head.description ? escapeHtml(head.description) : '';
  const ogImage = head.image
    ? `<meta property="og:image" content="${escapeHtml(head.image)}" />`
    : '';
  const feedLink = head.feedUrl
    ? `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(head.title)}" href="${escapeHtml(head.feedUrl)}" />`
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
${feedLink}
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

export function rssResponse(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      // Short edge cache — a linkblog updates rarely, and readers poll often.
      'Cache-Control': 'public, max-age=300',
    },
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
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
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
