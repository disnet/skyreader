import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SHELL = 'https://atworkplace-shell.strand-source.workers.dev';

// Loads frame.ts fresh in a fake frame: `parent` and `self` differ when framed.
async function detect(opts: {
  framed?: boolean;
  ancestor?: string;
  referrer?: string;
  stored?: Record<string, string>;
}) {
  const store = new Map(Object.entries(opts.stored ?? {}));
  const win: { parent?: unknown } = {};
  win.parent = opts.framed === false ? win : {};
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', {
    host: 'staging.skyreader.app',
    origin: 'https://staging.skyreader.app',
    ancestorOrigins: opts.ancestor ? [opts.ancestor] : undefined,
  });
  vi.stubGlobal('document', { referrer: opts.referrer ?? '' });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
  vi.resetModules();
  const { workspaceShellOrigin } = await import('./frame');
  return { origin: workspaceShellOrigin(), store };
}

describe('workspaceShellOrigin', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('is null at top level', async () => {
    expect((await detect({ framed: false, ancestor: SHELL })).origin).toBeNull();
  });

  it('finds a listed shell through ancestorOrigins or the referrer, and remembers it', async () => {
    expect((await detect({ ancestor: SHELL })).origin).toBe(SHELL);
    const viaReferrer = await detect({ referrer: `${SHELL}/?preset=demo` });
    expect(viaReferrer.origin).toBe(SHELL);
    expect(viaReferrer.store.get('skyreader-workspace-shell')).toBe(SHELL);
  });

  it('ignores a parent that is not on the list', async () => {
    expect((await detect({ ancestor: 'https://evil.example' })).origin).toBeNull();
    expect((await detect({ referrer: 'https://evil.example/' })).origin).toBeNull();
  });

  it("falls back to the remembered shell once Firefox's referrer names Skyreader", async () => {
    const { origin } = await detect({
      referrer: 'https://staging.skyreader.app/home',
      stored: { 'skyreader-workspace-shell': SHELL },
    });
    expect(origin).toBe(SHELL);
  });
});
