// Landing page for the extension's own login (Safari; see startExtensionLogin
// in background.js). The backend redirects here with the new session id in the
// fragment and the nonce the extension issued in the query. The session is only
// kept when the nonce matches the login this extension started, so a website
// can't send someone here with a session of its own.

const api = globalThis.browser ?? globalThis.chrome;

// A login left unfinished this long is abandoned; the backend's OAuth state
// expires after 10 minutes anyway.
const PENDING_TTL_MS = 15 * 60 * 1000;

function show(title, detail, isError = false) {
  document.getElementById('title').textContent = title;
  document.getElementById('detail').textContent = detail;
  document.getElementById('main').className = isError ? 'error' : '';
}

async function connect() {
  const nonce = new URLSearchParams(location.search).get('nonce');
  const session = new URLSearchParams(location.hash.slice(1)).get('session_id');
  // Keep the session id out of history and anything that copies the URL.
  history.replaceState(null, '', location.pathname);

  const { pendingLogin } = await api.storage.local.get('pendingLogin');
  await api.storage.local.remove('pendingLogin');

  const valid =
    session &&
    nonce &&
    pendingLogin?.nonce === nonce &&
    Date.now() - pendingLogin.at < PENDING_TTL_MS;
  if (!valid) {
    show(
      'Couldn’t connect',
      'This login wasn’t started from the extension, or it took too long. Open the Skyreader toolbar button and log in again.',
      true
    );
    return;
  }

  await api.storage.local.set({ session });
  show('You’re logged in', 'Skyreader is ready in Safari. You can close this tab.');
}

connect().catch(() => {
  show('Couldn’t connect', 'Something went wrong. Try logging in again.', true);
});
