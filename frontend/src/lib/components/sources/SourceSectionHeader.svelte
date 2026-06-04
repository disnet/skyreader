<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    icon: string;
    title: string;
    subtitle: string;
    count: number;
    collapsed: boolean;
    onToggle: () => void;
  }

  let { icon, title, subtitle, count, collapsed, onToggle }: Props = $props();
</script>

<button class="section-header" class:collapsed onclick={onToggle} aria-expanded={!collapsed}>
  <Icon name="chevron-down" size={16} />
  <span class="section-icon"><Icon name={icon as any} size={15} /></span>
  <span class="section-title">{title}</span>
  <span class="section-count">{count}</span>
  <span class="section-subtitle">{subtitle}</span>
</button>

<style>
  .section-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.25rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text);
    text-align: left;
  }

  .section-header > :global(svg:first-child) {
    flex-shrink: 0;
    color: var(--color-text-secondary);
    transition: transform 0.15s ease;
  }

  .section-header.collapsed > :global(svg:first-child) {
    transform: rotate(-90deg);
  }

  .section-icon {
    display: flex;
    align-items: center;
    color: var(--color-text-secondary);
  }

  .section-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
  }

  .section-count {
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.05));
    padding: 0.0625rem 0.375rem;
    border-radius: 999px;
    min-width: 1.25rem;
    text-align: center;
  }

  .section-subtitle {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    margin-left: auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .section-header:hover .section-title {
    color: var(--color-primary);
  }

  @media (prefers-color-scheme: dark) {
    .section-count {
      background: var(--color-bg-secondary, rgba(255, 255, 255, 0.08));
    }
  }
</style>
