<script lang="ts">
  interface Props {
    status: 'healthy' | 'warning' | 'error';
    // Overrides the generic severity word. Worth setting wherever the severity
    // alone is ambiguous — "Erroring" and "Not crawled" are different faults that
    // would both read as "Error"/"Warning".
    label?: string;
  }

  let { status, label }: Props = $props();

  const labels: Record<string, string> = {
    healthy: 'Healthy',
    warning: 'Warning',
    error: 'Error',
  };
</script>

<span class="badge {status}">{label ?? labels[status]}</span>

<style>
  .badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .healthy {
    background: color-mix(in srgb, var(--color-success) 15%, transparent);
    color: var(--color-success);
  }

  .warning {
    background: color-mix(in srgb, var(--color-warning) 15%, transparent);
    color: var(--color-warning);
  }

  .error {
    background: color-mix(in srgb, var(--color-error) 15%, transparent);
    color: var(--color-error);
  }
</style>
