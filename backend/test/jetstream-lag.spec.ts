import { describe, it, expect } from 'vitest';
import {
  cursorAdvanceMs,
  documentDrainProvesCurrent,
  isPastCursor,
  streamLagMs,
} from '../src/durable-objects/jetstream-poller';

// The firehose lag metric: time since the most recent proof the stream was
// current, from either a drain or a fresh event. Both real traffic patterns broke
// a single-signal version of this. Cursor age alone reported a 36h lag on a
// staging poller doing clean 3s cycles, because nobody had written the collection
// in 36h. Drains alone reported climbing lag on a production stream busy enough
// that no 2s gap ever landed inside the 8s poll window.

const NOW = 1_700_000_000_000;
const usAt = (ms: number) => (ms * 1000).toString();

describe('streamLagMs', () => {
  it('trusts a recent drain over a frozen cursor', () => {
    // Staging: nobody wrote the collection in 36h, but the stream drained a minute
    // ago, so it is current and the cursor's age means nothing.
    const cursor = usAt(NOW - 36 * 60 * 60 * 1000);
    expect(streamLagMs(NOW - 60_000, cursor, NOW)).toBe(60_000);
  });

  it('trusts a fresh cursor over a stale drain', () => {
    // Production: a collection busy enough that no 2s gap falls inside the 8s poll
    // window never exits idle, so it has no recent drain while being fully caught
    // up. Without this, lag climbs from the moment of deploy.
    expect(streamLagMs(NOW - 6 * 60 * 60 * 1000, usAt(NOW - 500), NOW)).toBe(500);
  });

  it('climbs only when neither signal is current', () => {
    // Genuinely behind: draining a backlog, so the cursor sits on the old events
    // being worked through and cycles end on the poll timeout, never idle.
    expect(streamLagMs(NOW - 20 * 60_000, usAt(NOW - 18 * 60_000), NOW)).toBe(18 * 60_000);
    // Jetstream unreachable: no events and no drains, both climbing together.
    expect(streamLagMs(NOW - 30 * 60_000, usAt(NOW - 30 * 60_000), NOW)).toBe(30 * 60_000);
  });

  it('uses whichever signal exists when only one does', () => {
    expect(streamLagMs(null, usAt(NOW - 5_000), NOW)).toBe(5_000);
    expect(streamLagMs(undefined, usAt(NOW - 5_000), NOW)).toBe(5_000);
    expect(streamLagMs(NOW - 5_000, null, NOW)).toBe(5_000);
  });

  it('reports unknown rather than zero when there is nothing to measure', () => {
    // decideLagAlert treats null as "not high lag": a stream that has never polled
    // should not page, and the cron heartbeat covers a dead poller.
    expect(streamLagMs(null, null, NOW)).toBeNull();
    expect(streamLagMs(null, undefined, NOW)).toBeNull();
  });

  it('ignores an unusable cursor', () => {
    expect(streamLagMs(null, 'not-a-number', NOW)).toBeNull();
    expect(streamLagMs(null, '0', NOW)).toBeNull();
    expect(streamLagMs(null, '-1', NOW)).toBeNull();
  });

  it('never reports negative lag', () => {
    // Clock skew between the DO and Jetstream's timestamps, either direction.
    expect(streamLagMs(NOW + 5_000, null, NOW)).toBe(0);
    expect(streamLagMs(null, usAt(NOW + 5_000), NOW)).toBe(0);
  });

  it('treats a zeroed caught-up stamp as absent', () => {
    // Defensive: a 0 from corrupt storage must not read as "current since epoch".
    expect(streamLagMs(0, usAt(NOW - 5_000), NOW)).toBe(5_000);
  });
});

// A cycle's progress in stream time, carried on the lag alert: under a minute per
// one-minute cycle means the drain is losing ground on its backlog.
describe('cursorAdvanceMs', () => {
  it('measures how far the cursor moved, in ms', () => {
    expect(cursorAdvanceMs(usAt(NOW - 90_000), usAt(NOW - 30_000))).toBe(60_000);
  });

  it('is zero for a cycle that finished nothing', () => {
    expect(cursorAdvanceMs(usAt(NOW), usAt(NOW))).toBe(0);
  });

  it('is unknown without a starting cursor', () => {
    expect(cursorAdvanceMs(undefined, usAt(NOW))).toBeNull();
    expect(cursorAdvanceMs('garbage', usAt(NOW))).toBeNull();
  });
});

describe('documentDrainProvesCurrent', () => {
  const clean = {
    opened: true,
    exit: 'idle' as const,
    received: 20,
    handled: 20,
    viaFrame: true,
    readPastCursor: true,
  };

  it('trusts a clean drain that read past its cursor', () => {
    expect(documentDrainProvesCurrent(clean)).toBe(true);
  });

  // 2026-11-24: the cursor event replayed, 2s of silence, "caught up" — for 22.5h.
  it('does not trust an empty drain on a frame-filtered stream', () => {
    expect(
      documentDrainProvesCurrent({ ...clean, received: 1, handled: 1, readPastCursor: false })
    ).toBe(false);
  });

  it('still trusts an empty drain on a URL-filtered stream, where quiet is ordinary', () => {
    expect(
      documentDrainProvesCurrent({
        ...clean,
        viaFrame: false,
        received: 1,
        handled: 1,
        readPastCursor: false,
      })
    ).toBe(true);
  });

  it('never trusts a timed-out, unopened or unfinished cycle', () => {
    expect(documentDrainProvesCurrent({ ...clean, exit: 'poll-timeout' })).toBe(false);
    expect(documentDrainProvesCurrent({ ...clean, opened: false })).toBe(false);
    expect(documentDrainProvesCurrent({ ...clean, handled: 19 })).toBe(false);
  });
});

describe('isPastCursor', () => {
  it('excludes the event at the cursor, which Jetstream replays every cycle', () => {
    expect(isPastCursor('1795000000000000', 1795000000000000)).toBe(false);
    expect(isPastCursor('1795000000000000', 1794999999999999)).toBe(false);
  });

  it('counts any later event, even one under a millisecond later', () => {
    expect(isPastCursor('1795000000000000', 1795000000000400)).toBe(true);
  });

  it('counts everything on a first cycle with no cursor, and nothing without a time', () => {
    expect(isPastCursor(undefined, 1)).toBe(true);
    expect(isPastCursor('1795000000000000', undefined)).toBe(false);
  });
});
