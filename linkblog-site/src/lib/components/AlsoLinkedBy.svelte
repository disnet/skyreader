<script lang="ts">
  import type { SocialContext } from '$lib/types';

  interface Props {
    ctx?: SocialContext;
  }
  let { ctx = undefined }: Props = $props();

  // "Also linked by @alice, @bob …" — others across the Atmosphere who linked the
  // same article, with their notes. Handles link to the linker's Bluesky profile.
  const entries = $derived(ctx?.alsoLinkedBy ?? []);
</script>

{#if entries.length}
  <div class="alsolinked">
    <span class="alsolabel">Also linked</span>
    <ul>
      {#each entries as e (e.recordUri)}
        <li>
          {#if e.handle}
            <a href={`https://bsky.app/profile/${e.handle}`}>@{e.handle}</a>
          {:else}
            {e.did.slice(0, 16)}
          {/if}
          {#if e.note}
            <span class="alsonote">“{e.note}”</span>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}
