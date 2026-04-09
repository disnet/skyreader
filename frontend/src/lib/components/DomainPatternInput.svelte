<script lang="ts">
  interface Props {
    patterns: string[];
    availableDomains: string[];
    onchange: (patterns: string[]) => void;
    hint?: string;
  }

  let { patterns, availableDomains, onchange, hint = 'Press Enter to add. Matches against feed URL hostnames.' }: Props = $props();

  let domainInput = $state('');
  let suggestionsOpen = $state(false);
  let highlightIndex = $state(-1);

  let suggestions = $derived.by(() => {
    const q = domainInput.trim().toLowerCase();
    const existing = new Set(patterns);
    return availableDomains.filter((d) => (!q || d.includes(q)) && !existing.has(d));
  });

  function addPattern(value?: string) {
    const v = (value ?? domainInput).trim();
    if (v && !patterns.includes(v)) {
      onchange([...patterns, v]);
    }
    domainInput = '';
    suggestionsOpen = false;
    highlightIndex = -1;
  }

  function removePattern(pattern: string) {
    onchange(patterns.filter((p) => p !== pattern));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (suggestionsOpen && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlightIndex = (highlightIndex + 1) % suggestions.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlightIndex = highlightIndex <= 0 ? suggestions.length - 1 : highlightIndex - 1;
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (highlightIndex >= 0 && highlightIndex < suggestions.length) {
          addPattern(suggestions[highlightIndex]);
        } else {
          addPattern();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        suggestionsOpen = false;
        highlightIndex = -1;
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      addPattern();
    } else if (e.key === 'Backspace' && !domainInput && patterns.length > 0) {
      onchange(patterns.slice(0, -1));
    }
  }

  function handleInput() {
    suggestionsOpen = true;
    highlightIndex = -1;
  }

  function handleBlur() {
    setTimeout(() => {
      suggestionsOpen = false;
      addPattern();
    }, 150);
  }
</script>

<div class="chip-input-wrapper">
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="chip-input"
    onclick={(e) => {
      const input = (e.currentTarget as HTMLElement).querySelector('input');
      input?.focus();
    }}
  >
    {#each patterns as pattern}
      <span class="chip">
        {pattern}
        <button
          type="button"
          class="chip-remove"
          onclick={() => removePattern(pattern)}
          aria-label="Remove {pattern}"
        >
          &times;
        </button>
      </span>
    {/each}
    <input
      type="text"
      bind:value={domainInput}
      onkeydown={handleKeydown}
      oninput={handleInput}
      onblur={handleBlur}
      onfocus={() => (suggestionsOpen = true)}
      placeholder={patterns.length === 0 ? 'Type a domain and press Enter' : ''}
      class="chip-text-input"
      role="combobox"
      aria-expanded={suggestionsOpen && suggestions.length > 0}
      aria-autocomplete="list"
      autocomplete="off"
    />
  </div>
  {#if suggestionsOpen && suggestions.length > 0}
    <ul class="chip-suggestions" role="listbox">
      {#each suggestions as suggestion, i (suggestion)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          class="chip-suggestion"
          class:highlighted={i === highlightIndex}
          role="option"
          aria-selected={i === highlightIndex}
          onmousedown={(e) => {
            e.preventDefault();
            addPattern(suggestion);
          }}
          onmouseenter={() => (highlightIndex = i)}
        >
          {suggestion}
        </li>
      {/each}
    </ul>
  {/if}
</div>
{#if hint}
  <span class="form-hint">{hint}</span>
{/if}

<style>
  .chip-input-wrapper {
    position: relative;
  }

  .chip-input {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    cursor: text;
    min-height: 2.25rem;
  }

  .chip-input:focus-within {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.25rem 0.125rem 0.5rem;
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.06));
    border-radius: 4px;
    font-size: 0.8125rem;
    color: var(--color-text);
    line-height: 1.4;
  }

  .chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    height: 1.125rem;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
    line-height: 1;
    border-radius: 3px;
  }

  .chip-remove:hover {
    background: rgba(0, 0, 0, 0.1);
    color: var(--color-text);
  }

  .chip-text-input {
    flex: 1;
    min-width: 8rem;
    border: none;
    background: none;
    outline: none;
    font: inherit;
    font-size: 0.8125rem;
    color: var(--color-text);
    padding: 0.125rem 0;
  }

  .chip-text-input::placeholder {
    color: var(--color-text-secondary);
  }

  .chip-suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin: 0.25rem 0 0;
    padding: 0.25rem;
    list-style: none;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    z-index: 10;
    max-height: 160px;
    overflow-y: auto;
  }

  .chip-suggestion {
    padding: 0.375rem 0.5rem;
    font-size: 0.8125rem;
    border-radius: 4px;
    cursor: pointer;
    color: var(--color-text);
  }

  .chip-suggestion.highlighted {
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.06));
  }

  .form-hint {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    margin-top: 0.25rem;
  }
</style>
