<script lang="ts">
  // Where a user's shared links get published: the Skyreader linkblog Skyreader
  // makes for them, or an existing standard.site publication they already own in
  // Leaflet, pckt, Offprint, … Each row says what the publication actually is —
  // app, address, how many posts — because "Untitled publication" in a bare
  // dropdown tells nobody which of their publications they're about to write to.
  // A publication whose app won't render a post it didn't write itself (pckt) is
  // listed disabled with the reason, rather than hidden or silently accepted.
  import { untrack } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import {
    linkblogFormatLocked,
    linkblogSelectionChanged,
    publicationCompatibilityUnknown,
    publicationConnectable,
    publicationHost,
    publicationPostCount,
    resolveLinkblogFormat,
    type LinkblogFormat as Format,
  } from '$lib/utils/linkblogTargets';
  import type { LinkblogPublication, LinkblogPublicationChoice } from '$lib/types';

  let {
    current,
    choices,
    busy = false,
    showActions = true,
    onapply,
    onselect,
  }: {
    /** The publication links are being written to right now. */
    current: LinkblogPublication;
    choices: LinkblogPublicationChoice[];
    busy?: boolean;
    /**
     * Settings owns the Apply button. Embedded in a dialog that already has a
     * confirming button of its own (the first-share confirmation), the picker
     * only reports the selection and lets its host apply it.
     */
    showActions?: boolean;
    onapply?: (selection: { uri: string; isDefault: boolean; format: Format }) => void;
    /** Every change to the selection, for a host that applies it itself. */
    onselect?: (selection: {
      uri: string;
      isDefault: boolean;
      format: Format;
      /** There is something to apply: a different publication, or a different format. */
      changed: boolean;
      /** The selected publication can actually be published to. */
      selectable: boolean;
    }) => void;
  } = $props();

  // No pckt: pckt shows only the posts it wrote itself, so pckt blocks render
  // nowhere and there's no reason to offer them. (Skyreader still *reads* pckt
  // posts — this list is output formats only.)
  const FORMATS: Array<{ value: Format; label: string }> = [
    { value: 'leaflet', label: 'Leaflet blocks' },
    { value: 'offprint', label: 'Offprint blocks' },
    { value: 'markpub', label: 'Markdown (markpub.at)' },
  ];

  const formatLabel = (format: Format) =>
    FORMATS.find((entry) => entry.value === format)?.label ?? format;

  const skyreaderChoice = $derived(choices.find((choice) => choice.isDefault));
  const externalChoices = $derived(choices.filter((choice) => !choice.isDefault));

  // Seeded from the live target, then kept in step by the effect below (untrack
  // keeps the initializer from reading as a missed derived).
  let selectedUri = $state(untrack(() => current.uri));
  // Follow the server's answer: once a connect (or disconnect) lands, the live
  // publication is the selected one, even if the backend resolved a different
  // target than the row that was clicked.
  $effect(() => {
    selectedUri = current.uri;
  });
  // Format overrides, keyed by publication: switching rows shouldn't carry the
  // previous publication's format along, and revisiting a row shouldn't lose the
  // choice the user just made on it.
  let formatOverrides = $state<Record<string, Format>>({});

  const selected = $derived(choices.find((choice) => choice.uri === selectedUri));
  const selectedIsDefault = $derived(selected?.isDefault ?? true);
  const selectedFormat = $derived(resolveLinkblogFormat(selected, current, formatOverrides));
  // Leaflet, pckt and Offprint read only their own blocks, so the format is a
  // fact about the publication, not a decision for the user to get wrong.
  const formatLocked = $derived(linkblogFormatLocked(selected));
  // A publication whose app won't render our posts is offered disabled, so it
  // can't become the selection — and can't be applied if one ever slips through.
  const selectable = $derived(publicationConnectable(selected));
  const changed = $derived(
    selectable && linkblogSelectionChanged(selected, current, selectedFormat)
  );
  // We know what Leaflet, Offprint and markpub render; anything else takes
  // whatever format is chosen and may show none of it, which the user should
  // hear before sharing rather than after.
  const compatibilityUnknown = $derived(publicationCompatibilityUnknown(selected));

  // Report the live selection to a host that owns the apply step. Depends only
  // on the selection itself, so a host re-rendering off this callback doesn't
  // feed back into it.
  $effect(() => {
    onselect?.({
      uri: selectedUri,
      isDefault: selectedIsDefault,
      format: selectedFormat,
      changed,
      selectable,
    });
  });
</script>

