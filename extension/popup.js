// Popup: pick between saving the current page and subscribing to a feed it
// advertises. All the real work happens in the service worker (background.js) —
// this file is UI plus chrome.runtime messages. See the onMessage router there.

const DEFAULTS = {
  apiBase: 'https://api.skyreader.app',
  frontendBase: 'https://skyreader.app',
};

const els = {
  title: document.getElementById('pageTitle'),
  url: document.getElementById('pageUrl'),
  saveBtn: document.getElementById('saveBtn'),
  saveStatus: document.getElementById('saveStatus'),
  feeds: document.getElementById('feeds'),
  feedsMsg: document.getElementById('feedsMsg'),
};

let tab = null;

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = `status${kind ? ' ' + kind : ''}`;
}

function isHttpUrl(raw) {
  try {
    const p = new URL(raw);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

function shortUrl(raw) {
  try {
    const u = new URL(raw);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return raw;
  }
}

// --- Save -------------------------------------------------------------------

// Reflect "already in your Saved list" on the primary button. Stays enabled — a
// re-save upgrades the stored content in place (the paywall fix), so clicking
// again is a meaningful "update from this page".
function markSaved() {
  els.saveBtn.classList.add('saved');
  els.saveBtn.textContent = 'Saved ✓';
  els.saveBtn.title = 'Update the saved copy with this page';
}

async function onSave() {
  els.saveBtn.disabled = true;
  setStatus(els.saveStatus, 'Saving…');

  const result = await send({
    type: 'save',
    url: tab.url,
    title: tab.title,
    tabId: tab.id,
  });
  els.saveBtn.disabled = false;

  switch (result?.status) {
    case 'saved':
      markSaved();
      setStatus(els.saveStatus, 'Saved to your reading list ✓', 'success');
      break;
    case 'updated':
      markSaved();
      setStatus(els.saveStatus, 'Updated with the full article ✓', 'success');
      break;
    case 'duplicate':
      markSaved();
      setStatus(els.saveStatus, 'Already in your Saved list ✓', 'success');
      break;
    case 'auth': {
      // Logged out, over the monthly limit, or a scope upgrade — the /save page
      // handles all three with proper UI.
      const cfg = await getConfig();
      chrome.tabs.create({ url: `${cfg.frontendBase}/save?url=${encodeURIComponent(tab.url)}` });
      window.close();
      return;
    }
    default:
      setStatus(els.saveStatus, result?.message || 'Save failed', 'error');
  }
}

// Check whether the page is already saved and reflect it on the button. Runs in
// parallel with discovery; silent on failure (the Save button still works).
async function refreshSavedState() {
  const res = await send({ type: 'savedStatus', url: tab.url });
  if (res?.ok && res.saved) markSaved();
}

// --- Subscribe --------------------------------------------------------------

function renderNoFeeds(text) {
  els.feeds.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'muted';
  msg.textContent = text;
  els.feeds.appendChild(msg);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// The standard.site logo glyph, referenced from the <symbol> in popup.html.
function standardSiteGlyph(className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#sr-standard-site');
  svg.appendChild(use);
  return svg;
}

// Build one feed row with its own Subscribe button + inline status.
// standard.site publications get a branded row: a tinted card, the publication's
// icon (or the standard.site logo as a fallback avatar), and a "standard.site"
// pill badge — mirroring the web app's AddFeedModal.
function feedRow(feed) {
  const row = document.createElement('div');
  row.className = feed.kind === 'standard' ? 'feed standard' : 'feed';

  if (feed.iconUrl) {
    const icon = document.createElement('img');
    icon.className = 'feed-icon';
    icon.src = feed.iconUrl;
    icon.alt = '';
    row.appendChild(icon);
  } else if (feed.kind === 'standard') {
    row.appendChild(standardSiteGlyph('feed-avatar'));
  }

  const info = document.createElement('div');
  info.className = 'feed-info';

  const name = document.createElement('span');
  name.className = 'feed-name';
  name.textContent = feed.name;

  // Meta line: for standard.site, a "standard.site" pill sits ahead of the URL
  // (mirrors the web app's AddFeedModal badge) so the name gets the full line.
  const sub = document.createElement('span');
  sub.className = 'feed-sub';
  if (feed.kind === 'standard') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.appendChild(standardSiteGlyph(''));
    badge.appendChild(document.createTextNode('standard.site'));
    sub.appendChild(badge);
  } else if (feed.format) {
    // RSS vs Atom: a muted tag so the two (often duplicate) feeds a page
    // advertises are tellable apart. CSS uppercases the text.
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = feed.format;
    sub.appendChild(tag);
  }
  const subUrl = document.createElement('span');
  subUrl.className = 'sub-url';
  subUrl.textContent = feed.sub;
  sub.appendChild(subUrl);

  info.append(name, sub);
  row.appendChild(info);

  const btn = document.createElement('button');
  btn.className = 'subscribe';
  if (feed.subscribed) {
    // Already in the user's feeds — show state, don't offer a re-subscribe (which
    // would silently replace the row, un-parking a parked feed).
    btn.textContent = 'Subscribed ✓';
    btn.classList.add('done');
    btn.disabled = true;
  } else {
    btn.textContent = 'Subscribe';
    // One listener for the life of the row; what a click *does* is carried by
    // btn.dataset.action, because a second addEventListener would stack on top
    // of this one rather than replace it.
    btn.dataset.action = 'subscribe';
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'upgrade') return openUpgrade();
      return subscribe(feed, btn);
    });
  }
  row.appendChild(btn);

  return row;
}

