import { describe, it, expect } from 'vitest';
import { frameAncestorsFor, workspaceShellsFor } from './shells';

describe('workspace shells', () => {
  it('lets the atworkplace shell frame staging', () => {
    expect(frameAncestorsFor('staging.skyreader.app')).toBe(
      'https://atworkplace-shell.strand-source.workers.dev'
    );
  });

  it('keeps production and unknown hosts unframeable', () => {
    for (const host of ['skyreader.app', 'staging-prod.skyreader.app', 'evil.example']) {
      expect(workspaceShellsFor(host)).toEqual([]);
      expect(frameAncestorsFor(host)).toBe("'none'");
    }
  });
});
