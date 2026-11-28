<script lang="ts">
  // "Come back to this" for one save, mounted once in AppShell and driven by
  // resurfaceStore.target. A choice applies at once and closes; the piece then
  // waits in Home's Back again lane from that morning (utils/resurface.ts).
  // Nothing is hidden or archived meanwhile.
  import Modal from '$lib/components/common/Modal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { resurfaceStore } from '$lib/stores/resurface.svelte';
  import {
    RESURFACE_CHOICES,
    formatResurfaceDay,
    resurfaceAtFor,
    resurfaceAtForDate,
    tomorrowInputValue,
    type ResurfaceChoice,
  } from '$lib/utils/resurface';

  let target = $derived(resurfaceStore.target);
  let save = $derived(target?.getSave());
  let current = $derived(save ? resurfaceStore.get(save) : null);
  let day = $state('');
  let busy = $state(false);
  // Read once per opening: the dialog is short-lived.
  let now = $derived(target ? Date.now() : 0);
  let dayAt = $derived(resurfaceAtForDate(day, now));

  async function choose(at: number) {
    const t = target;
    if (!t || busy) return;
    busy = true;
    close();
    try {
      await resurfaceStore.set(t, at);
    } finally {
      busy = false;
    }
  }

  function pick(choice: ResurfaceChoice) {
    void choose(resurfaceAtFor(choice, Date.now()));
  }

  function pickDay(e: SubmitEvent) {
    e.preventDefault();
    if (dayAt !== null) void choose(dayAt);
  }

  function clear() {
    if (save) void resurfaceStore.clear(save);
    close();
  }

  function close() {
    day = '';
    resurfaceStore.close();
  }
</script>

<Modal open={target !== null} onclose={close} title="Come back to this" maxWidth="360px">
  {#if target}
    <p class="subject">{target.title}</p>
    {#if current}
      <p class="current">
        <Icon name="clock" size={14} />
        {current.at <= now ? 'Came back on' : 'Comes back on'}
        {formatResurfaceDay(current.at, now)}
      </p>
    {/if}

    <div class="choices">
      {#each RESURFACE_CHOICES as choice (choice.id)}
        <button type="button" class="choice" disabled={busy} onclick={() => pick(choice.id)}>
          {choice.label}
          <span class="when">{formatResurfaceDay(resurfaceAtFor(choice.id, now), now)}</span>
        </button>
      {/each}
    </div>

    <form class="day" onsubmit={pickDay}>
      <label class="day-label" for="resurface-day">On a day</label>
      <input
        id="resurface-day"
        class="day-input"
        type="date"
        min={tomorrowInputValue(now)}
        bind:value={day}
      />
      <button type="submit" class="day-btn" disabled={busy || dayAt === null}>Set</button>
    </form>

    {#if !save && target.save}
      <p class="note">This saves it to your Library, so it's here when it comes back.</p>
    {/if}

    {#if current}
      <button type="button" class="clear" onclick={clear}>Don't bring it back</button>
    {/if}
  {/if}
</Modal>

<style>
  .subject {
    margin: 0 0 0.75rem;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .current {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0 0 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-text);
  }

  .choices {
    display: flex;
    flex-direction: column;
    margin: 0 0 0.75rem;
  }

  .choice {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.625rem 0.25rem;
    border: none;
    border-bottom: 1px solid var(--color-border);
    background: none;
    font: inherit;
    font-size: var(--text-md);
    color: var(--color-text);
    text-align: left;
    cursor: pointer;
  }

  .choice:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .choice:focus-visible,
  .day-btn:focus-visible,
  .clear:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  .when {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .day {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.75rem;
  }

  .day-label {
    font-size: var(--text-md);
    color: var(--color-text);
    flex: 1;
  }

  .day-input {
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text);
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .day-input {
      font-size: 1rem;
    }
  }

  .day-btn {
    padding: 0.375rem 0.75rem;
    border: none;
    border-radius: 6px;
    background: var(--color-primary);
    color: white;
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .day-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .note {
    margin: 0 0 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .clear {
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    text-decoration: underline;
    cursor: pointer;
  }
</style>
