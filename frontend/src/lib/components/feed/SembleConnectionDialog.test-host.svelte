<script lang="ts">
  import SembleConnectionDialog from './SembleConnectionDialog.svelte';
  import {
    sembleConnectionStore,
    type SembleConnectionSource,
    type SembleConnectionTarget,
  } from '$lib/stores/sembleConnection.svelte';

  interface Props {
    source?: SembleConnectionSource;
    other?: SembleConnectionTarget;
  }

  let {
    source = {
      url: 'https://example.test/the-article',
      title: 'The Article',
    },
    other,
  }: Props = $props();

  $effect(() => {
    sembleConnectionStore.openFor(source, other);
  });
</script>

<SembleConnectionDialog />
