import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import shellMedia from '../../../postcss.shell-media.js';
import colorScheme from '../../../postcss.color-scheme.js';
import { SHELL_FRAMED_QUERY, SHELL_MOBILE_QUERY } from './shellMedia.js';

async function run(css: string): Promise<string> {
  const result = await postcss([shellMedia(), colorScheme()]).process(css, { from: 'app.css' });
  return result.css.replace(/\s+/g, ' ').trim();
}

describe('postcss.shell-media', () => {
  it('expands both named queries', async () => {
    expect(await run('@media (--shell-framed) { .a { color: red } }')).toBe(
      `@media ${SHELL_FRAMED_QUERY} { .a { color: red } }`
    );
    expect(await run('@media (--shell-mobile) { .a { color: red } }')).toBe(
      `@media ${SHELL_MOBILE_QUERY} { .a { color: red } }`
    );
  });

  it('leaves other queries alone, and still splits a dark block nested inside', async () => {
    const out = await run(
      '@media (max-width: 640px) { .b { x: 1 } } @media (--shell-mobile) { @media (prefers-color-scheme: dark) { .a { color: white } } }'
    );
    expect(out).toContain('@media (max-width: 640px) { .b { x: 1 } }');
    expect(out).toContain(`@media ${SHELL_MOBILE_QUERY}`);
    expect(out).toContain(":where(:root[data-theme='dark']) .a { color: white }");
  });

  it('refuses an unknown or combined shell query', async () => {
    await expect(run('@media (--shell-wide) { .a { x: 1 } }')).rejects.toThrow(/shell media/);
    await expect(
      run('@media (--shell-mobile) and (prefers-color-scheme: dark) { .a { x: 1 } }')
    ).rejects.toThrow(/shell media/);
  });

  it('does not treat Object.prototype keys as names', async () => {
    expect(await run('@media (toString) { .a { x: 1 } }')).toBe(
      '@media (toString) { .a { x: 1 } }'
    );
  });
});
