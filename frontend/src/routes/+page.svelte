<script lang="ts">
  // `/` is the marketing landing for logged-out visitors and a pure redirector for
  // authenticated ones: the app proper now lives at /home, /feeds and /saved, so
  // nothing renders the app here. Any authed arrival — a cold load, the post-login
  // bounce, a "Go to Skyreader" / logo link — redirects to /home, with legacy deep
  // links (?saved=true, ?feed=, ?view=, ?category=, ?shared=) translated to their
  // new home so old bookmarks and share links keep working.
  //
  // The layout only renders this page once auth has resolved, so there's no
  // marketing flash before the redirect for a logged-in reader.
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { channelPath } from '$lib/utils/viewNav';
  import { preferences } from '$lib/stores/preferences.svelte';
  import WelcomePage from '$lib/components/feed/WelcomePage.svelte';

  const DEFAULT_VIEW_PATH: Record<typeof preferences.defaultView, string> = {
    home: '/home',
    feeds: '/feeds',
    saved: '/saved',
  };

  // Every branch below carries the remaining params through, which is what keeps
  // an old link that also names an open article (`?saved=true&read=…`) working:
  // `read` must survive to the new surface for the reader to restore there. The
  // bare-`?view=` channel branch is the one that drops params, and it only fires
  // when `view` is the *only* one — `?view=…&read=…` falls to the generic branch.
  function targetFor(url: URL): string {
    const sp = new URLSearchParams(url.search);
    if (sp.get('saved')) {
      sp.delete('saved');
      const rest = sp.toString();
      return rest ? `/saved?${rest}` : '/saved';
    }
    // A bare ?view= is a channel; route it by its mode so a saved channel lands
    // on /saved, not /feeds. channelPath falls back to /feeds if the store hasn't
    // hydrated yet — no worse than the generic case below.
    const view = sp.get('view');
    if (view && [...sp].length === 1) return channelPath(view);
    if ([...sp].length > 0) return `/feeds${url.search}`;
    // No params: land on the reader's chosen default surface. A guest who has
    // never picked one goes to the feeds instead of Home — guest mode exists to
    // put the starter library in front of someone, and Home leads with a
    // greeting and lanes that are thin until there's reading history behind
    // them. An explicit pick (Home's "Opens to" control) still wins.
    if (auth.isGuest && !preferences.defaultViewConfigured) return '/feeds';
    return DEFAULT_VIEW_PATH[preferences.defaultView];
  }

  $effect(() => {
    if (!browser) return;
    // Guests land wherever targetFor says, same as an account: /home, /feeds
    // and /saved are all guest surfaces now (saves are local-only for a guest).
    // A target outside those (nothing targetFor returns today) would hit the
    // layout's route guard and turn into the sign-in screen, not a 401 page.
    if (auth.isGuest || auth.isAuthenticated) {
      goto(targetFor(new URL(window.location.href)), { replaceState: true });
    }
  });
</script>

{#if !auth.isAuthenticated && !auth.isGuest}
  <WelcomePage />
{/if}
