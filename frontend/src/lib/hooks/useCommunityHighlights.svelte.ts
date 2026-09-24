import { communityHighlightsStore } from '$lib/stores/communityHighlights.svelte';
import { findAllInDOM } from '$lib/utils/textSelector';
import { wrapTextRange } from '$lib/utils/wrapTextRange';
import type { CommunityHighlightGroup } from '$lib/stores/communityHighlights.svelte';
import { GLOSS_MARKER_SVG } from '$lib/utils/marginaliaInk';

export function useCommunityHighlights(params: {
  contentEl: () => HTMLElement | undefined;
  itemUrl: () => string;
  /** Whether community marks should be drawn in the article. */
  enabled: () => boolean;
  /** The notes are drawn in the page margin, so no inline note marker. */
  inMargin?: () => boolean;
}) {
  let marks: HTMLElement[] = [];
  let noteMarkers: HTMLElement[] = [];
  let popoverState = $state<{
    group: CommunityHighlightGroup;
    anchorRect: DOMRect;
    anchorEl: HTMLElement;
  } | null>(null);
  // Bumped whenever the marks are re-drawn, so the margin can re-measure.
  let version = $state(0);
  let wasLoadEnabled = false;
  $effect(() => {
    const url = params.itemUrl();
    const enabled = params.enabled();
    const state = communityHighlightsStore.get(url);
    if (enabled && url && (!state || (!wasLoadEnabled && state.failed))) {
      communityHighlightsStore.load(url, { force: state?.failed });
    }
    wasLoadEnabled = enabled;
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
      if (lastMark && groups[i].people.some((person) => person.note) && !params.inMargin?.())
        insertNoteMarker(lastMark, groups[i], names);
    }
    version++;
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
    // The reader's gloss asterisk, in pencil (`.marginalia-ink .community-note-marker`).
    marker.innerHTML = GLOSS_MARKER_SVG;
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
    /** Bumped on every re-draw of the marks. */
    get version() {
      return version;
    },
    get groups(): CommunityHighlightGroup[] {
      return communityHighlightsStore.get(params.itemUrl())?.groups ?? [];
    },
    /** Open a group's popover from outside the text (its note in the margin). */
    open(groupId: string, anchorEl: HTMLElement) {
      const group = communityHighlightsStore
        .get(params.itemUrl())
        ?.groups.find((item) => item.id === groupId);
      if (group) popoverState = { group, anchorRect: anchorEl.getBoundingClientRect(), anchorEl };
    },
    /** Light up one group's marks (and only those). */
    setActive(groupId: string | null) {
      for (const mark of marks) {
        mark.classList.toggle('is-active', !!groupId && mark.dataset.communityId === groupId);
      }
    },
    get capped() {
      return communityHighlightsStore.get(params.itemUrl())?.capped ?? false;
    },
    closePopover: () => (popoverState = null),
  };
}
