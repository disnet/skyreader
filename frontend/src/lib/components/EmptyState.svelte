<script lang="ts">
  interface Props {
    title: string;
    description: string;
    /** Primary action as a link (navigation) */
    actionHref?: string;
    /** Primary action as a callback (in-place action). Takes precedence over actionHref. */
    onAction?: () => void;
    actionText?: string;
    icon?: string;
  }

  let { title, description, actionHref, onAction, actionText, icon }: Props = $props();
</script>

<div class="empty-state">
  {#if icon}
    <span class="icon">{icon}</span>
  {/if}
  <h2>{title}</h2>
  <p>{description}</p>
  {#if actionText}
    {#if onAction}
      <button type="button" class="empty-action" onclick={onAction}>{actionText}</button>
    {:else if actionHref}
      <a href={actionHref} class="empty-action">{actionText}</a>
    {/if}
  {/if}
</div>

<style>
  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--color-text-secondary);
  }

  .empty-state .icon {
    font-size: 3rem;
    display: block;
    margin-bottom: 1rem;
  }

  .empty-state h2 {
    font-size: 1.25rem;
    margin-bottom: 0.5rem;
    color: var(--color-text);
  }

  .empty-state p {
    margin-bottom: 1.5rem;
    max-width: 42ch;
    margin-left: auto;
    margin-right: auto;
    line-height: 1.5;
  }

  .empty-action {
    display: inline-block;
    padding: 0.5rem 1rem;
    font: inherit;
    font-weight: 500;
    line-height: 1.4;
    color: #fff;
    background: var(--color-primary);
    border: none;
    border-radius: var(--radius-md, 6px);
    text-decoration: none;
    cursor: pointer;
    transition: background-color 0.2s ease;
  }

  .empty-action:hover {
    background: var(--color-primary-dark);
  }

  .empty-action:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.35);
  }
</style>
