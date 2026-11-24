import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ add: vi.fn(() => 1), update: vi.fn(), remove: vi.fn() }));
const render = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/toast.svelte', () => ({ toastStore: toast }));
vi.mock('$lib/utils/textShot', () => ({ renderTextShot: render }));

import { highlightImageName, saveHighlightImage } from './highlightImage';

describe('highlightImageName', () => {
  it('names the file after the article', () => {
    expect(highlightImageName('The Reading Room: Notes', 'image/png')).toBe(
      'skyreader-quote-the-reading-room-notes.png'
    );
  });

  it('folds accents and drops what a file name cannot carry', () => {
    expect(highlightImageName('Café / “Déjà vu”?', 'image/png')).toBe(
      'skyreader-quote-cafe-deja-vu.png'
    );
  });

  it('matches the extension to a JPEG fallback', () => {
    expect(highlightImageName('Long one', 'image/jpeg')).toBe('skyreader-quote-long-one.jpg');
  });

  it('falls back to a bare name without a usable title', () => {
    expect(highlightImageName(undefined, 'image/png')).toBe('skyreader-quote.png');
    expect(highlightImageName('日本語', 'image/png')).toBe('skyreader-quote.png');
  });

  it('keeps a long title short, without a trailing dash', () => {
    const name = highlightImageName('word '.repeat(40), 'image/png');
    expect(name.length).toBeLessThanOrEqual('skyreader-quote-.png'.length + 60);
    expect(name).not.toMatch(/-\.png$/);
  });
});

describe('saveHighlightImage', () => {
  let clicked: string[];
  let share: ReturnType<typeof vi.fn>;

  function setup({ touch, canShare = true }: { touch: boolean; canShare?: boolean }) {
    clicked = [];
    share = vi.fn(async () => {});
    vi.stubGlobal('window', { matchMedia: () => ({ matches: touch }) });
    vi.stubGlobal('navigator', { share, canShare: () => canShare });
    vi.stubGlobal('document', {
      createElement: () => {
        const a = {
          href: '',
          download: '',
          click: () => clicked.push(a.download),
          remove: () => {},
        };
        return a;
      },
      body: { appendChild: () => {} },
    });
    URL.createObjectURL = () => 'blob:x';
    URL.revokeObjectURL = () => {};
  }

  beforeEach(() => {
    vi.clearAllMocks();
    render.mockResolvedValue({ blob: new Blob(['x'], { type: 'image/png' }), width: 1, height: 1 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const source = { url: 'https://example.com/a', title: 'An Essay' };

  it('downloads on a desktop', async () => {
    setup({ touch: false });
    await saveHighlightImage('A passage', source);
    expect(clicked).toEqual(['skyreader-quote-an-essay.png']);
    expect(share).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith('A passage', { title: 'An Essay', domain: 'example.com' });
  });

  it('opens the share sheet on a phone', async () => {
    setup({ touch: true });
    await saveHighlightImage('A passage', source);
    expect(share).toHaveBeenCalledTimes(1);
    expect(clicked).toEqual([]);
  });

  it('downloads on a phone that cannot share files', async () => {
    setup({ touch: true, canShare: false });
    await saveHighlightImage('A passage', source);
    expect(clicked).toHaveLength(1);
  });

  it('says nothing when the sheet is closed', async () => {
    setup({ touch: true });
    share.mockRejectedValue(Object.assign(new Error(), { name: 'AbortError' }));
    await saveHighlightImage('A passage', source);
    expect(clicked).toEqual([]);
    expect(toast.update).not.toHaveBeenCalled();
  });

  it('offers a Share button when the tap’s permission ran out', async () => {
    setup({ touch: true });
    share.mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotAllowedError' }));
    await saveHighlightImage('A passage', source);
    expect(clicked).toEqual([]);
    const action = toast.update.mock.calls[0][3] as { label: string; run: () => void };
    expect(action.label).toBe('Share');
    action.run();
    expect(share).toHaveBeenCalledTimes(2);
  });

  it('downloads when the Share button can’t share either', async () => {
    setup({ touch: true });
    share.mockRejectedValue(Object.assign(new Error(), { name: 'NotAllowedError' }));
    await saveHighlightImage('A passage', source);
    const action = toast.update.mock.calls[0][3] as { run: () => void };
    action.run();
    await vi.waitFor(() => expect(clicked).toHaveLength(1));
  });

  it('never leaves the drawing toast up when saving throws', async () => {
    setup({ touch: true });
    vi.stubGlobal('navigator', {
      share,
      canShare: () => {
        throw new TypeError('old engine');
      },
    });
    await saveHighlightImage('A passage', source);
    expect(toast.update).toHaveBeenCalledWith(1, 'error', 'Couldn’t save the image');
  });

  it('downloads when sharing fails some other way', async () => {
    setup({ touch: true });
    share.mockRejectedValue(new TypeError('nope'));
    await saveHighlightImage('A passage', source);
    expect(clicked).toHaveLength(1);
  });

  it('ignores a second tap while one is under way', async () => {
    setup({ touch: false });
    await Promise.all([
      saveHighlightImage('A passage', source),
      saveHighlightImage('A passage', source),
    ]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveLength(1);
  });

  it('toasts when the image can’t be drawn', async () => {
    setup({ touch: false });
    render.mockRejectedValue(new Error('canvas unavailable'));
    await saveHighlightImage('A passage', source);
    expect(toast.update).toHaveBeenCalledWith(1, 'error', 'Couldn’t make the image');
    expect(clicked).toEqual([]);
  });

  it('does nothing for an empty passage', async () => {
    setup({ touch: false });
    await saveHighlightImage('   ', source);
    expect(render).not.toHaveBeenCalled();
  });
});
