import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import colorScheme from '../../../postcss.color-scheme.js';
import { coerceColorScheme } from './colorScheme';

async function run(css: string, from = 'app.css'): Promise<string> {
  const result = await postcss([colorScheme()]).process(css, { from });
  return result.css.replace(/\s+/g, ' ').trim();
}

describe('postcss.color-scheme', () => {
  it('splits a dark block into an OS-dark copy and a pinned-dark copy', async () => {
    const out = await run(
      `.a { color: black } @media (prefers-color-scheme: dark) { .a { color: white } }`
    );
    expect(out).toBe(
      ".a { color: black } @media (prefers-color-scheme: dark) { :where(:root:not([data-theme='light'])) .a { color: white } } :where(:root[data-theme='dark']) .a { color: white }"
    );
  });

  it('guards the root element itself instead of nesting under it', async () => {
    const out = await run(
      `@media (prefers-color-scheme: dark) { :root { --bg: #000 } html.x { color: red } }`
    );
    expect(out).toContain(":root:where(:not([data-theme='light'])) { --bg: #000 }");
    expect(out).toContain(":root:where([data-theme='dark']) { --bg: #000 }");
    expect(out).toContain("html:where([data-theme='dark']).x { color: red }");
  });

  it('keeps the other half of a compound query on the pinned copy', async () => {
    const out = await run(
      `@media (hover: hover) and (prefers-color-scheme: dark) { .a:hover { color: white } }`
    );
    expect(out).toContain('@media (hover: hover) and (prefers-color-scheme: dark)');
    expect(out).toContain(
      "@media (hover: hover) { :where(:root[data-theme='dark']) .a:hover { color: white } }"
    );
  });

  it('guards every selector in a list', async () => {
    const out = await run(`@media (prefers-color-scheme: dark) { .a, .b { color: white } }`);
    expect(out).toContain(
      ":where(:root[data-theme='dark']) .a, :where(:root[data-theme='dark']) .b"
    );
  });

  it('wraps the guard in :global() inside a Svelte component', async () => {
    const out = await run(
      `@media (prefers-color-scheme: dark) { .a { color: white } :global(.b) { color: red } }`,
      'Card.svelte?lang.css'
    );
    expect(out).toContain(":global(:where(:root[data-theme='dark'])) .a");
    expect(out).toContain(":global(:where(:root:not([data-theme='light']))) :global(.b)");
  });

  it('is idempotent, since Vite reprocesses compiled component CSS', async () => {
    const once = await run(`@media (prefers-color-scheme: dark) { .a { color: white } }`);
    expect(await run(once, 'Card.svelte?svelte&type=style&lang.css')).toBe(once);
  });

  it('leaves light and unsplittable queries alone', async () => {
    const css = `@media (prefers-color-scheme: light) { .a { color: black } } @media not all and (prefers-color-scheme: dark) { .b { color: red } }`;
    expect(await run(css)).toBe(css.replace(/\s+/g, ' '));
  });
});

describe('coerceColorScheme', () => {
  it('defaults anything unknown to following the system', () => {
    expect(coerceColorScheme('dark')).toBe('dark');
    expect(coerceColorScheme('light')).toBe('light');
    expect(coerceColorScheme('sepia')).toBe('system');
    expect(coerceColorScheme(undefined)).toBe('system');
  });
});
