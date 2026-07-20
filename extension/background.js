// Skyreader — save a page or subscribe to its feeds.
//
// The toolbar button opens a popup (popup.html) offering two actions for the
// current tab: save the page to your reading list, or subscribe to a feed it
// advertises (RSS/Atom or a standard.site publication). The context menu still
// offers one-click saves for a link or the page.
//
// This service worker holds all the logic — auth, extraction, the save/subscribe
// API calls, and feed discovery — and the popup drives it over chrome.runtime
// messages (see the onMessage router at the bottom). Keeping fetches here means
// one place owns the session cookie and the retry/auth handling.
//
// The save flow mirrors the frontend's saveFromUrl
// (frontend/src/lib/stores/saves.svelte.ts): generate a TID rkey, extract
// content, then create the save via POST /api/saved. Extraction is live-DOM
// first: for page saves we inject the bundled Defuddle content script
// (content/extract.js) and read the article out of the tab the user is looking
// at — which sees paywalled and JS-rendered content the server-side extractor
// can't. POST /api/extract is the fallback (and the only path for link saves,
// where the page isn't open). A save that hits an existing item carries
// updateContent: true, so richer live content upgrades what the server stored.
//
// The subscribe flow mirrors AddFeedModal (frontend): GET /api/v2/feeds/discover
// resolves the page to RSS feed URLs and (backend-verified) standard.site
// publications; POST /api/subscriptions creates the subscription. Discovery is
// also live-DOM first — we scan the tab's <link rel="alternate"> tags and merge
// them with the backend result, catching feeds on JS-rendered pages the cold
// server fetch misses.
//
// Auth rides on the browser's existing skyreader.app session cookie
// (Domain=.skyreader.app covers api.skyreader.app; the host_permission exempts
// extension-initiated fetches from SameSite and CORS). When the user isn't
// logged in, we fall back to opening the frontend's /save?url= page, which
// handles login and resumes the save.

const DEFAULTS = {
  apiBase: 'https://api.skyreader.app',
  frontendBase: 'https://skyreader.app',
};

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// --- TID generation (mirrors frontend/src/lib/utils/tid.ts) ---------------
// Backends validate rkeys against /^[a-z0-9]{13,}$/. Base36 millisecond
// timestamp + fixed-length random suffix.
const RANDOM_CHARS = 10;

function generateTid() {
  const timestamp = Date.now().toString(36);
  let random = '';
  for (let i = 0; i < RANDOM_CHARS; i++) {
    random += Math.floor(Math.random() * 36).toString(36);
  }
  return timestamp + random;
}

// --- Badge feedback --------------------------------------------------------
// Used by the context-menu save entry points, where there's no popup to show
// status inline.

const BADGE_BLUE = '#0066cc'; // One Blue (DESIGN.md)
const BADGE_RED = '#f44336'; // Error (DESIGN.md)

function setBadge(tabId, text, color, title) {
  if (tabId == null) return;
  // Tab may have closed mid-save; badge calls on a dead tab throw.
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(() => {});
  if (title) chrome.action.setTitle({ tabId, title }).catch(() => {});
}

function flashBadge(tabId, text, color, title) {
  setBadge(tabId, text, color, title);
  setTimeout(() => {
    if (tabId == null) return;
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    chrome.action.setTitle({ tabId, title: 'Skyreader' }).catch(() => {});
  }, 4000);
}

// --- Fetch helpers ----------------------------------------------------------

class UnauthorizedError extends Error {}

