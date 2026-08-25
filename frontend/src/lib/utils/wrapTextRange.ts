/** Wrap only the text nodes intersecting a range, preserving the article's element tree. */
export function wrapTextRange(
  range: Range,
  container: HTMLElement,
  createMark: () => HTMLElement
): HTMLElement[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    if (range.intersectsNode(node)) nodes.push(node as Text);
    node = walker.nextNode();
  }

  const marks: HTMLElement[] = [];
  for (const textNode of nodes) {
    const part = document.createRange();
    part.setStart(textNode, textNode === range.startContainer ? range.startOffset : 0);
    part.setEnd(
      textNode,
      textNode === range.endContainer ? range.endOffset : (textNode.textContent?.length ?? 0)
    );
    if (!part.toString()) continue;
    const mark = createMark();
    try {
      part.surroundContents(mark);
      marks.push(mark);
    } catch {
      // Decorations are best-effort; never mutate broader article structure.
    }
  }
  return marks;
}
