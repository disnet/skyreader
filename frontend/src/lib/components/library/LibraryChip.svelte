<script lang="ts">
  // Where a save sits in the other half of the Library: "On Shelf" on a Queue
  // row, "Archived" on a Shelf item. One quiet chip for both, so the same fact
  // reads the same way on either side.
  interface Props {
    label: string;
    title?: string;
  }

  let { label, title }: Props = $props();
</script>

<span class="library-chip" {title}>{label}</span>

<style>
  .library-chip {
    display: inline-flex;
    align-items: center;
    align-self: center;
    flex-shrink: 0;
    padding: 0 0.4375rem;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    line-height: 1.6;
    color: var(--color-text-secondary);
    white-space: nowrap;
  }
</style>
