import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROL_PLANE_REFUSAL_MAX_COUNTED_GRAPHS,
  CONTROL_PLANE_REFUSAL_SUMMARY_INTERVAL_MS,
  ControlPlaneRefusalSummary,
} from '../src/sync/control-plane-refusals.js';

const LABEL = 'durable:control-plane';
const BUSY = 'global inflight=1/1, queued=0/0, reserved control-plane inflight=1/1';

let clock = 0;
let lines: string[] = [];

function summary(emit: (message: string) => void = (message) => { lines.push(message); }) {
  return new ControlPlaneRefusalSummary({ emit, now: () => clock });
}

/** Move the wall clock and the faked timers together. */
function advance(ms: number): void {
  clock += ms;
  vi.advanceTimersByTime(ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  clock = 1_000_000;
  lines = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('control-plane refusal summary', () => {
  it('logs one line per interval with the count, the graphs and the last slot state', () => {
    const refusals = summary();
    refusals.note(LABEL, 'global inflight=1/1, queued=0/0, reserved control-plane inflight=0/1', 'urn:cg:a');
    advance(1_000);
    refusals.note(LABEL, BUSY, 'urn:cg:b');
    refusals.note(LABEL, BUSY, 'urn:cg:a');
    expect(lines).toEqual([]);

    advance(CONTROL_PLANE_REFUSAL_SUMMARY_INTERVAL_MS - 1_001);
    expect(lines).toEqual([]);
    advance(1);

    expect(lines).toEqual([
      `Sync backpressure rejected ${LABEL} 3 time(s) in the last 600 s for 2 graph(s), each asked again later `
        + `(last: ${BUSY})`,
    ]);
    // Nothing more while nothing is refused.
    advance(3 * CONTROL_PLANE_REFUSAL_SUMMARY_INTERVAL_MS);
    expect(lines).toHaveLength(1);
  });

  it('starts the next interval with the next refusal and counts it afresh', () => {
    const refusals = summary();
    refusals.note(LABEL, BUSY, 'urn:cg:a');
    advance(CONTROL_PLANE_REFUSAL_SUMMARY_INTERVAL_MS);
    advance(5 * 60_000);
    refusals.note(LABEL, BUSY);
    advance(CONTROL_PLANE_REFUSAL_SUMMARY_INTERVAL_MS);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      `Sync backpressure rejected ${LABEL} 1 time(s) in the last 600 s for 0 graph(s), each asked again later `
        + `(last: ${BUSY})`,
    );
  });

  it('writes one line per label', () => {
    const refusals = summary();
    refusals.note(LABEL, BUSY, 'urn:cg:a');
    refusals.note('durable:other-control-plane', 'global inflight=2/3, queued=0/0', 'urn:cg:b');
    advance(CONTROL_PLANE_REFUSAL_SUMMARY_INTERVAL_MS);

    expect(lines).toEqual([
      expect.stringMatching(new RegExp(`^Sync backpressure rejected ${LABEL} 1 time\\(s\\)`)),
      expect.stringMatching(/^Sync backpressure rejected durable:other-control-plane 1 time\(s\) .*\(last: global inflight=2\/3, queued=0\/0\)$/),
    ]);
  });

  it('bounds the graphs it remembers but never the count', () => {
    const refusals = summary();
    const refused = CONTROL_PLANE_REFUSAL_MAX_COUNTED_GRAPHS + 10;
    for (let index = 0; index < refused; index += 1) refusals.note(LABEL, BUSY, `urn:cg:${index}`);
    refusals.flush();

    expect(lines).toEqual([
      `Sync backpressure rejected ${LABEL} ${refused} time(s) in the last 1 s `
        + `for at least ${CONTROL_PLANE_REFUSAL_MAX_COUNTED_GRAPHS} graph(s), each asked again later (last: ${BUSY})`,
    ]);
  });

  it('flushes on demand, writes nothing for an empty interval, and survives a failing log', () => {
    const refusals = summary(() => { throw new Error('log closed'); });
    refusals.flush();
    refusals.note(LABEL, BUSY);
    expect(() => refusals.flush()).not.toThrow();

    const counted = summary();
    counted.flush();
    expect(lines).toEqual([]);
    counted.note(LABEL, BUSY);
    advance(90_000);
    counted.flush();
    expect(lines).toEqual([expect.stringContaining('1 time(s) in the last 90 s')]);
    // The flushed interval's timer is gone: no second line when it would have fired.
    advance(CONTROL_PLANE_REFUSAL_SUMMARY_INTERVAL_MS);
    expect(lines).toHaveLength(1);
  });
});
