<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/services/api';
  import { FRAME_SIGN_IN_READY, parseFrameSignInRequest } from '$lib/workspace/frameSignIn';

  // The popup of a sign-in started inside an atworkplace workspace frame
  // ($lib/workspace/frameSignIn.ts). It takes the sign-in request (handle or
  // provider, and the relay hash) only from the Skyreader frame that opened it,
  // by postMessage checked same-origin both ways, never from its URL, so a page
  // on another site can't open it with a relay of its own. Its login request
  // also sets the cookie that binds the callback to this browser.

  let error = $state('');

  onMount(() => {
    const opener = window.opener as Window | null;
    if (!opener) {
      error = 'Start signing in from Skyreader.';
      return;
    }

    async function onMessage(event: MessageEvent) {
      if (event.source !== opener || event.origin !== location.origin) return;
      const request = parseFrameSignInRequest(event.data);
      if (!request) return;
      window.removeEventListener('message', onMessage);
      clearTimeout(timeout);
      try {
        const { authUrl } =
          'pds' in request
            ? await api.signup(request.pds, request.returnUrl, request.relayHash)
            : await api.login(request.handle, request.returnUrl, request.relayHash);
        location.replace(authUrl);
      } catch (err) {
        error = err instanceof Error ? err.message : 'Failed to start sign-in';
      }
    }

    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      error = 'Start signing in from Skyreader.';
    }, 15_000);

    window.addEventListener('message', onMessage);
    opener.postMessage({ type: FRAME_SIGN_IN_READY }, location.origin);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    };
  });
</script>

<div class="frame-start-page">
  {#if error}
    <p>{error}</p>
  {:else}
    <p>Signing in…</p>
  {/if}
</div>

<style>
  .frame-start-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 50vh;
    color: var(--color-text-secondary);
  }
</style>
