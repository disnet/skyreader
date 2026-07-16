// Skyreader — one-click save.
//
// Clicking the toolbar icon saves the current tab; the context menu saves a
// link or the page. The save flow mirrors the frontend's saveFromUrl
// (frontend/src/lib/stores/saves.svelte.ts): generate a TID rkey, extract
// content via POST /api/extract, then create the save via POST /api/saved.
//
// Auth rides on the browser's existing skyreader.app session cookie
// (Domain=.skyreader.app covers api.skyreader.app; the host_permission
// exempts extension-initiated fetches from SameSite and CORS). When the user
// isn't logged in, we fall back to opening the frontend's /save?url= page,
// which handles login and resumes the save.

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
    chrome.action.setTitle({ tabId, title: 'Save to Skyreader' }).catch(() => {});
  }, 4000);
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

async function apiFetch(cfg, path, body) {
  return fetch(`${cfg.apiBase}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

// Open the frontend's /save page, which handles login-then-resume and shows
// proper UI for limit/scope errors.
function openSavePage(cfg, url) {
  chrome.tabs.create({
    url: `${cfg.frontendBase}/save?url=${encodeURIComponent(url)}`,
  });
}

async function saveUrl(url, tabId, fallbackTitle) {
  if (!isHttpUrl(url)) {
    flashBadge(tabId, '!', BADGE_RED, 'Skyreader: not a saveable page');
    return;
  }

  const cfg = await getConfig();
  setBadge(tabId, '…', BADGE_BLUE, 'Saving to Skyreader…');

  // Extract content first (same as the web app). Best-effort: a failed
  // extraction still saves the bare URL with the tab title.
  let extracted = null;
  try {
    const res = await apiFetchWithRetry(cfg, '/api/extract', { url });
    if (res.status === 401) {
      setBadge(tabId, '', BADGE_BLUE, 'Save to Skyreader');
      openSavePage(cfg, url);
      return;
    }
    if (res.ok) extracted = await res.json();
  } catch {
    // Network/extraction failure — fall through to a bare save.
  }

  const wordCount = extracted?.wordCount || wordCountFrom(extracted?.content);
  const body = {
    url,
    rkey: generateTid(),
    source: 'url',
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
    flashBadge(tabId, '!', BADGE_RED, 'Skyreader: network error — try again');
    return;
  }

  if (res.ok) {
    flashBadge(tabId, '✓', BADGE_BLUE, 'Saved to Skyreader');
    return;
  }

  if (res.status === 409) {
    // Duplicate — already saved. Treat as success.
    flashBadge(tabId, '✓', BADGE_BLUE, 'Already in your Saved list');
    return;
  }

  if (res.status === 401) {
    setBadge(tabId, '', BADGE_BLUE, 'Save to Skyreader');
    openSavePage(cfg, url);
    return;
  }

  if (res.status === 403) {
    // Monthly URL-save limit or a session needing a scope upgrade — the /save
    // page renders proper UI for both.
    setBadge(tabId, '', BADGE_BLUE, 'Save to Skyreader');
    openSavePage(cfg, url);
    return;
  }

  const data = await res.json().catch(() => null);
  flashBadge(tabId, '!', BADGE_RED, `Skyreader: ${data?.error || `save failed (${res.status})`}`);
}

// --- Entry points -----------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  saveUrl(tab.url, tab.id, tab.title);
});

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
    saveUrl(info.linkUrl, tab?.id);
  } else if (info.menuItemId === 'save-page') {
    saveUrl(info.pageUrl, tab?.id, tab?.title);
  }
});
