import { describe, expect, it } from 'vitest';
import {
  DESK_LIMIT,
  EMPTY_DESK,
  addToDesk,
  noteOpened,
  parseDesk,
  previousPiece,
  removeFromDesk,
  type DeskEntry,
} from './desk';

const entry = (key: string, title = key.toUpperCase()): DeskEntry => ({
  key,
  title,
  source: 'example.com',
  progressKeys: [key],
});

describe('the Desk', () => {
  it('adds in order, refreshes an entry already there, and refuses past the limit', () => {
    let desk = addToDesk(EMPTY_DESK, entry('a'))!;
    desk = addToDesk(desk, entry('b'))!;
    expect(desk.entries.map((e) => e.key)).toEqual(['a', 'b']);

    desk = addToDesk(desk, entry('a', 'Renamed'))!;
    expect(desk.entries.map((e) => e.title)).toEqual(['Renamed', 'B']);

    for (let i = desk.entries.length; i < DESK_LIMIT; i++) desk = addToDesk(desk, entry(`x${i}`))!;
    expect(addToDesk(desk, entry('one-too-many'))).toBeNull();
    // Re-adding one that's there still works when full.
    expect(addToDesk(desk, entry('a'))).not.toBeNull();
  });

  it('removes, and leaves the state alone when the key is not there', () => {
    const desk = addToDesk(EMPTY_DESK, entry('a'))!;
    expect(removeFromDesk(desk, 'a').entries).toEqual([]);
    expect(removeFromDesk(desk, 'nope')).toBe(desk);
  });

  it('remembers the last two pieces opened, for the toggle', () => {
    let desk = noteOpened(EMPTY_DESK, entry('a'));
    expect(previousPiece(desk, 'a')).toBeNull();
    desk = noteOpened(desk, entry('b'));
    expect(previousPiece(desk, 'b')?.key).toBe('a');
    desk = noteOpened(desk, entry('a'));
    expect(previousPiece(desk, 'a')?.key).toBe('b');
    desk = noteOpened(desk, entry('c'));
    expect(desk.recent.map((e) => e.key)).toEqual(['c', 'a']);
  });

  it('noting the open piece again is a no-op, and refreshes its Desk row when it changed', () => {
    let desk = addToDesk(EMPTY_DESK, entry('a', 'Loading'))!;
    desk = noteOpened(desk, entry('a', 'Loading'));
    expect(noteOpened(desk, entry('a', 'Loading'))).toBe(desk);
    desk = noteOpened(desk, entry('a', 'The real title'));
    expect(desk.entries[0].title).toBe('The real title');
    expect(desk.recent[0].title).toBe('The real title');
  });

  it('reads back a stored Desk, dropping what is malformed or repeated', () => {
    expect(parseDesk(null)).toEqual(EMPTY_DESK);
    expect(parseDesk('nope')).toEqual(EMPTY_DESK);
    const parsed = parseDesk({
      entries: [
        entry('a'),
        { key: 'b' },
        entry('a'),
        entry('c'),
        { ...entry('d'), progressKeys: [1] },
      ],
      recent: [entry('c'), entry('a'), entry('z')],
    });
    expect(parsed.entries.map((e) => e.key)).toEqual(['a', 'c']);
    expect(parsed.recent.map((e) => e.key)).toEqual(['c', 'a']);
  });
});
