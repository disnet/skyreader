<script lang="ts">
  // The desktop home of the channel editor; the mobile filter sheet hosts the same one.
  import Modal from '$lib/components/common/Modal.svelte';
  import ChannelEditor from '$lib/components/feed/ChannelEditor.svelte';
  import type { SourceFilter } from '$lib/utils/sourceFilter';

  interface Props {
    open: boolean;
    editingViewId: number | null;
    initialChannelType?: 'feed' | 'saved' | null;
    /** A new channel's sources to start from (the toolbar's filters). */
    initialSourceFilter?: SourceFilter | null;
    onclose: () => void;
    oncreated?: (uuid: string) => void;
    ondeleted?: () => void;
  }

  let {
    open,
    editingViewId,
    initialChannelType = null,
    initialSourceFilter = null,
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
      {initialSourceFilter}
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
