<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import Icon, { type IconName } from '$lib/components/Icon.svelte';

  interface Props {
    iconName: IconName;
    label: string;
    hasFilter?: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    showChevron?: boolean;
    title?: string;
    buttonClass?: string;
    children: Snippet;
  }

  let {
    iconName,
    label,
    hasFilter = false,
    open,
    onOpenChange,
    showChevron = true,
    title,
    buttonClass = '',
    children,
  }: Props = $props();

  let wrapperRef = $state<HTMLDivElement | null>(null);

  function handleClickOutside(e: MouseEvent) {
    if (open && wrapperRef && !wrapperRef.contains(e.target as Node)) {
      onOpenChange(false);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      onOpenChange(false);
    }
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside, true);
    document.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    document.removeEventListener('click', handleClickOutside, true);
    document.removeEventListener('keydown', handleKeydown);
  });

  function viewportAware(node: HTMLElement) {
    const PADDING = 8;

    function reposition() {
      node.style.left = '';
      node.style.right = '';
      node.style.top = '';
      node.style.bottom = '';
      node.style.maxHeight = '';

      const rect = node.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (rect.left < PADDING) {
        node.style.right = 'auto';
        node.style.left = '0';
      }
      const rectAfter = node.getBoundingClientRect();
      if (rectAfter.right > vw - PADDING) {
        node.style.right = '0';
        node.style.left = 'auto';
      }

      const topAfterH = node.getBoundingClientRect().top;
      const availableBelow = vh - topAfterH - PADDING;
      if (rect.height > availableBelow && availableBelow > 120) {
        node.style.maxHeight = `${availableBelow}px`;
      } else if (availableBelow < 120) {
        node.style.top = 'auto';
        node.style.bottom = 'calc(100% + 4px)';
        const parent = node.offsetParent as HTMLElement | null;
        const parentRect = parent?.getBoundingClientRect();
        const availableAbove = parentRect ? parentRect.top - PADDING : vh / 2;
        if (rect.height > availableAbove) {
          node.style.maxHeight = `${availableAbove}px`;
        }
      }
    }

    requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    const observer = new MutationObserver(() => requestAnimationFrame(reposition));
    observer.observe(node, { childList: true, subtree: true });

    return {
      destroy() {
        window.removeEventListener('resize', reposition);
        window.removeEventListener('scroll', reposition, true);
        observer.disconnect();
      },
    };
  }
</script>

<div class="dropdown-wrapper" bind:this={wrapperRef}>
  <button
    class={`filter-btn ${buttonClass}`}
    class:has-filter={hasFilter}
    onclick={(e) => {
      e.stopPropagation();
      onOpenChange(!open);
    }}
    {title}
  >
    <Icon name={iconName} size={16} />
    <span class="filter-label">{label}</span>
    {#if showChevron}
      <Icon name="chevron-down" size={12} />
    {/if}
  </button>

  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="popover" use:viewportAware onclick={(e) => e.stopPropagation()}>
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .dropdown-wrapper {
    position: relative;
  }

  .filter-btn {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: none;
    border: none;
    padding: 0.4rem 0.6rem;
    border-radius: 999px;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    transition: all 0.2s ease;
  }

  .filter-btn:hover {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .filter-btn.has-filter {
    color: var(--color-primary, #2563eb);
    background: rgba(37, 99, 235, 0.08);
  }

  .filter-label {
    white-space: nowrap;
  }

  .popover {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 200px;
    max-width: 280px;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    z-index: 100;
    overflow: hidden;
    max-height: 520px;
    overflow-y: auto;
  }

  @media (max-width: 900px) {
    .filter-label {
      display: none;
    }
    .filter-btn {
      padding: 0.4rem;
    }
  }

  @media (prefers-color-scheme: dark) {
    .filter-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }
    .filter-btn.has-filter {
      background: rgba(37, 99, 235, 0.2);
    }
    .popover {
      background: var(--color-bg, #1a1a1a);
    }
  }
</style>
