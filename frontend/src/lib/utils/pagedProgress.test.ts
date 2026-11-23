import { afterEach, describe, expect, it, vi } from 'vitest';
import { debouncedWrite, lastIndexOnOrBefore, paragraphCache, stillLaidOut } from './pagedProgress';

const id = (page: number) => page;

describe('lastIndexOnOrBefore', () => {
  it('finds the last element starting on or before the page', () => {
    const pages = [0, 0, 1, 1, 1, 2, 4, 4];
    expect(lastIndexOnOrBefore(pages, 0, id)).toBe(1);
    expect(lastIndexOnOrBefore(pages, 1, id)).toBe(4);
    expect(lastIndexOnOrBefore(pages, 3, id)).toBe(5);
    expect(lastIndexOnOrBefore(pages, 9, id)).toBe(7);
  });

  it('falls back to 0 when nothing starts that early', () => {
    expect(lastIndexOnOrBefore([2, 3], 1, id)).toBe(0);
    expect(lastIndexOnOrBefore([], 1, id)).toBe(0);
  });

  it('matches a linear scan', () => {
    const pages = Array.from({ length: 500 }, (_, i) => Math.floor(i / 7));
    for (let page = 0; page < 80; page++) {
      let linear = 0;
      pages.forEach((p, i) => {
        if (p <= page) linear = i;
      });
      expect(lastIndexOnOrBefore(pages, page, id)).toBe(linear);
    }
  });

  it('measures only a logarithmic number of elements', () => {
    const pages = Array.from({ length: 10_000 }, (_, i) => Math.floor(i / 10));
    let reads = 0;
    lastIndexOnOrBefore(pages, 500, (p) => (reads++, p));
    expect(reads).toBeLessThanOrEqual(15);
  });
});

describe('stillLaidOut', () => {
  const el = (isConnected: boolean) => ({ isConnected }) as Element;

  it('is false for an empty list', () => {
    expect(stillLaidOut([])).toBe(false);
  });

  it('is true while the first and last are in the document', () => {
    expect(stillLaidOut([el(true), el(true), el(true)])).toBe(true);
  });

  it('is false once the body was drawn again and the old paragraphs left', () => {
    expect(stillLaidOut([el(false), el(false)])).toBe(false);
    expect(stillLaidOut([el(true), el(false)])).toBe(false);
  });

  it('is false when one block in the middle was replaced', () => {
    expect(stillLaidOut([el(true), el(false), el(true)])).toBe(false);
  });
});

describe('paragraphCache', () => {
  const el = () => ({ isConnected: true }) as unknown as HTMLElement;
  const root = {} as Element;

  it('finds the paragraphs once per body and root', () => {
    const paras = [el(), el()];
    const find = vi.fn(() => paras);
    const cached = paragraphCache();
    expect(cached(root, 'a', find)).toBe(paras);
    expect(cached(root, 'a', find)).toBe(paras);
    expect(find).toHaveBeenCalledTimes(1);
    cached(root, 'b', find);
    cached({} as Element, 'b', find);
    expect(find).toHaveBeenCalledTimes(3);
  });

  it('finds them again once one has left the page, and none without a root', () => {
    const gone = { isConnected: true };
    const find = vi.fn(() => [gone as unknown as HTMLElement]);
    const cached = paragraphCache();
    cached(root, 'a', find);
    gone.isConnected = false;
    cached(root, 'a', find);
    expect(find).toHaveBeenCalledTimes(2);
    expect(cached(null, 'a', find)).toEqual([]);
    expect(find).toHaveBeenCalledTimes(2);
  });
});

describe('debouncedWrite', () => {
  afterEach(() => vi.useRealTimers());

  it('writes only the last of a run, after the wait', () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    const save = debouncedWrite(500);
    save.schedule(() => writes.push(1));
    save.schedule(() => writes.push(2));
    vi.advanceTimersByTime(499);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([2]);
    expect(save.flush()).toBe(false);
  });

  it('writes a waiting write at once on flush, and only once', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const save = debouncedWrite(500);
    save.schedule(write);
    expect(save.flush()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(save.flush()).toBe(false);
  });

  it('schedules again after a flush', () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    const save = debouncedWrite(500);
    save.schedule(() => writes.push(1));
    save.flush();
    save.schedule(() => writes.push(2));
    vi.advanceTimersByTime(500);
    expect(writes).toEqual([1, 2]);
  });
});
