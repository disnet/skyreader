<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';

  // The "+" that opens the Add modal (add/AddModal.svelte), which the sidebar
  // renders once for the whole app. The keyboard shortcut ("a") opens the same.
</script>

<button
  class="add-trigger"
  onclick={(e) => {
    e.stopPropagation();
    sidebarStore.openAddModal();
  }}
  aria-haspopup="dialog"
  aria-expanded={sidebarStore.addModalTab !== null}
  aria-label="Add"
  title="Add (a)"
>
  <Icon name="plus" size={16} />
</button>

<style>
  .add-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem 0.375rem;
    border: none;
    background: transparent;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.2s,
      color 0.2s;
  }

  .add-trigger:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }
</style>
