<script lang="ts">
  interface Props {
    message?: string;
  }

  let { message = "Loading..." }: Props = $props();
</script>

<p class="loading-state">{message}</p>

<style>
  .loading-state {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-secondary);
  }
</style>
