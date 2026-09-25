<script lang="ts">
  // One on/off setting as a settings row: the name and its explanation on the
  // left, a switch on the right. The whole row is the label, so the target is
  // the row rather than a 16px box.
  //
  // The input's accessible name is the label alone (aria-labelledby), with the
  // explanation as its description — wrapping everything in a <label> would
  // otherwise make the whole paragraph the checkbox's name.
  //
  // `checked` is bindable so a caller that has to undo a failed save can write
  // the old value back and have the switch follow. A one-way `checked={x}` can't:
  // the click already moved the box, and resetting `x` to the value it still
  // holds changes nothing for Svelte to re-assert.
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    checked: boolean;
    disabled?: boolean;
    onchange?: (checked: boolean) => void;
    /** The explanation under the label. */
    children?: Snippet;
  }

  let { label, checked = $bindable(), disabled = false, onchange, children }: Props = $props();

  const uid = $props.id();
</script>

<label class="setting-toggle" class:disabled>
  <span class="text">
    <span class="label" id="{uid}-label">{label}</span>
    {#if children}
      <span class="desc" id="{uid}-desc">{@render children()}</span>
    {/if}
  </span>
  <input
    type="checkbox"
    class="switch"
    bind:checked
    {disabled}
    aria-labelledby="{uid}-label"
    aria-describedby={children ? `${uid}-desc` : undefined}
    onchange={(e) => onchange?.(e.currentTarget.checked)}
  />
</label>

<style>
  .setting-toggle {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    cursor: pointer;
  }

  .setting-toggle.disabled {
    cursor: default;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .label {
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .desc {
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
  }

  /* Level with the first line of the label, not the middle of the block. */
  .switch {
    margin-top: 0.05rem;
  }
</style>
