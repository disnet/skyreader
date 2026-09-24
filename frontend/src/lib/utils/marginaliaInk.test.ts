import { describe, expect, it } from 'vitest';
import {
  INK_VARIANTS,
  bracketPath,
  buildInkStylesheet,
  inkVariant,
  leaderPath,
  seededRandom,
} from './marginaliaInk';

describe('marginalia ink', () => {
  it('draws the same line from the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("gives a highlight one stable stroke variant, so a page doesn't shimmer on re-layout", () => {
    const ids = ['lq2x9a', 'm0abc1', 'z', 'seed-poverty', '1790188354395xyz'];
    for (const id of ids) {
      const v = inkVariant(id);
      expect(v).toBe(inkVariant(id));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(INK_VARIANTS);
    }
  });

  it('keeps a bracket and its leader identical across re-measures', () => {
    expect(bracketPath('abc', 60)).toBe(bracketPath('abc', 60));
    expect(bracketPath('abc', 60)).not.toBe(bracketPath('abd', 60));
    expect(leaderPath('abc', 20, 80)).toBe(leaderPath('abc', 20, 80));
    // A single line gets a short tick; its path is still well-formed.
    expect(bracketPath('abc', 20)).toMatch(/^M[\d.-]+ [\d.-]+/);
  });

  it('builds every variant for both themes', () => {
    const css = buildInkStylesheet();
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    for (let v = 0; v < INK_VARIANTS; v++) {
      for (const piece of ['l', 'm', 'r']) {
        // Once per theme.
        expect(css.split(`--ink-${v}-rest-${piece}:`).length - 1).toBe(2);
        expect(css.split(`--ink-${v}-active-${piece}:`).length - 1).toBe(2);
      }
      expect(css).toContain(`mark.highlight[data-ink='${v}']`);
    }
    expect(css).toContain('--pencil-rest:');
    expect(css).toContain('--gloss-rule:');
    // Data URIs are fully encoded, so nothing in them can end the declaration.
    expect(css).not.toMatch(/data:image\/svg\+xml,[^")]*[<>#]/);
  });
});
