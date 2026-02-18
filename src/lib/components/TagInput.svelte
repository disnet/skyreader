<script lang="ts">
  import Icon from './Icon.svelte';
  import { tagsStore } from '$lib/stores/tags.svelte';

  interface Props {
    tags: string[];
    onAdd: (tag: string) => void;
    onRemove: (tag: string) => void;
  }

  let { tags, onAdd, onRemove }: Props = $props();

  let isAdding = $state(false);
  let inputValue = $state('');
  let inputRef = $state<HTMLInputElement | null>(null);
  let selectedSuggestionIndex = $state(-1);

  let suggestions = $derived.by(() => {
    if (!inputValue.trim()) return [];
    const term = inputValue.toLowerCase();
    return tagsStore.allTags
      .filter((t) => t.toLowerCase().includes(term) && !tags.includes(t))
      .slice(0, 5);
  });

  function startAdding(e: MouseEvent) {
    e.stopPropagation();
    isAdding = true;
    selectedSuggestionIndex = -1;
    requestAnimationFrame(() => inputRef?.focus());
  }

  function handleSubmit() {
    const value = inputValue.trim();
    if (value) {
      onAdd(value);
      inputValue = '';
      selectedSuggestionIndex = -1;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (selectedSuggestionIndex >= 0 && selectedSuggestionIndex < suggestions.length) {
        selectSuggestion(suggestions[selectedSuggestionIndex]);
      } else {
        handleSubmit();
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      isAdding = false;
      inputValue = '';
      selectedSuggestionIndex = -1;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestions.length > 0) {
        selectedSuggestionIndex = Math.min(selectedSuggestionIndex + 1, suggestions.length - 1);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, -1);
    }
  }

  function selectSuggestion(tag: string) {
    onAdd(tag);
    inputValue = '';
    selectedSuggestionIndex = -1;
    inputRef?.focus();
  }

  function handleBlur() {
    // Delay to allow click on suggestion
    setTimeout(() => {
      if (!inputRef?.matches(':focus')) {
        isAdding = false;
        inputValue = '';
        selectedSuggestionIndex = -1;
      }
    }, 200);
  }

  function handleRemove(e: MouseEvent, tag: string) {
    e.stopPropagation();
    onRemove(tag);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="tag-area" onclick={(e) => e.stopPropagation()}>
  {#each tags as tag}
    <span class="tag-chip">
      {tag}
      <button class="tag-remove" onclick={(e) => handleRemove(e, tag)} title="Remove tag">
        <Icon name="x" size={10} />
      </button>
    </span>
  {/each}

  {#if isAdding}
    <div class="tag-input-wrapper">
      <input
        bind:this={inputRef}
        type="text"
        bind:value={inputValue}
        class="tag-input"
        placeholder="Add tag..."
        maxlength={64}
        onkeydown={handleKeydown}
        onblur={handleBlur}
      />
      {#if suggestions.length > 0}
        <div class="tag-suggestions">
          {#each suggestions as suggestion, i}
            <button
              class="tag-suggestion"
              class:selected={i === selectedSuggestionIndex}
              onmousedown={(e) => {
                e.preventDefault();
                selectSuggestion(suggestion);
              }}
            >
              {suggestion}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <button class="tag-add-btn" onclick={startAdding} title="Add tag">
      <Icon name="tag" size={12} />
      <Icon name="plus" size={10} />
    </button>
  {/if}
</div>

<style>
  .tag-area {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.125rem 0.5rem;
    background: var(--color-bg-secondary, #f3f4f6);
    border-radius: 999px;
    font-size: 0.7rem;
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .tag-remove {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--color-text-secondary);
    opacity: 0.6;
    line-height: 1;
  }

  .tag-remove:hover {
    opacity: 1;
    color: var(--color-error, #ef4444);
  }

  .tag-add-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    background: none;
    border: 1px dashed var(--color-border, #e0e0e0);
    border-radius: 999px;
    padding: 0.125rem 0.375rem;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: 0.7rem;
  }

  .tag-add-btn:hover {
    color: var(--color-primary, #2563eb);
    border-color: var(--color-primary, #2563eb);
  }

  .tag-input-wrapper {
    position: relative;
  }

  .tag-input {
    width: 100px;
    padding: 0.125rem 0.375rem;
    border: 1px solid var(--color-primary, #2563eb);
    border-radius: 999px;
    font-size: 0.7rem;
    background: var(--color-bg, #fff);
    color: var(--color-text);
    outline: none;
  }

  .tag-input::placeholder {
    color: var(--color-text-secondary, #999);
  }

  .tag-suggestions {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    min-width: 120px;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
    z-index: 110;
    overflow: hidden;
  }

  .tag-suggestion {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.25rem 0.5rem;
    background: none;
    border: none;
    font-size: 0.75rem;
    cursor: pointer;
    color: var(--color-text);
  }

  .tag-suggestion:hover,
  .tag-suggestion.selected {
    background: var(--color-bg-secondary, #f3f4f6);
  }

  @media (prefers-color-scheme: dark) {
    .tag-chip {
      background: rgba(255, 255, 255, 0.1);
    }

    .tag-input {
      background: var(--color-bg, #1a1a1a);
    }

    .tag-suggestions {
      background: var(--color-bg, #1a1a1a);
    }
  }
</style>
