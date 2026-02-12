<script lang="ts">
  import { socialStore, FOLLOW_LIMIT } from '$lib/stores/social.svelte';
  import Modal from '$lib/components/common/Modal.svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();
</script>

<Modal {open} {onclose} title="Follow Limit Reached">
  <div class="limit-modal-content">
    <p>
      While Skyreader is in beta, you can follow up to <strong>{FOLLOW_LIMIT}</strong> accounts.
    </p>
    <p>This limit will be lifted once we're out of beta.</p>
    <p class="current-count">
      You're currently following {socialStore.inAppFollowCount} of {FOLLOW_LIMIT} accounts.
    </p>
  </div>
  {#snippet footer()}
    <button class="btn btn-primary" onclick={onclose}>Got it</button>
  {/snippet}
</Modal>

<style>
  .limit-modal-content {
    text-align: center;
  }

  .limit-modal-content p {
    margin: 0 0 1rem;
    color: var(--color-text-secondary);
  }

  .limit-modal-content p:last-child {
    margin-bottom: 0;
  }

  .limit-modal-content .current-count {
    font-size: 0.875rem;
    color: var(--color-text-tertiary);
  }
</style>
