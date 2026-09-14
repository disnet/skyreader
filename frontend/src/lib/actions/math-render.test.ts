// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hydrateMathIn } from './math-render';
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
