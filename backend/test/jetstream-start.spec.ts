import { describe, it, expect } from 'vitest';
import {
  decideStartAction,
  ALARM_ACTIVE_WINDOW_MS,
  STUCK_ALARM_GRACE_MS,
} from '../src/durable-objects/jetstream-poller';

// The every-minute cron pings /start to keep the firehose alive. What it does
// with the alarm state it finds is the whole liveness story, and it had a hole:
// on 2026-09-10 an alarm fired, its invocation was terminated before the
// `finally` that reschedules, and Cloudflare then sat on the undelivered alarm
// for 16 minutes. `getAlarm()` stayed non-null the whole time, so every ping read
// it as "scheduled" and left the poller stopped. A pending alarm whose time is in
// the past is not evidence of life.

const NOW = 1_700_000_000_000;

describe('decideStartAction', () => {
  it('cold-starts an object with no alarm and no recent cycle', () => {
    expect(decideStartAction(null, null, NOW)).toBe('started');
    expect(decideStartAction(null, undefined, NOW)).toBe('started');
    expect(decideStartAction(null, NOW - 10 * 60_000, NOW)).toBe('started');
  });

  it('leaves a mid-flight cycle alone', () => {
    // getAlarm() is null for the several seconds a handler runs. Re-arming here
    // would start a second cycle on top of the one already working.
    expect(decideStartAction(null, NOW - 3_000, NOW)).toBe('recently_active');
    expect(decideStartAction(null, NOW - (ALARM_ACTIVE_WINDOW_MS - 1), NOW)).toBe(
      'recently_active'
    );
  });

  it('leaves an alarm scheduled in the future alone', () => {
    expect(decideStartAction(NOW + 30_000, NOW - 30_000, NOW)).toBe('scheduled');
  });

  it('tolerates an alarm slightly past its time', () => {
    // Normal delivery jitter and a slow cycle both land here; re-arming on this
    // would fight the poller instead of rescuing it.
    expect(decideStartAction(NOW - 1_000, NOW - 61_000, NOW)).toBe('scheduled');
    expect(decideStartAction(NOW - STUCK_ALARM_GRACE_MS, NOW - 10 * 60_000, NOW)).toBe('scheduled');
  });

  it('re-arms an alarm that is long overdue', () => {
    // The 2026-09-10 shape: the alarm fired at its scheduled time, the cycle died
    // before rescheduling, and nine minutes later the same alarm was still
    // pending with the same last_alarm_start.
    const alarmTime = NOW - 9 * 60_000;
    expect(decideStartAction(alarmTime, alarmTime, NOW)).toBe('rearmed');
  });

  it('waits out the active window before re-arming an overdue alarm', () => {
    // A cycle that started recently may still be running and holding the alarm.
    // Staleness has to outlast that window before it means "wedged".
    const alarmTime = NOW - 9 * 60_000;
    expect(decideStartAction(alarmTime, NOW - 5_000, NOW)).toBe('scheduled');
  });

  it('recovers within one cron tick once the poller is wedged', () => {
    // The property that matters: from the moment staleness is unambiguous, the
    // next ping re-arms. That caps a wedge at a cron interval instead of leaving
    // it to Cloudflare's own delivery.
    const alarmTime = NOW;
    const firstUnambiguousPing = alarmTime + STUCK_ALARM_GRACE_MS + 1;
    expect(decideStartAction(alarmTime, alarmTime, firstUnambiguousPing)).toBe('rearmed');
  });
});
