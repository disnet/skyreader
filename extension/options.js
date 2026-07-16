// Options: point the extension at a different server (staging / local dev).
// A non-default API base needs a matching optional host permission, requested
// here so the background fetches aren't blocked.

const DEFAULTS = {
  apiBase: 'https://api.skyreader.app',
  frontendBase: 'https://skyreader.app',
};

const apiBaseInput = document.getElementById('apiBase');
const frontendBaseInput = document.getElementById('frontendBase');
const statusEl = document.getElementById('status');

chrome.storage.sync.get(DEFAULTS).then((cfg) => {
  apiBaseInput.value = cfg.apiBase;
  frontendBaseInput.value = cfg.frontendBase;
});

function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? 'error' : '';
  setTimeout(() => {
    statusEl.textContent = '';
  }, 3000);
}

function normalize(raw, fallback) {
  const value = raw.trim().replace(/\/+$/, '');
  if (!value) return fallback;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return value;
  } catch {
    return null;
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const apiBase = normalize(apiBaseInput.value, DEFAULTS.apiBase);
  const frontendBase = normalize(frontendBaseInput.value, DEFAULTS.frontendBase);
  if (!apiBase || !frontendBase) {
    showStatus('Invalid URL', true);
    return;
  }

  // The background fetch needs host access to the API origin. The default is
  // a required permission; anything else must be granted here.
  const origin = `${new URL(apiBase).origin}/*`;
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) {
    const ok = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
    if (!ok) {
      showStatus('Permission for that server was declined', true);
      return;
    }
  }

  await chrome.storage.sync.set({ apiBase, frontendBase });
  apiBaseInput.value = apiBase;
  frontendBaseInput.value = frontendBase;
  showStatus('Saved');
});
