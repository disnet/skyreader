// Pixel coordinates of a caret position inside a <textarea>, relative to the
// element's own border box. Used to anchor floating UI (e.g. the @mention menu)
// to where the user is actually typing rather than to the element's edges.
//
// Works by rendering a hidden <div> that mirrors the textarea's text-affecting
// styles, slicing the value at the caret, and measuring a marker span. This is
// the well-worn "textarea-caret-position" approach (component/textarea-caret).

// Styles that influence text layout and therefore the caret's position.
const MIRRORED_PROPS = [
  'direction',
  'boxSizing',
  'width',
  'height',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
] as const;

export interface CaretCoordinates {
  /** Offset from the textarea's top border to the caret line's top, in px. */
  top: number;
  /** Offset from the textarea's left border to the caret, in px. */
  left: number;
  /** The caret line's height (line-height), in px. */
  height: number;
}

export function getCaretCoordinates(
  element: HTMLTextAreaElement,
  position: number
): CaretCoordinates {
  const div = document.createElement('div');
  document.body.appendChild(div);

  const style = div.style;
  const computed = window.getComputedStyle(element);

  style.whiteSpace = 'pre-wrap';
  style.wordWrap = 'break-word';
  style.position = 'absolute';
  style.visibility = 'hidden';

  for (const prop of MIRRORED_PROPS) {
    // computed is indexable by these CSS prop names; copy each through.
    style[prop as any] = computed[prop as any];
  }

  div.textContent = element.value.slice(0, position);

  // A marker at the caret. The trailing '.' guards against an empty tail (so the
  // span still has layout when the caret is at the very end).
  const span = document.createElement('span');
  span.textContent = element.value.slice(position) || '.';
  div.appendChild(span);

  const coordinates: CaretCoordinates = {
    top: span.offsetTop + parseInt(computed.borderTopWidth, 10),
    left: span.offsetLeft + parseInt(computed.borderLeftWidth, 10),
    height: parseInt(computed.lineHeight, 10) || parseInt(computed.fontSize, 10),
  };

  document.body.removeChild(div);
  return coordinates;
}
