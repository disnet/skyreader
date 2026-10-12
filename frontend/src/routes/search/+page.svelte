<script lang="ts">
  // Search is an overlay now (SearchOverlay, opened from anywhere), not a page.
  // This route only keeps old /search links and bookmarks working: it lands on
  // the reader's default view and opens search over it, carrying `?q=`/`?kind=`.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { searchStore } from '$lib/stores/search.svelte';
  import { FEEDS_PATH, SAVED_PATH } from '$lib/utils/viewNav';
  import type { SearchKind } from '$lib/services/api';

  const KINDS: SearchKind[] = ['saved', 'highlighted', 'read'];

  onMount(() => {
    const q = page.url.searchParams.get('q') ?? undefined;
    const kindParam = page.url.searchParams.get('kind') as SearchKind | null;
    const kind = kindParam && KINDS.includes(kindParam) ? kindParam : undefined;
    const target = { home: '/home', feeds: FEEDS_PATH, saved: SAVED_PATH }[preferences.defaultView];
    void goto(target, { replaceState: true }).then(() => searchStore.open({ query: q, kind }));
  });
</script>