async function apiFetch(cfg, path, body) {
  return fetch(`${cfg.apiBase}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function apiGet(cfg, path) {
  return fetch(`${cfg.apiBase}${path}`, { method: 'GET', credentials: 'include' });
}

// One retry for the backend's mid-token-refresh 503 (session_refresh_pending).
async function apiFetchWithRetry(cfg, path, body) {
  const res = await apiFetch(cfg, path, body);
  if (res.status === 503) {
    const data = await res.json().catch(() => null);
    if (data?.error === 'session_refresh_pending') {
      await new Promise((r) => setTimeout(r, 2000));
      return apiFetch(cfg, path, body);
    }
  }
  return res;
}

// --- Extraction -------------------------------------------------------------

// Run Defuddle inside the tab's live DOM. Two-step injection: the bundle
// defines globalThis.__skyreaderExtract in the isolated world, then a func
// call reads its result back. Returns null when the page can't be scripted
// (chrome://, PDF viewer, Web Store) or extraction yields no body.
async function extractFromTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/extract.js'],
    });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__skyreaderExtract?.(),
    });
    if (!result || result.error || !result.content) return null;
    return result;
  } catch {
    return null;
  }
}

// Server-side extraction fallback (feed-proxy → Defuddle over a cold fetch).
// Returns null on failure; a 401 is surfaced so the caller can route to login.
async function extractViaBackend(cfg, url) {
  const res = await apiFetchWithRetry(cfg, '/api/extract', { url });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) return null;
  return res.json();
}

// --- Save flow --------------------------------------------------------------

function isHttpUrl(raw) {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function wordCountFrom(html) {
  if (!html) return 0;
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.split(' ').length : 0;
}

// Open the frontend's /save page, which handles login-then-resume and shows
// proper UI for limit/scope errors.
function openSavePage(cfg, url) {
  chrome.tabs.create({
    url: `${cfg.frontendBase}/save?url=${encodeURIComponent(url)}`,
  });
}

// Save `url` and return a structured result — the popup renders it inline and
// the context-menu wrapper (saveWithBadge) translates it to a badge. `extractTabId`
// marks a tab whose live DOM IS that URL (popup save, save-page menu), where
// extraction runs in-page with the backend extractor as fallback. Link saves
// have no open page, so they go straight to the backend extractor.
//
// Result: { status: 'saved' | 'updated' | 'duplicate' | 'auth' | 'error',
//           url?, message? }
async function performSave(url, { fallbackTitle, extractTabId } = {}) {
  if (!isHttpUrl(url)) {
    return { status: 'error', message: 'Not a saveable page' };
  }

  const cfg = await getConfig();

  // Extraction is best-effort: a failed extraction still saves the bare URL
  // with the tab title.
  let extracted = null;
  try {
    if (extractTabId != null) extracted = await extractFromTab(extractTabId);
    if (!extracted) extracted = await extractViaBackend(cfg, url);
  } catch (err) {
    if (err instanceof UnauthorizedError) return { status: 'auth', url };
    // Network/extraction failure — fall through to a bare save.
  }

  const wordCount = extracted?.wordCount || wordCountFrom(extracted?.content);
  const body = {
    url,
    rkey: generateTid(),
    source: 'url',
    // If this URL is already saved, upgrade the stored content with this
    // (likely richer) extraction instead of getting a 409 back.
    updateContent: true,
    title: extracted?.title || fallbackTitle || undefined,
    author: extracted?.author || undefined,
    description: extracted?.description || undefined,
    content: extracted?.content || undefined,
    domain: extracted?.domain || undefined,
    image: extracted?.image || undefined,
    publishedAt: extracted?.published || undefined,
    wordCount: wordCount || undefined,
  };

  let res;
  try {
    res = await apiFetchWithRetry(cfg, '/api/saved', body);
  } catch {
    return { status: 'error', message: 'Network error — try again' };
  }

  if (res.ok) {
    const data = await res.json().catch(() => null);
    return { status: data?.updated ? 'updated' : 'saved' };
  }
  if (res.status === 409) {
    // Duplicate — already saved (nothing to upgrade). Treat as success.
    return { status: 'duplicate' };
  }
  if (res.status === 401 || res.status === 403) {
    // 401 = logged out; 403 = monthly URL-save limit or a session needing a
    // scope upgrade. The /save page renders proper UI for all of these.
    return { status: 'auth', url };
  }

  const data = await res.json().catch(() => null);
  return { status: 'error', message: data?.error || `save failed (${res.status})` };
}

// Context-menu entry point: save and report via the toolbar badge.
async function saveWithBadge(url, tabId, opts) {
  if (!isHttpUrl(url)) {
    flashBadge(tabId, '!', BADGE_RED, 'Skyreader: not a saveable page');
    return;
  }
  setBadge(tabId, '…', BADGE_BLUE, 'Saving to Skyreader…');
  const result = await performSave(url, opts);
  switch (result.status) {
    case 'saved':
      flashBadge(tabId, '✓', BADGE_BLUE, 'Saved to Skyreader');
      break;
    case 'updated':
      flashBadge(tabId, '✓', BADGE_BLUE, 'Skyreader: updated with the full article');
      break;
    case 'duplicate':
      flashBadge(tabId, '✓', BADGE_BLUE, 'Already in your Saved list');
      break;
    case 'auth': {
      setBadge(tabId, '', BADGE_BLUE, 'Skyreader');
      const cfg = await getConfig();
      openSavePage(cfg, result.url || url);
      break;
    }
    default:
      flashBadge(tabId, '!', BADGE_RED, `Skyreader: ${result.message || 'save failed'}`);
  }
}

// --- Subscribe flow ---------------------------------------------------------

// Subscribe to a discovered feed. `feed` is either:
//   { kind: 'rss', feedUrl, title?, siteUrl? }
//   { kind: 'standard', publicationUri, did, name?, url?, iconUrl? }
// Mirrors AddFeedModal's addFeed / addStandardSite (frontend). The backend uses
// INSERT OR REPLACE, so re-subscribing is idempotent (no duplicate error).
//
// Result: { status: 'subscribed' | 'auth' | 'limit' | 'error', message? }
async function performSubscribe(feed) {
  const cfg = await getConfig();
  const rkey = generateTid();

  let body;
  if (feed.kind === 'standard') {
    if (!feed.publicationUri || !feed.did) {
      return { status: 'error', message: 'Incomplete publication' };
    }
    body = {
      rkey,
      // standard.site publications are AT Proto document streams; feedUrl carries
      // the publication URI, matching addStandardSite in the frontend.
      feedUrl: feed.publicationUri,
      title: feed.name || undefined,
      siteUrl: feed.url || undefined,
      sourceType: 'atproto.documents',
      subjectDid: feed.did,
      customIconUrl: feed.iconUrl || undefined,
    };
  } else {
    if (!isHttpUrl(feed.feedUrl)) {
      return { status: 'error', message: 'Invalid feed URL' };
    }
    body = {
      rkey,
      feedUrl: feed.feedUrl,
      title: feed.title || undefined,
      siteUrl: feed.siteUrl || undefined,
    };
  }

  let res;
  try {
    res = await apiFetchWithRetry(cfg, '/api/subscriptions', body);
  } catch {
    return { status: 'error', message: 'Network error — try again' };
  }

  if (res.ok) return { status: 'subscribed' };
  if (res.status === 401) return { status: 'auth' };

  const data = await res.json().catch(() => null);
  if (res.status === 403 && data?.error === 'subscription_limit_reached') {
    return { status: 'limit', message: data.message || 'Feed limit reached' };
  }
  return { status: 'error', message: data?.error || `subscribe failed (${res.status})` };
}

// --- Feed discovery ---------------------------------------------------------

// Normalize a feed URL for de-duplication across the live-DOM scan and the
// backend result (they often report the same feed with a trailing-slash diff).
function normalizeFeedUrl(u) {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/+$/, '') + x.search;
  } catch {
    return u;
  }
}

// Best-effort RSS-vs-Atom guess from the URL alone, for backend-discovered feeds
// that never carried a <link type>. Only claims a format when the path clearly
// says so (e.g. /atom.xml, /feed/rss); otherwise null (no tag shown).
function inferFormatFromUrl(u) {
  const path = (() => {
    try {
      return new URL(u).pathname.toLowerCase();
    } catch {
      return u.toLowerCase();
    }
  })();
  if (/atom/.test(path)) return 'atom';
  if (/rss/.test(path)) return 'rss';
  return null;
}

// Scan the tab's live DOM for advertised RSS/Atom feeds. Works on JS-rendered
// pages the backend's cold fetch can't see. The <link type> attribute is the
// authoritative RSS-vs-Atom signal, so we keep it — pages often advertise both
// an RSS and an Atom feed for the same content, and they're indistinguishable
// without the format label. Returns [{ feedUrl, title, format }], format one of
// 'rss' | 'atom' | null.
async function discoverFeedLinksInTab(tabId) {
  if (tabId == null) return [];
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const out = [];
        for (const l of document.querySelectorAll('link[rel~="alternate"][href]')) {
          const type = (l.getAttribute('type') || '').toLowerCase();
          if (type.includes('rss') || type.includes('atom') || type.includes('xml')) {
            try {
              out.push({
                feedUrl: new URL(l.getAttribute('href'), location.href).href,
                title: l.getAttribute('title') || null,
                format: type.includes('atom') ? 'atom' : type.includes('rss') ? 'rss' : null,
              });
            } catch {
              /* skip unparseable href */
            }
          }
        }
        return out;
      },
    });
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

// Backend discovery: cold-fetches the page for RSS feeds and resolves+verifies
// a standard.site publication (the .well-known check can only run server-side).
// Returns { feeds: string[], standardSite: {...} | null }; a 401 is surfaced.
async function discoverViaBackend(cfg, url) {
  const res = await apiGet(cfg, `/api/v2/feeds/discover?url=${encodeURIComponent(url)}`);
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) return { feeds: [], standardSite: null };
  const data = await res.json().catch(() => null);
  return { feeds: data?.feeds || [], standardSite: data?.standardSite || null };
}

// The user's current subscriptions (identifiers only), for marking already-added
// feeds. Best-effort: a failure returns [] so discovery still works. Returns
// [{ feedUrl, subjectDid }].
async function fetchSubscriptions(cfg) {
  const res = await apiGet(cfg, '/api/subscriptions');
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return data?.subscriptions || [];
}

// Is this exact URL already in the user's Saved list? A 401 is surfaced.
async function fetchSavedStatus(cfg, url) {
  const res = await apiGet(cfg, `/api/saved/status?url=${encodeURIComponent(url)}`);
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) return false;
  const data = await res.json().catch(() => null);
  return !!data?.saved;
}

// Merge the live-DOM scan with the backend result, and mark which are already
// subscribed. DOM feeds win (they carry a title and an authoritative format from
// the <link>); backend-only feeds get a null title and a URL-guessed format.
// Result: { feeds: [{ feedUrl, title, format, subscribed }],
//           standardSite: { ..., subscribed } | null }
async function discoverFeeds(tabId, url) {
  const cfg = await getConfig();
  const [domFeeds, backend, subs] = await Promise.all([
    discoverFeedLinksInTab(tabId),
    discoverViaBackend(cfg, url), // throws UnauthorizedError when logged out
    fetchSubscriptions(cfg).catch(() => []),
  ]);

  // Existing subscriptions, keyed for matching: RSS by normalized feedUrl,
  // standard.site by DID (and by publicationUri, which is stored as feed_url).
  const subFeedUrls = new Set(
    subs.filter((s) => s.feedUrl).map((s) => normalizeFeedUrl(s.feedUrl))
  );
  const subDids = new Set(subs.filter((s) => s.subjectDid).map((s) => s.subjectDid));

  const byKey = new Map();
  for (const f of domFeeds) {
    if (!f?.feedUrl || !isHttpUrl(f.feedUrl)) continue;
    byKey.set(normalizeFeedUrl(f.feedUrl), {
      feedUrl: f.feedUrl,
      title: f.title || null,
      format: f.format || null,
    });
  }
  for (const u of backend.feeds) {
    if (!isHttpUrl(u)) continue;
    const key = normalizeFeedUrl(u);
    if (!byKey.has(key)) byKey.set(key, { feedUrl: u, title: null, format: inferFormatFromUrl(u) });
  }

  const feeds = [...byKey.values()].map((f) => ({
    ...f,
    subscribed: subFeedUrls.has(normalizeFeedUrl(f.feedUrl)),
  }));

  let standardSite = backend.standardSite;
  if (standardSite) {
    standardSite = {
      ...standardSite,
      subscribed:
        subDids.has(standardSite.did) ||
        (standardSite.publicationUri &&
          subFeedUrls.has(normalizeFeedUrl(standardSite.publicationUri))),
    };
  }

  return { feeds, standardSite };
}

// --- Message router (popup ↔ service worker) --------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'discover':
          try {
            const { feeds, standardSite } = await discoverFeeds(msg.tabId, msg.url);
            sendResponse({ ok: true, feeds, standardSite });
          } catch (err) {
            if (err instanceof UnauthorizedError) sendResponse({ ok: false, needsAuth: true });
            else sendResponse({ ok: false, error: String(err) });
          }
          break;
        case 'savedStatus':
          try {
            const cfg = await getConfig();
            sendResponse({ ok: true, saved: await fetchSavedStatus(cfg, msg.url) });
          } catch (err) {
            if (err instanceof UnauthorizedError) sendResponse({ ok: false, needsAuth: true });
            else sendResponse({ ok: false, error: String(err) });
          }
          break;
        case 'save':
          sendResponse(
            await performSave(msg.url, { fallbackTitle: msg.title, extractTabId: msg.tabId })
          );
          break;
        case 'subscribe':
          sendResponse(await performSubscribe(msg.feed));
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true; // async sendResponse
});

// --- Context menus ----------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-link',
    title: 'Save link to Skyreader',
    contexts: ['link'],
  });
  chrome.contextMenus.create({
    id: 'save-page',
    title: 'Save page to Skyreader',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-link') {
    saveWithBadge(info.linkUrl, tab?.id);
  } else if (info.menuItemId === 'save-page') {
    saveWithBadge(info.pageUrl, tab?.id, { fallbackTitle: tab?.title, extractTabId: tab?.id });
  }
});
