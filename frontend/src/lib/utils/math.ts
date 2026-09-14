/**
 * TeX blocks, rendered late.
 *
 * Both document renderers are synchronous and sit on the card path
 * (`getDisplayContent`), so importing a TeX parser at module scope would put ~250 KB
 * of it in front of every reader whether or not anything they read contains math.
 * Instead a math block renders as its own source in a `<pre>` — legible on its own,
 * and what stays on screen with no JS — and the `mathRender` action swaps in MathML
 * once the parser has loaded, on the surfaces that hydrate document HTML.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** The pre-hydration form: the TeX itself, carried on the element for the action. */
export function renderMathPlaceholder(tex: string): string {
  if (!tex) return '';
  const escaped = escapeHtml(tex);
  return `<div class="op-math" data-tex="${escaped}"><pre class="op-math-fallback"><code>${escaped}</code></pre></div>`;
}
