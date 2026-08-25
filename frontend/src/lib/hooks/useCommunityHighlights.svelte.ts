import { communityHighlightsStore } from '$lib/stores/communityHighlights.svelte';
import { findAllInDOM } from '$lib/utils/textSelector';
import { wrapTextRange } from '$lib/utils/wrapTextRange';
import type { CommunityHighlightGroup } from '$lib/stores/communityHighlights.svelte';

// The same comment glyph the private highlights use (Lucide message-circle), so
// a passage someone wrote a note on reads the same way whoever made it. The
// tint that tells the two apart lives in `.community-note-marker` (app.css).
const NOTE_MARKER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></svg>';

export function useCommunityHighlights(params: {
  contentEl: () => HTMLElement | undefined;
  itemUrl: () => string;
  /** Whether community marks should be drawn in the article. */
  enabled: () => boolean;
  /**
   * Whether to fetch the Margin highlights. This can stay true while drawing is
   * off so the toolbar can show how many highlights are available before the
   * reader turns them on.
   */
  load?: () => boolean;
}) {
  let marks: HTMLElement[] = [];
  let noteMarkers: HTMLElement[] = [];
  let popoverState = $state<{
    group: CommunityHighlightGroup;
    anchorRect: DOMRect;
    anchorEl: HTMLElement;
  } | null>(null);
  let wasLoadEnabled = false;
  $effect(() => {
    const url = params.itemUrl();
    const enabled = params.enabled();
    const shouldLoad = params.load?.() ?? enabled;
    const state = communityHighlightsStore.get(url);
    if (shouldLoad && url && (!state || (!wasLoadEnabled && state.failed))) {
      communityHighlightsStore.load(url, { force: state?.failed });
    }
    wasLoadEnabled = shouldLoad;
    // Reading groups here makes the decoration react when the lazy request
    // settles. Defer until Svelte has committed the current article body.
    void state?.groups;
    queueMicrotask(apply);
  });
  function clear() {
    // Note markers first, so the normalize() below can merge the text nodes they
    // were sitting between.
    for (const marker of noteMarkers) marker.remove();
    noteMarkers = [];
    for (const mark of marks) mark.replaceWith(...Array.from(mark.childNodes));
    marks = [];
    params.contentEl()?.normalize();
  }
  function handleClick(event: MouseEvent) {
    if (window.getSelection()?.toString()) return;
    // The note marker sits beside its mark rather than inside it, so it carries
    // the same group id and opens the same popover.
    const anchor = (event.target as HTMLElement).closest<HTMLElement>(
      'mark.community-highlight, .community-note-marker'
    );
    if (!anchor) return;
    const group = communityHighlightsStore
      .get(params.itemUrl())
      ?.groups.find((item) => item.id === anchor.dataset.communityId);
    if (!group) return;
    event.preventDefault();
    event.stopPropagation();
    popoverState = { group, anchorRect: anchor.getBoundingClientRect(), anchorEl: anchor };
  }
  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // The marker is a real <button>: let it fire its own click rather than
    // opening the popover twice.
    if ((event.target as HTMLElement).closest('.community-note-marker')) return;
    handleClick(event as unknown as MouseEvent);
  }
  function apply() {
    clear();
    const el = params.contentEl();
    const url = params.itemUrl();
    if (!el || !url || !params.enabled()) return;
    communityHighlightsStore.load(url);
    const groups = communityHighlightsStore.get(url)?.groups ?? [];
    const ranges = findAllInDOM(
      groups.map((g) => g.selector),
      el
    );
    for (let i = ranges.length - 1; i >= 0; i--) {
      const range = ranges[i];
      if (!range) continue;
      const names = groups[i].people.map((p) => p.displayName || p.handle || 'A reader');
      const created = wrapTextRange(range, el, () => {
        const mark = document.createElement('mark');
        mark.className = 'community-highlight';
        mark.dataset.communityId = groups[i].id;
        mark.title = `${names.join(', ')} on margin.at`;
        mark.tabIndex = 0;
        mark.setAttribute('role', 'button');
        mark.setAttribute('aria-label', `Community highlight by ${names.join(', ')}`);
        return mark;
      });
      marks.push(...created);
      // A passage someone wrote a note on gets the inline comment glyph, so it's
      // legible as a note without opening the popover to find out.
      const lastMark = created[created.length - 1];
      if (lastMark && groups[i].people.some((person) => person.note))
        insertNoteMarker(lastMark, groups[i], names);
    }
  }
  /** Append the comment glyph immediately after a group's final mark. */
  function insertNoteMarker(
    afterMark: HTMLElement,
    group: CommunityHighlightGroup,
    names: string[]
  ) {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'community-note-marker';
    marker.dataset.communityId = group.id;
    marker.title = `${names.join(', ')} on margin.at`;
    marker.setAttribute('aria-label', `Show note by ${names.join(', ')}`);
    marker.innerHTML = NOTE_MARKER_SVG;
    afterMark.after(marker);
    noteMarkers.push(marker);
  }
  function attach() {
    params.contentEl()?.addEventListener('click', handleClick);
    params.contentEl()?.addEventListener('keydown', handleKeydown);
    apply();
  }
  function detach() {
    params.contentEl()?.removeEventListener('click', handleClick);
    params.contentEl()?.removeEventListener('keydown', handleKeydown);
    popoverState = null;
    clear();
  }
  return {
    attach,
    detach,
    apply,
    get popoverState() {
      return popoverState;
    },
    /**
     * Where the open popover's mark sits *now*. Re-applying the decorations
     * replaces the element the popover opened against, so fall back to the
     * group's first surviving mark; `null` means the passage is gone and the
     * popover has nothing left to point at.
     */
    popoverAnchorRect(): DOMRect | null {
      const state = popoverState;
      if (!state) return null;
      const el = state.anchorEl.isConnected
        ? state.anchorEl
        : (params
            .contentEl()
            ?.querySelector<HTMLElement>(
              `mark.community-highlight[data-community-id="${CSS.escape(state.group.id)}"]`
            ) ?? null);
      return el?.getBoundingClientRect() ?? null;
    },
    get capped() {
      return communityHighlightsStore.get(params.itemUrl())?.capped ?? false;
    },
    get count(): number | undefined {
      const state = communityHighlightsStore.get(params.itemUrl());
      if (!state?.loaded) return undefined;
      return state.groups.reduce((total, group) => total + group.people.length, 0);
    },
    closePopover: () => (popoverState = null),
    retry: () => communityHighlightsStore.load(params.itemUrl(), { force: true }),
  };
}
