<script lang="ts">
  // The quiet meta row beneath an entry: source host · share date · social counts.
  // Each part is optional; separators only appear between present parts. When a
  // `permalink` is given, the date doubles as the (subtle) permalink to the entry.
  interface Props {
    host?: string | null;
    date?: string;
    permalink?: string | null;
    social?: string;
  }
  let { host = null, date = '', permalink = null, social = '' }: Props = $props();

  const parts = $derived(
    [
      host ? { cls: 'src', text: host, href: null } : null,
      date ? { cls: '', text: date, href: permalink } : null,
      social ? { cls: 'social', text: social, href: null } : null,
    ].filter((p): p is { cls: string; text: string; href: string | null } => p !== null)
  );
</script>

{#if parts.length}
  <div class="meta">
    {#each parts as p, i (i)}
      {#if i > 0}<span class="sep" aria-hidden="true">·</span>{/if}
      {#if p.href}
        <a class={p.cls || undefined} href={p.href}>{p.text}</a>
      {:else}
        <span class={p.cls || undefined}>{p.text}</span>
      {/if}
    {/each}
  </div>
{/if}
