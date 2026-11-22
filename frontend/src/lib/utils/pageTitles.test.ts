import { describe, it, expect, beforeEach } from 'vitest';
import { forgetPageTitles, knownPageTitle, loadPageTitles } from './pageTitles';

describe('loadPageTitles', () => {
  beforeEach(() => forgetPageTitles());

  it('asks in chunks of 50, in order, and remembers', async () => {
    const urls = Array.from({ length: 120 }, (_, i) => `https://x.example/${i}`);
    const asked: string[][] = [];
    const got: Record<string, string> = {};
    const ask = async (chunk: string[]) => {
      asked.push(chunk);
      return { titles: { [chunk[0]]: `T${chunk[0]}` }, pending: false };
    };
    await loadPageTitles(urls, ask, (t) => Object.assign(got, t));
    expect(asked.map((c) => c.length)).toEqual([50, 50, 20]);
    expect(asked[0][0]).toBe('https://x.example/0');
    expect(Object.keys(got)).toHaveLength(3);
    expect(knownPageTitle('https://x.example/50')).toBe('Thttps://x.example/50');

    await loadPageTitles(urls, ask, () => {});
    expect(asked).toHaveLength(3); // nothing new to ask
  });

  it('asks once more for pages still being read, then settles', async () => {
    const asked: string[][] = [];
    const answers: { titles: Record<string, string>; pending: boolean }[] = [
      { titles: { 'https://a.example/': 'A' }, pending: true },
      { titles: { 'https://b.example/': 'B' }, pending: true },
    ];
    await loadPageTitles(
      ['https://a.example/', 'https://b.example/', 'https://c.example/'],
      async (chunk) => {
        asked.push(chunk);
        return answers.shift()!;
      },
      () => {},
      undefined,
      async () => {}
    );
    expect(asked).toEqual([
      ['https://a.example/', 'https://b.example/', 'https://c.example/'],
      ['https://b.example/', 'https://c.example/'],
    ]);
    expect(knownPageTitle('https://b.example/')).toBe('B');
    expect(knownPageTitle('https://c.example/')).toBeUndefined();
  });

  it('stops when aborted and survives a failed ask', async () => {
    const controller = new AbortController();
    let calls = 0;
    await loadPageTitles(
      Array.from({ length: 100 }, (_, i) => `https://y.example/${i}`),
      async () => {
        calls++;
        controller.abort();
        return { titles: {}, pending: false };
      },
      () => {},
      controller.signal
    );
    expect(calls).toBe(1);
    await expect(
      loadPageTitles(
        ['https://z.example/'],
        async () => {
          throw new Error('offline');
        },
        () => {}
      )
    ).resolves.toBeUndefined();
  });
});
