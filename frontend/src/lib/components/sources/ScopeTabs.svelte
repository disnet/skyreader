<script lang="ts" generics="T extends string">
  // Quiet pill tabs with counts: which slice of a list of sources to show.
  // Shared by Manage Sources (All / Atmosphere / Web / Parked) and Discover
  // (Linkblogs / Publications) so the two pages switch views the same way.
  interface Option {
    id: T;
    label: string;
    count?: number | null;
  }

  interface Props {
    options: Option[];
    value: T;
    label: string;
    onchange: (id: T) => void;
  }

  let { options, value, label, onchange }: Props = $props();

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = options.findIndex((o) => o.id === value);
    const next = options[(i + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length];
    onchange(next.id);
    (e.currentTarget as HTMLElement)
      .querySelector<HTMLButtonElement>(`[data-id="${next.id}"]`)
      ?.focus();
  }
</script>

<div class="scopes" role="tablist" aria-label={label} tabindex="-1" {onkeydown}>
  {#each options as o (o.id)}
    <button
      class="scope"
      class:active={value === o.id}
      role="tab"
      data-id={o.id}
      aria-selected={value === o.id}
      tabindex={value === o.id ? 0 : -1}
      onclick={() => onchange(o.id)}
    >
      {o.label}
      {#if o.count != null}<span class="scope-count">{o.count}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .scopes {
    display: flex;
    gap: 0.25rem;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .scope {
    flex-shrink: 0;
    display: inline-flex;
    align-items: baseline;
    gap: 0.375rem;
    padding: 0.3125rem 0.75rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-pill, 999px);
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .scope:hover {
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }

  .scope.active {
    color: var(--color-text);
    background: var(--color-bg-secondary);
    border-color: var(--color-border);
  }

  .scope-count {
    font-size: var(--text-xs);
    font-weight: var(--weight-regular);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .scope:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
</style>
