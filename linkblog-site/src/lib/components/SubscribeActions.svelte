<script lang="ts">
  import { onMount } from 'svelte';

  // The masthead subscribe controls. Two ways to subscribe: "Atmosphere" writes a
  // portable site.standard.graph.subscription to the visitor's PDS via the backend
  // (redirecting to login first if needed); "RSS" is the open feed any reader can
  // follow. The backend lives on a different origin (api.skyreader.app) than this
  // page (linkblogs.skyreader.app) — same-site, so the session cookie rides the
  // credentialed fetch; CORS allows the call.
  interface Props {
    apiBase: string;
    appUrl: string;
    publication: string;
    feedUrl: string;
  }
  let { apiBase, appUrl, publication, feedUrl }: Props = $props();

  type State = 'idle' | 'busy' | 'subscribed';
  let state = $state<State>('idle');

  const titles: Record<State, string> = {
    idle: 'Subscribe in the Atmosphere',
    busy: 'Working…',
    subscribed: 'Subscribed — click to remove',
  };

  // Deep link into the app to this linkblog's feed. ?feed=<publicationUri> is a
  // stable cross-user key the app resolves to the visitor's local subscription.
  const openHref = $derived(`${appUrl}/?feed=${encodeURIComponent(publication)}`);

  function call(method: 'POST' | 'DELETE' | 'GET') {
    const init: RequestInit = { method, credentials: 'include' };
    if (method !== 'GET') {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify({ publication });
    }
    const url =
      method === 'GET'
        ? `${apiBase}/api/atmosphere/subscription?publication=${encodeURIComponent(publication)}`
        : `${apiBase}/api/atmosphere/subscription`;
    return fetch(url, init);
  }

  function login() {
    const returnUrl = `${location.origin}${location.pathname}?subscribe=1`;
    location.href = `${appUrl}/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`;
  }

  async function write(method: 'POST' | 'DELETE', ok: State) {
    state = 'busy';
    try {
      const res = await call(method);
      if (res.status === 401 || res.status === 403) {
        login();
        return;
      }
      if (!res.ok) throw new Error('failed');
      state = ok;
    } catch {
      // Revert to the prior state on a network error.
      state = method === 'POST' ? 'idle' : 'subscribed';
    }
  }

  function onClick(e: MouseEvent) {
    e.preventDefault();
    if (state === 'busy') return;
    if (state === 'subscribed') write('DELETE', 'idle');
    else write('POST', 'subscribed');
  }

  // Reflect existing state on load. Cross-origin we can't cheaply read the app's
  // sign-in marker, so we probe once: a stale/absent session just 401s and we stay
  // idle (never a redirect — only an explicit click does that).
  async function probe() {
    try {
      const res = await call('GET');
      if (!res.ok) return;
      const data = (await res.json()) as { subscribed?: boolean };
      if (data?.subscribed) state = 'subscribed';
    } catch {
      // ignore
    }
  }

  onMount(() => {
    const sp = new URLSearchParams(location.search);
    if (sp.get('subscribe') === '1') {
      // Resume an intent that bounced through login.
      sp.delete('subscribe');
      const qs = sp.toString();
      history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
      write('POST', 'subscribed');
    } else {
      probe();
    }
  });
</script>

<div class="pubactions">
  <span class="pubactions-label">Subscribe via:</span>
  <button
    type="button"
    class="sub-link sub-action"
    data-state={state}
    title={titles[state]}
    onclick={onClick}
  >
    <svg
      class="ico-follow"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="22" y1="11" x2="16" y2="11" />
    </svg>
    <svg
      class="ico-check"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
    <span class="sub-label">Atmosphere</span>
  </button>
  <a class="sub-link" href={feedUrl} title="Subscribe via RSS">
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        d="M6.18 17.82a2.18 2.18 0 1 0 0 4.36 2.18 2.18 0 0 0 0-4.36zM4 11.13v3.05a6.82 6.82 0 0 1 6.82 6.82h3.05A9.87 9.87 0 0 0 4 11.13zm0-6.63v3.05c7.16 0 12.96 5.8 12.96 12.95H20C20 11.07 12.84 4.5 4 4.5z"
      />
    </svg>
    <span>RSS</span>
  </a>
  <a class="open-app" class:show={state === 'subscribed'} href={openHref}>
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
    <span>Open in Skyreader</span>
  </a>
</div>
