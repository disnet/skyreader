<script lang="ts">
  // The desktop home of the channel editor; the mobile filter sheet hosts the same one.
  import Modal from '$lib/components/common/Modal.svelte';
  import ChannelEditor from '$lib/components/feed/ChannelEditor.svelte';

  interface Props {
    open: boolean;
    editingViewId: number | null;
    initialChannelType?: 'feed' | 'saved' | null;
    onclose: () => void;
    oncreated?: (uuid: string) => void;
    ondeleted?: () => void;
  }

  let {
    open,
    editingViewId,
    initialChannelType = null,
    onclose,
    oncreated,
    ondeleted,
  }: Props = $props();
</script>

<Modal {open} {onclose} title={editingViewId != null ? 'Edit channel' : 'New channel'}>
  {#if open}
    <ChannelEditor
      editingChannelId={editingViewId}
      {initialChannelType}
      scrollPicker
      oncancel={onclose}
      onsaved={(created) => {
        onclose();
        if (created) oncreated?.(created);
      }}
      ondeleted={() => {
        onclose();
        ondeleted?.();
      }}
    />
  {/if}
</Modal>