<div class="target-picker">
  <p class="picker-label" id="linkblog-target-label">Publish new links to</p>

  <div class="pub-group" role="radiogroup" aria-labelledby="linkblog-target-label">
    {#if skyreaderChoice}
      <div class="pub-row">
        <label class="pub-option" class:selected={selectedUri === skyreaderChoice.uri}>
          <input type="radio" value={skyreaderChoice.uri} bind:group={selectedUri} />
          <span class="pub-radio" aria-hidden="true"></span>
          <span class="pub-info">
            <span class="pub-head">
              <span class="pub-name">Your Skyreader linkblog</span>
              <span class="pub-badge is-app">Skyreader</span>
              {#if current.uri === skyreaderChoice.uri}
                <span class="pub-badge is-live">Publishing here</span>
              {/if}
            </span>
            <span class="pub-meta">
              {publicationHost(current.url) ?? 'linkblogs.skyreader.app'} · {publicationPostCount(
                skyreaderChoice.posts
              )}
            </span>
            <span class="pub-desc">
              Made for you by Skyreader — you name it, and it holds nothing but your shared links.
            </span>
          </span>
        </label>
        <!-- `current.url` is always the canonical Skyreader linkblog URL, even
             while links are going to a connected publication; the choice's own
             `url` is the record's stored field, which can be stale or unset. It
             stays populated once the page is turned off, so check that too —
             the page 404s from then on. -->
        {#if current.url && !current.pageHidden}
          <a
            class="pub-open"
            href={current.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open your Skyreader linkblog"
            aria-label="Open your Skyreader linkblog in a new tab"
          >
            <Icon name="external-link" size={15} />
          </a>
        {/if}
      </div>
    {/if}

    {#if externalChoices.length > 0}
      <p class="group-label">Or a publication you already have</p>
      {#each externalChoices as choice (choice.uri)}
        {@const connectable = publicationConnectable(choice)}
        {@const compatUnknown = publicationCompatibilityUnknown(choice)}
        <div class="pub-row">
          <label
            class="pub-option"
            class:selected={selectedUri === choice.uri}
            class:unavailable={!connectable}
          >
            <input
              type="radio"
              value={choice.uri}
              bind:group={selectedUri}
              disabled={!connectable}
            />
            <span class="pub-radio" aria-hidden="true"></span>
            <span class="pub-info">
              <span class="pub-head">
                <span class="pub-name">{choice.name}</span>
                {#if choice.appLabel}
                  <span class="pub-badge is-app">{choice.appLabel}</span>
                {/if}
                {#if compatUnknown}
                  <span class="pub-badge is-unknown">Compatibility unknown</span>
                {/if}
                {#if !connectable}
                  <span class="pub-badge is-unavailable">Can't publish here</span>
                {:else if current.uri === choice.uri}
                  <span class="pub-badge is-live">Publishing here</span>
                {/if}
              </span>
              <span class="pub-meta">
                {publicationHost(choice.url) ?? choice.rkey} · {publicationPostCount(choice.posts)}
              </span>
              {#if !connectable}
                <span class="pub-desc">
                  {choice.unsupportedReason ??
                    "This publication's app shows only the posts it wrote itself."}
                </span>
              {:else if choice.description}
                <span class="pub-desc">{choice.description}</span>
              {/if}
            </span>
          </label>
          {#if choice.url}
            <a
              class="pub-open"
              href={choice.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open {choice.name}"
              aria-label="Open {choice.name} in a new tab"
            >
              <Icon name="external-link" size={15} />
            </a>
          {/if}
        </div>
      {/each}
    {:else}
      <!-- Nothing to switch to. Say why, or the disclosure that opened this
           resolves to a single row and no explanation. -->
      <p class="picker-hint">
        Publications you make in Leaflet, Offprint or another standard.site app show up here, and
        your links can go into one of them instead.
      </p>
    {/if}
  </div>

  {#if compatibilityUnknown && selected}
    <p class="compat-warning">
      <strong>Skyreader can't tell whether your links will show up here.</strong>
      {#if selected.appLabel}
        Skyreader knows what Leaflet, Offprint and markpub read, but it has no writer for {selected.appLabel},
        so pick the format that app reads and check the site after your first share.
      {:else}
        This publication's app isn't one Skyreader recognizes, so pick the format that app reads and
        check the site after your first share.
      {/if}
      <!-- Not a second copy: one document is written, into the connected
           publication, and the linkblog page reads both publications. -->
      Your Skyreader linkblog page lists them either way.
    </p>
  {/if}

  {#if !selectedIsDefault && selected && formatLocked}
    <p class="format-fixed">
      Links go in as {formatLabel(selectedFormat)}, the only format {selected.appLabel ??
        'this app'} reads.
    </p>
  {:else if !selectedIsDefault && selected}
    <div class="format-row">
      <label class="format-label" for="linkblog-format">Write links as</label>
      <select
        id="linkblog-format"
        class="format-select"
        value={selectedFormat}
        onchange={(event) => {
          formatOverrides = {
            ...formatOverrides,
            [selectedUri]: event.currentTarget.value as Format,
          };
        }}
      >
        {#each FORMATS as format (format.value)}
          <option value={format.value}>{format.label}</option>
        {/each}
      </select>
      <p class="format-hint">
        {#if selected.detectedFormat && selected.detectedFormat === selectedFormat}
          Matches the posts already in this publication.
        {:else if selected.appLabel}
          Pick the format {selected.appLabel} reads, or your links won't render there.
        {:else}
          Pick the format this publication's app reads, or your links won't render there.
        {/if}
      </p>
    </div>
  {/if}

  {#if showActions && externalChoices.length > 0}
    <div class="picker-actions">
      <button
        class="btn btn-primary"
        onclick={() =>
          onapply?.({ uri: selectedUri, isDefault: selectedIsDefault, format: selectedFormat })}
        disabled={busy || !changed}
      >
        {#if busy}
          Saving…
        {:else if selectedIsDefault}
          Use my Skyreader linkblog
        {:else}
          Publish to {selected?.name ?? 'this publication'}
        {/if}
      </button>
    </div>

    <p class="picker-note">
      {#if !selectedIsDefault}
        Skyreader adds link posts to this publication and never touches the rest of it — its name,
        description and everything else stay managed by its own app.
      {:else if current.external}
        Links already in {current.name} stay there. Both publications keep showing up on your linkblog
        page and in your followers' feeds.
      {:else}
        Connecting only adds link posts to a publication you already have; nothing moves out of your
        Skyreader linkblog.
      {/if}
    </p>
  {/if}
</div>

<style>
  .target-picker {
    margin: 1rem 0;
  }

  .picker-label {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin: 0 0 0.5rem 0;
  }

  .group-label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0.5rem 0 0.1rem 0;
  }

  .picker-hint,
  .picker-note {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0.5rem 0 0 0;
  }

  .pub-group {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .pub-row {
    display: flex;
    align-items: stretch;
    gap: 0.35rem;
  }

  /* Selectable rows share the vocabulary of the save-backing picker so the two
     settings read as one system. */
  .pub-option {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0.65rem;
    flex: 1;
    min-width: 0;
    padding: 0.6rem 0.7rem;
    background: var(--color-bg);
    border: 1.5px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background-color 0.15s ease;
  }

  .pub-option:hover {
    border-color: var(--color-primary);
  }

  /* Still readable — the user owns this publication and deserves to see it
     listed — but plainly not a choice. */
  .pub-option.unavailable,
  .pub-option.unavailable:hover {
    border-color: var(--color-border);
    background: var(--color-bg-secondary);
    cursor: default;
  }

  .pub-option.unavailable .pub-name,
  .pub-option.unavailable .pub-radio {
    opacity: 0.6;
  }

  .pub-option.selected {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
  }

  /* Native radio stays for keyboard + group semantics, visually replaced by the
     custom dot. */
  .pub-option input[type='radio'] {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .pub-option:has(input:focus-visible) {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .pub-radio {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-top: 0.1rem;
    border: 1.5px solid var(--color-border);
    border-radius: 50%;
    transition: border-color 0.15s ease;
  }

  .pub-radio::after {
    content: '';
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--color-primary);
    transform: scale(0);
    transition: transform 0.15s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .pub-option.selected .pub-radio {
    border-color: var(--color-primary);
  }

  .pub-option.selected .pub-radio::after {
    transform: scale(1);
  }

  .pub-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .pub-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    min-width: 0;
  }

  .pub-name {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pub-badge {
    font-size: var(--text-xs);
    line-height: 1.4;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    white-space: nowrap;
  }

  .pub-badge.is-app {
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
  }

  .pub-badge.is-live {
    color: var(--color-primary);
    border: 1px solid var(--color-primary);
  }

  .pub-badge.is-unavailable {
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
  }

  /* A caution, not a refusal: this publication is still a real choice. */
  .pub-badge.is-unknown {
    color: var(--color-warning);
    border: 1px solid var(--color-warning);
  }

  .pub-meta {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pub-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .pub-open {
    display: flex;
    align-items: center;
    padding: 0 0.5rem;
    color: var(--color-text-secondary);
    border: 1.5px solid transparent;
    border-radius: 8px;
    transition: color 0.15s ease;
  }

  .pub-open:hover {
    color: var(--color-primary);
  }

  /* Same shape as the save-backing warning, so a caution reads the same in both
     settings. */
  .compat-warning {
    font-size: var(--text-md);
    color: var(--color-text);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0.75rem;
    margin: 0.875rem 0 0 0;
  }

  .compat-warning strong {
    color: var(--color-warning);
  }

  .format-row {
    margin-top: 0.75rem;
  }

  /* Nothing to choose here, so it reads as a note rather than a control. */
  .format-fixed {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0.75rem 0 0 0;
  }

  .format-label {
    display: block;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin-bottom: 0.375rem;
  }

  /* Native selects render differently in every browser; give this one the same
     box as the text inputs beside it. */
  .format-select {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    max-width: 22rem;
    padding: 0.5rem 2rem 0.5rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background-color: var(--color-bg);
    /* Chevron drawn inline so it inherits nothing from the platform widget. */
    background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23808080' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.6rem center;
    color: var(--color-text);
    font: inherit;
    box-sizing: border-box;
    cursor: pointer;
    transition: border-color 0.15s ease;
  }

  .format-select:hover {
    border-color: var(--color-primary);
  }

  .format-select:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
    border-color: var(--color-primary);
  }

  .format-hint {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0.375rem 0 0 0;
  }

  .picker-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.875rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .pub-option,
    .pub-radio,
    .pub-radio::after,
    .pub-open,
    .format-select {
      transition: none;
    }
  }
</style>
