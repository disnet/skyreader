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
    note?: string;
  }

  let {
    source = {
      url: 'https://example.test/the-article',
      title: 'The Article',
    },
    other,
    note,
  }: Props = $props();

  $effect(() => {
    sembleConnectionStore.openFor(source, { target: other, note });
  });
</script>

<SembleConnectionDialog />
