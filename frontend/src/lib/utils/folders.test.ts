import { describe, expect, it } from 'vitest';
import { caseDuplicateFolders, folderCounts, folderTarget, renameFolderKey } from './folders';

const subs = (...cats: Array<string | undefined>) => cats.map((category) => ({ category }));

describe('folders', () => {
  it('counts folders by their trimmed names', () => {
    expect(folderCounts(subs('Tech', ' Tech', undefined, '  ', 'News'))).toEqual(
      new Map([
        ['Tech', 2],
        ['News', 1],
      ])
    );
  });

  it('lands a name in a folder spelled like it but for case', () => {
    expect(folderTarget(' tech ', ['News', 'Tech'])).toBe('Tech');
    expect(folderTarget('Climate', ['News', 'Tech'])).toBe('Climate');
  });

  it('takes an exact spelling over a case match', () => {
    expect(folderTarget('Tech', ['tech', 'Tech', 'TECH'])).toBe('Tech');
    expect(folderTarget('TECH', ['tech', 'Tech', 'TECH'], 'tech')).toBe('TECH');
  });

  it('never lands a rename back in the folder being renamed', () => {
    // "tech" → "Tech" with no other "Tech": a plain re-capitalizing rename.
    expect(folderTarget('Tech', ['tech', 'News'], 'tech')).toBe('Tech');
    expect(folderTarget('TECH', ['tech', 'Tech'], 'tech')).toBe('Tech');
  });

  it('finds folders that differ only in case, keeping the fullest', () => {
    expect(caseDuplicateFolders(subs('tech', 'Tech', 'Tech', 'News', 'TECH'))).toEqual([
      { keep: 'Tech', others: ['TECH', 'tech'] },
    ]);
    expect(caseDuplicateFolders(subs('News', 'Tech'))).toEqual([]);
  });

  it('breaks a tie toward the capitalized spelling', () => {
    expect(caseDuplicateFolders(subs('tech', 'Tech'))).toEqual([
      { keep: 'Tech', others: ['tech'] },
    ]);
    expect(caseDuplicateFolders(subs('TECH', 'tech', 'Tech'))).toEqual([
      { keep: 'Tech', others: ['TECH', 'tech'] },
    ]);
  });

  it('swaps a renamed folder’s key in a channel’s sources', () => {
    const keys = ['rss~a', 'group~category~tech', 'group~category~Tech'];
    expect(renameFolderKey(keys, 'tech', 'Tech')).toEqual(['rss~a', 'group~category~Tech']);
    expect(renameFolderKey(['group~category~tech'], 'tech', 'Reading')).toEqual([
      'group~category~Reading',
    ]);
    expect(renameFolderKey(['group~category~tech'], 'tech', 'Tech', true)).toEqual([
      'group~category~tech',
      'group~category~Tech',
    ]);
    expect(renameFolderKey(['rss~a'], 'tech', 'Tech')).toBeNull();
  });
});
