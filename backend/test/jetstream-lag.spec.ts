import { describe, it, expect } from 'vitest';
import { streamLagMs } from '../src/durable-objects/jetstream-poller';

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