/** Open a Skyreader page and close the popup behind it. */
async function openTab(path) {
  const cfg = await getConfig();
  chrome.tabs.create({ url: `${cfg.frontendBase}${path}` });
  window.close();
}

function openUpgrade() {
  return openTab('/supporter');
}

async function subscribe(feed, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  btn.className = 'subscribe';

  const result = await send({ type: 'subscribe', feed: feed.payload });

  switch (result?.status) {
    case 'subscribed':
      btn.textContent = 'Subscribed ✓';
      btn.className = 'subscribe done';
      break;
    case 'auth': {
      await openTab('');
      return;
    }
    case 'limit':
      // The cap isn't something a retry fixes, so the button stops being a
      // retry and becomes the way out: one tap to the upgrade page.
      btn.textContent = 'Feed limit';
      btn.className = 'subscribe failed';
      btn.title = result.message || 'Feed limit reached. Open Skyreader to raise it.';
      btn.disabled = false;
      btn.dataset.action = 'upgrade';
      break;
    default:
      btn.textContent = 'Retry';
      btn.className = 'subscribe failed';
      btn.title = result?.message || 'Subscribe failed';
      btn.disabled = false;
      btn.dataset.action = 'subscribe';
  }
}

// Turn the discovery result into uniform row descriptors (standard.site first,
// preferred over RSS — same order as the web app's AddFeedModal).
function toRows({ feeds, standardSite }) {
  const rows = [];
  if (standardSite) {
    rows.push({
      kind: 'standard',
      name: standardSite.name || 'Publication',
      sub: standardSite.url ? shortUrl(standardSite.url) : 'standard.site',
      iconUrl: standardSite.iconUrl || null,
      subscribed: !!standardSite.subscribed,
      payload: {
        kind: 'standard',
        publicationUri: standardSite.publicationUri,
        did: standardSite.did,
        name: standardSite.name,
        url: standardSite.url,
        iconUrl: standardSite.iconUrl,
      },
    });
  }
  for (const f of feeds || []) {
    rows.push({
      kind: 'rss',
      name: f.title || shortUrl(f.feedUrl),
      sub: shortUrl(f.feedUrl),
      format: f.format || null, // 'rss' | 'atom' | null
      subscribed: !!f.subscribed,
      payload: { kind: 'rss', feedUrl: f.feedUrl, title: f.title || undefined, siteUrl: tab.url },
    });
  }
  return rows;
}

async function discover() {
  const result = await send({ type: 'discover', url: tab.url, tabId: tab.id });

  if (result?.needsAuth) {
    renderNoFeeds('Log in to Skyreader to find feeds.');
    return;
  }
  if (!result?.ok) {
    renderNoFeeds("Couldn't check this page for feeds.");
    return;
  }

  const rows = toRows(result);
  if (rows.length === 0) {
    renderNoFeeds('No feeds found on this page.');
    return;
  }

  els.feeds.innerHTML = '';
  for (const row of rows) els.feeds.appendChild(feedRow(row));
}

// --- Init -------------------------------------------------------------------

async function init() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = active;

  els.title.textContent = tab?.title || 'This page';
  els.url.textContent = tab?.url ? shortUrl(tab.url) : '';

  if (!tab?.url || !isHttpUrl(tab.url)) {
    // chrome://, extension pages, the Web Store, etc. — nothing to save or scan.
    els.saveBtn.disabled = true;
    setStatus(els.saveStatus, "This page can't be saved.", 'error');
    renderNoFeeds('No feeds on this page.');
    return;
  }

  els.saveBtn.addEventListener('click', onSave);
  refreshSavedState();
  discover();
}

init();
