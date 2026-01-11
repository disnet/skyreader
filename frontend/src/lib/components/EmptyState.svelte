<script lang="ts">
  interface Props {
    title: string;
    description: string;
    actionHref?: string;
    actionText?: string;
    icon?: string;
  }

  let { title, description, actionHref, actionText, icon }: Props = $props();
</script>

<div class="empty-state">
  {#if icon}
    <span class="icon">{icon}</span>
  {/if}
  <h2>{title}</h2>
  <p>{description}</p>
  {#if actionHref && actionText}
    <a href={actionHref} class="btn btn-primary">{actionText}</a>
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
    margin-bottom: 1rem;
  }
</style>
