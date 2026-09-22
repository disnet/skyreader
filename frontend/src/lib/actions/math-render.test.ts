// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hydrateMathIn, installScopedStyles } from './math-render';
import { renderMathPlaceholder } from '$lib/utils/math';
import { sanitizeHtml } from '$lib/utils/sanitize';

describe('math hydration', () => {
  it('renders the TeX the placeholder carries through the sanitizer', async () => {
    const host = document.createElement('div');
    // The path a reader's math actually takes: renderer → sanitizeHtml → the DOM.
    host.innerHTML = sanitizeHtml(renderMathPlaceholder('a^2 + b^2 = c^2'));
    expect(host.querySelector('.op-math')?.getAttribute('data-tex')).toBe('a^2 + b^2 = c^2');

    await hydrateMathIn(host);
    expect(host.querySelector('math')).not.toBeNull();
  });

  it('keeps the TeX source on screen when the equation will not parse', async () => {
    const host = document.createElement('div');
    host.innerHTML = renderMathPlaceholder('\\frac{');
    await hydrateMathIn(host);
    expect(host.textContent).toContain('\\frac{');
  });
});

describe('scoped Temml styles', () => {
  it('scopes rules under .op-math so native MathML elsewhere is untouched', () => {
    installScopedStyles(`
      @font-face { font-family: 'Temml'; src: url('Temml.woff2'); }
      math { display: inline-flex; }
      math > mrow, *.mathcal { padding: 0.5ex 0; }
      @supports (not (-moz-appearance: none)) { .tml-right { margin: 0; } }
      body { counter-reset: tmlEqnNo; }
    `);
    const style = [...document.head.querySelectorAll('style')].at(-1)!;
    expect(style.hasAttribute('media')).toBe(false);
    const text = style.textContent ?? '';
    expect(text).toContain('.op-math math {');
    expect(text).toContain('.op-math math > mrow, .op-math *.mathcal {');
    expect(text).toContain('.op-math .tml-right');
    expect(text).toContain('@font-face');
    expect(text).toMatch(/^body \{/m);
    expect(text).not.toMatch(/^math/m);
  });
});
