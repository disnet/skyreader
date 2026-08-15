import { describe, it, expect } from 'vitest';
import { streamLagMs } from '../src/durable-objects/jetstream-poller';

// The firehose lag metric. Cursor age was the original measure and it reported a
// 36h lag on a staging poller that was polling every minute, draining in ~3s, with
// zero errors — because both streams filter on one collection, and a collection
// nobody writes to leaves its cursor frozen. Lag is now time since the stream was
// last confirmed drained, so it measures us rather than the network's activity.

const NOW = 1_700_000_000_000;
const usAt = (ms: number) => (ms * 1000).toString();

describe('streamLagMs', () => {
  it('measures from the last confirmed drain, not the cursor', () => {
    // The staging case: cursor 36h old, but the stream drained a minute ago.
    const cursor = usAt(NOW - 36 * 60 * 60 * 1000);
    expect(streamLagMs(NOW - 60_000, cursor, NOW)).toBe(60_000);
  });

  it('climbs while a stream fails to drain', () => {
    // Poll timeouts and connection failures never mark caught-up, so this is what
    // a poller that genuinely cannot keep up looks like: past the 15m threshold.
    expect(streamLagMs(NOW - 20 * 60_000, usAt(NOW), NOW)).toBe(20 * 60_000);
  });

  it('falls back to cursor age before the first drain', () => {
    expect(streamLagMs(null, usAt(NOW - 5_000), NOW)).toBe(5_000);
    expect(streamLagMs(undefined, usAt(NOW - 5_000), NOW)).toBe(5_000);
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
