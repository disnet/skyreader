<script lang="ts">
  import { toastStore } from '$lib/stores/toast.svelte';
</script>

{#if toastStore.toasts.length > 0}
  <div class="toast-container">
    {#each toastStore.toasts as toast (toast.id)}
      <div class="toast toast-{toast.state}">
        {#if toast.state === 'pending'}
          <span class="spinner"></span>
        {:else if toast.state === 'success'}
          <span class="icon">&#10003;</span>
        {:else}
          <span class="icon">&#10007;</span>
        {/if}
        <span>{toast.message}</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    z-index: 300;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    font-size: 0.8125rem;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e5e7eb);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    color: var(--color-text);
    animation: slide-in 0.2s ease-out;
  }

  .toast-success {
    border-color: #22c55e;
  }

  .toast-error {
    border-color: #ef4444;
  }

  .icon {
    font-size: 0.875rem;
    line-height: 1;
  }

  .toast-success .icon {
    color: #22c55e;
  }

  .toast-error .icon {
    color: #ef4444;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--color-border, #e5e7eb);
    border-top-color: var(--color-primary, #0066cc);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes slide-in {
    from {
      opacity: 0;
      transform: translateY(0.5rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-color-scheme: dark) {
    .toast {
      background: var(--color-bg, #1a1a1a);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
  }
</style>
