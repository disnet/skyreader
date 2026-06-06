<script lang="ts">
  // The quiet meta row beneath an entry: source host · share date · social counts.
  // Each part is optional; separators only appear between present parts.
  interface Props {
    host?: string | null;
    date?: string;
    social?: string;
  }
  let { host = null, date = '', social = '' }: Props = $props();

  const parts = $derived(
    [
      host ? { cls: 'src', text: host } : null,
      date ? { cls: '', text: date } : null,
      social ? { cls: 'social', text: social } : null,
    ].filter((p): p is { cls: string; text: string } => p !== null)
  );
</script>

{#if parts.length}
  <div class="meta">
    {#each parts as p, i (i)}
      {#if i > 0}<span class="sep" aria-hidden="true">·</span>{/if}
      <span class={p.cls || undefined}>{p.text}</span>
    {/each}
  </div>
{/if}
