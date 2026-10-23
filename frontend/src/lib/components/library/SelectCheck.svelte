<script lang="ts">
  // The checkbox a Library item shows in select mode. Decorative: the item itself
  // is the control (it carries aria-pressed), so this is only the mark.
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    checked: boolean;
  }

  let { checked }: Props = $props();
</script>

<span class="select-check" class:checked aria-hidden="true">
  {#if checked}<Icon name="check" size={12} strokeWidth={3} />{/if}
</span>

<style>
  .select-check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    box-sizing: border-box;
    border: 1.5px solid var(--color-text-secondary);
    border-radius: 4px;
    background: var(--color-bg);
    color: #fff;
  }

  .select-check.checked {
    border-color: var(--color-primary);
    background: var(--color-primary);
  }
</style>
