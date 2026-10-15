<script lang="ts">
  // The desktop home of the channel editor; the mobile filter sheet hosts the same one.
  import Modal from '$lib/components/common/Modal.svelte';
  import ChannelEditor from '$lib/components/feed/ChannelEditor.svelte';
  import { MediaQuery } from 'svelte/reactivity';

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

  // On a phone the modal is nearly the whole screen, so the source list grows
  // into the modal's own scroll rather than nesting a second scroller inside it.
  const narrow = new MediaQuery('max-width: 640px');
</script>

<!-- No bottom padding: the pinned Save row brings its own, and a padded body
     would let rows scroll past underneath it. -->
<Modal
  {open}
  {onclose}
  title={editingViewId != null ? 'Edit channel' : 'New channel'}
  bodyPadding={narrow.current ? '1rem 1rem 0' : '1.5rem 1.5rem 0'}
>
  {#if open}
    <ChannelEditor
      editingChannelId={editingViewId}
      {initialChannelType}
      scrollPicker={!narrow.current}
      pinActions
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
