<script lang="ts">
  // The collection picker, mounted once in AppShell and driven by
  // integrationSaveStore, so "Save to Semble / Margin" works from every surface
  // (the discussion's "Add yours" row included) rather than only the pages that
  // happened to own the picker's state.
  import CollectionPicker from '$lib/components/CollectionPicker.svelte';
  import { integrationSaveStore } from '$lib/stores/integrationSave.svelte';
</script>

<CollectionPicker
  open={integrationSaveStore.open}
  integration={integrationSaveStore.integration}
  url={integrationSaveStore.url}
  onconfirm={(result) => integrationSaveStore.confirm(result)}
  onclose={() => integrationSaveStore.close()}
/>
