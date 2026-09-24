<script lang="ts">
  // /following isn't a page of its own any more: "From your follows" is a source,
  // and its place in the app is a channel. This route resolves to that channel,
  // making the preset if no channel includes the source yet, or, without the
  // Bluesky permission, to the ask on Manage Sources. It's where Home's "View
  // all", the docs and the permission grant all land.
  // See docs/plans/FOLLOWS_LINKS_PLAN.md.
  import { goto } from '$app/navigation';
  import LoadingState from '$lib/components/LoadingState.svelte';
  import { appManager } from '$lib/stores/app.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { followLinksStore } from '$lib/stores/followLinks.svelte';
  import { ensureFollowsChannel } from '$lib/utils/followsChannel';
  import { channelPath } from '$lib/utils/viewNav';

  let started = false;

  $effect(() => {
    if (started || !auth.isAuthenticated || auth.isGuest) return;
    // Wait out the channel sync (Phase 2 of initialize): a follows channel made
    // on another device only arrives with it, and deciding before then would
    // make a second one.
    if (appManager.phase !== 'ready' && appManager.phase !== 'error') return;
    started = true;
    void resolve();
  });

  async function resolve() {
    // Forced: this is often the first stop after granting the permission,
    // and an answer cached from before it would still say no.
    await followLinksStore.load(true);
    if (followLinksStore.scopeRequired || !followLinksStore.loaded) {
      await goto('/sources#follows', { replaceState: true });
      return;
    }
    const uuid = await ensureFollowsChannel();
    await goto(channelPath(uuid), { replaceState: true });
  }
</script>

<svelte:head><title>From your follows - Skyreader</title></svelte:head>

<LoadingState />
