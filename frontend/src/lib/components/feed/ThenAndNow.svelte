<script lang="ts">
  // At the end of a reread: how many passages each reading marked, and how many
  // of the earlier ones still mattered this time (utils/readings.ts). A quiet
  // record, not a score: it shows only once there's an earlier reading with
  // marks to compare.
  import { formatReadingWhen, readingName, type ReadingTally } from '$lib/utils/readings';

  interface Props {
    tallies: ReadingTally[];
    /** Earlier highlights marked again ("Still matters") in this reading. */
    markedAgain: number;
  }

  let { tallies, markedAgain }: Props = $props();

  const earlier = $derived(tallies.slice(0, -1));
  const now = $derived(tallies[tallies.length - 1]);

  function highlights(n: number) {
    return n === 1 ? '1 highlight' : `${n} highlights`;
  }
</script>

<div class="then-and-now">
  <h2>Then and now</h2>
  <ul>
    {#each earlier as t, i (t.startedAt)}
      <li>
        <span class="when">{readingName(i + 1)}, {formatReadingWhen(t.startedAt)}</span>
        <span>{highlights(t.count)}</span>
      </li>
    {/each}
    {#if now}
      <li>
        <span class="when">This reading</span>
        <span
          >{highlights(now.count)}{#if markedAgain > 0}, {markedAgain} still mattered{/if}</span
        >
      </li>
    {/if}
  </ul>
</div>

<style>
  .then-and-now {
    font-size: var(--text-sm);
    color: var(--color-text);
  }

  h2 {
    margin: 0 0 0.375rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    gap: 0.5rem;
    padding: 0.125rem 0;
  }

  .when {
    color: var(--color-text-secondary);
  }
</style>
