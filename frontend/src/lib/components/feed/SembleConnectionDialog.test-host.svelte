<script lang="ts">
  import SembleConnectionDialog from './SembleConnectionDialog.svelte';
  import { sembleConnectionStore } from '$lib/stores/sembleConnection.svelte';

  sembleConnectionStore.openFor({
    url: 'https://example.test/the-article',
    title: 'The Article',
  });
</script>

<SembleConnectionDialog />
