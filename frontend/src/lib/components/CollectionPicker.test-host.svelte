<script lang="ts">
  import CollectionPicker from './CollectionPicker.svelte';

  let open = $state(true);
  let url = $state('https://example.test/a');

  function reopenForB() {
    open = false;
    url = 'https://example.test/b';
    open = true;
  }
</script>

<button data-testid="reopen" onclick={reopenForB}>Reopen</button>
<CollectionPicker integration="semble" {open} {url} onconfirm={() => {}} onclose={() => {}} />
