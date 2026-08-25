<script lang="ts">
  import SembleConnectionDialog from './SembleConnectionDialog.svelte';
  import {
    sembleConnectionStore,
    type SembleConnectionSource,
  } from '$lib/stores/sembleConnection.svelte';

  interface Props {
    source?: SembleConnectionSource;
  }

  let {
    source = {
      url: 'https://example.test/the-article',
      title: 'The Article',
    },
  }: Props = $props();

  $effect(() => {
    sembleConnectionStore.openFor(source);
  });
</script>

<SembleConnectionDialog />
