/**
 * `settleOnExpected` (settle.ts) - the wait the devnet suite uses before it
 * trusts a chat-turn footprint. Pure logic on an injected clock and sleep: it
 * needs NO devnet and takes no real time, and `vitest.config.ts` runs it next
 * to `automated.test.ts`.
 *
 * The case that matters most is the lagging store: the read side serves the
 * expected one-exchange footprint first and the extra writes of a broken
 * resend path a moment later. Returning at the first match would pass that.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_CHAT_TURN,
  ONE_STORED_TURN,
  type ChatTurnFootprint,
} from '../../packages/cli/test/_helpers/chat-turn-footprint.js';
import { FOOTPRINT_SETTLE, settleOnExpected, type SettleOptions } from './settle.js';

/**
 * What a broken resend path leaves behind for one turn: the same turn subject
 * with eight user/assistant exchanges (sixteen Messages, eight `hasUserMessage`
 * and eight `hasAssistantMessage` objects). The eight identical `stored` state
 * triples are one triple in an RDF set, so `states` stays a single entry.
 */
const EIGHT_EXCHANGES: ChatTurnFootprint = {
  turns: 1,
  messages: 16,
  userMessages: 8,
  assistantMessages: 8,
  states: ['stored'],
  transitions: [],
};

/** A write that is only partly visible yet: the turn and its user message. */
const HALF_A_WRITE: ChatTurnFootprint = {
  turns: 1,
  messages: 1,
  userMessages: 1,
  assistantMessages: 0,
  states: ['stored'],
  transitions: [],
};

const MAX_READS = 5_000;

/** A macrotask turn, so a runaway loop hits the test timeout instead of starving the event loop. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeClock(stepPerSleep?: number) {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      t += stepPerSleep ?? ms;
      await tick();
    },
  };
}

type Clock = ReturnType<typeof fakeClock>;

/**
 * A store whose read side shows `frames[i].value` from `frames[i].at` ms on
 * (the last frame that has started wins). Every read returns a fresh object,
 * like `readChatTurnFootprint`, and can cost clock time.
 */
function laggingStore(clock: Clock, frames: Array<{ at: number; value: ChatTurnFootprint }>, readCostMs = 0) {
  const readTimes: number[] = [];
  const read = async (): Promise<ChatTurnFootprint> => {
    readTimes.push(clock.now());
    if (readTimes.length > MAX_READS) throw new Error('runaway polling loop');
    const frame = [...frames].reverse().find((candidate) => candidate.at <= clock.now());
    clock.advance(readCostMs);
    return structuredClone(frame!.value);
  };
  return { read, readTimes };
}

/** A store that answers the n-th read with the n-th value (the last one repeats). */
function scriptedStore(values: ChatTurnFootprint[]) {
  let reads = 0;
  return async (): Promise<ChatTurnFootprint> => {
    reads += 1;
    if (reads > MAX_READS) throw new Error('runaway polling loop');
    return structuredClone(values[Math.min(reads, values.length) - 1]);
  };
}

const optionsFor = (clock: Clock, overrides: Partial<SettleOptions<ChatTurnFootprint>> = {}) => ({
  ...FOOTPRINT_SETTLE,
  sleep: clock.sleep,
  now: clock.now,
  ...overrides,
});

describe('settleOnExpected: the quiet window', () => {
  it('returns a footprint that is there at once and stays, but only after the quiet window', async () => {
    const clock = fakeClock();
    const store = laggingStore(clock, [{ at: 0, value: ONE_STORED_TURN }]);

    const result = await settleOnExpected(store.read, ONE_STORED_TURN, optionsFor(clock));

    expect(result.outcome).toBe('settled');
    expect(result.value).toEqual(ONE_STORED_TURN);
    // Not at the first match: the first read plus the further reads of the window.
    expect(result.reads).toBe(5);
    expect(store.readTimes).toEqual([0, 500, 1000, 1500, 2000]);
    expect(store.readTimes.at(-1)! - store.readTimes[0]).toBeGreaterThanOrEqual(FOOTPRINT_SETTLE.quietMs);
    expect(result.reads - 1).toBeGreaterThanOrEqual(FOOTPRINT_SETTLE.quietReads);
  });

  it('reports the LATE footprint of a lagging store that shows one exchange first and eight a moment later', async () => {
    const clock = fakeClock();
    const store = laggingStore(clock, [
      { at: 0, value: ONE_STORED_TURN },
      { at: 1_200, value: EIGHT_EXCHANGES },
    ]);

    const result = await settleOnExpected(store.read, ONE_STORED_TURN, optionsFor(clock));

    expect(result.outcome).toBe('changed');
    expect(result.value).toEqual(EIGHT_EXCHANGES);
    // It stops at the first read that differs, it does not wait out the window.
    expect(store.readTimes).toEqual([0, 500, 1000, 1500]);
    // What the suite's assertion on the result does: it fails.
    expect(() => expect(result.value).toEqual(ONE_STORED_TURN)).toThrow();
  });

  it('does not see extra writes that surface only after the quiet window (the known limit)', async () => {
    const clock = fakeClock();
    const store = laggingStore(clock, [
      { at: 0, value: ONE_STORED_TURN },
      { at: FOOTPRINT_SETTLE.quietMs + 3_000, value: EIGHT_EXCHANGES },
    ]);

    const result = await settleOnExpected(store.read, ONE_STORED_TURN, optionsFor(clock));

    expect(result.outcome).toBe('settled');
    expect(result.value).toEqual(ONE_STORED_TURN);
  });

  it('reports a change at once even when the footprint goes back to the expected one afterwards', async () => {
    const read = scriptedStore([ONE_STORED_TURN, ONE_STORED_TURN, EIGHT_EXCHANGES, ONE_STORED_TURN]);

    const result = await settleOnExpected(read, ONE_STORED_TURN, optionsFor(fakeClock()));

    expect(result).toEqual({ outcome: 'changed', value: EIGHT_EXCHANGES, reads: 3 });
  });

  it('applies the same window to an expected absence (nothing written yet must stay nothing)', async () => {
    const clock = fakeClock();
    const store = laggingStore(clock, [
      { at: 0, value: NO_CHAT_TURN },
      { at: 900, value: ONE_STORED_TURN },
    ]);

    const result = await settleOnExpected(store.read, NO_CHAT_TURN, optionsFor(clock));

    expect(result.outcome).toBe('changed');
    expect(result.value).toEqual(ONE_STORED_TURN);
  });
});

describe('settleOnExpected: converging', () => {
  it('still converges through intermediate footprints, and counts the quiet window from the first match', async () => {
    const clock = fakeClock();
    const store = laggingStore(clock, [
      { at: 0, value: NO_CHAT_TURN },
      { at: 400, value: HALF_A_WRITE },
      { at: 1_000, value: ONE_STORED_TURN },
    ]);

    const result = await settleOnExpected(store.read, ONE_STORED_TURN, optionsFor(clock));

    expect(result.outcome).toBe('settled');
    expect(result.value).toEqual(ONE_STORED_TURN);
    // First match at t=1000, so the last confirming read is at t=3000, not at 2000.
    expect(store.readTimes).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000]);
  });

  it('returns the last footprint it saw when the expected one never shows up before the deadline', async () => {
    const clock = fakeClock();
    const store = laggingStore(clock, [
      { at: 0, value: NO_CHAT_TURN },
      { at: 6_000, value: HALF_A_WRITE },
    ]);

    const result = await settleOnExpected(store.read, ONE_STORED_TURN, optionsFor(clock));

    expect(result.outcome).toBe('timeout');
    expect(result.value).toEqual(HALF_A_WRITE);
    expect(clock.now()).toBe(FOOTPRINT_SETTLE.deadlineMs);
    expect(result.reads).toBe(FOOTPRINT_SETTLE.deadlineMs / FOOTPRINT_SETTLE.pollMs + 1);
    expect(() => expect(result.value).toEqual(ONE_STORED_TURN)).toThrow();
  });

  it('runs the whole quiet window when the first match comes right at the deadline', async () => {
    const clock = fakeClock();
    // The last poll before the deadline still shows nothing; the one at 15 s matches.
    const store = laggingStore(clock, [
      { at: 0, value: NO_CHAT_TURN },
      { at: FOOTPRINT_SETTLE.deadlineMs, value: ONE_STORED_TURN },
      { at: FOOTPRINT_SETTLE.deadlineMs + 1_200, value: EIGHT_EXCHANGES },
    ]);

    const result = await settleOnExpected(store.read, ONE_STORED_TURN, optionsFor(clock));

    expect(result.outcome).toBe('changed');
    expect(result.value).toEqual(EIGHT_EXCHANGES);
    expect(clock.now()).toBeGreaterThan(FOOTPRINT_SETTLE.deadlineMs);
  });

  it('settles after the window when the first match comes right at the deadline and holds', async () => {
    const clock = fakeClock();
    const store = laggingStore(clock, [
      { at: 0, value: NO_CHAT_TURN },
      { at: FOOTPRINT_SETTLE.deadlineMs, value: ONE_STORED_TURN },
    ]);

    const result = await settleOnExpected(store.read, ONE_STORED_TURN, optionsFor(clock));

    expect(result.outcome).toBe('settled');
    expect(store.readTimes.at(-1)).toBe(FOOTPRINT_SETTLE.deadlineMs + FOOTPRINT_SETTLE.quietMs);
  });

  it('compares footprints by value, not by identity', async () => {
    // Every read returns a fresh object; only a value comparison can match it.
    const read = scriptedStore([structuredClone(ONE_STORED_TURN)]);

    const result = await settleOnExpected(read, ONE_STORED_TURN, optionsFor(fakeClock()));

    expect(result.outcome).toBe('settled');
  });

  it('uses an injected equality when one is given', async () => {
    const read = scriptedStore([EIGHT_EXCHANGES]);

    const result = await settleOnExpected(read, ONE_STORED_TURN, optionsFor(fakeClock(), {
      equals: (a, b) => a.turns === b.turns,
    }));

    expect(result.outcome).toBe('settled');
  });
});

describe('settleOnExpected: clock and read count', () => {
  it('measures the quiet window on the injected clock, not on the read count', async () => {
    // Sleeps move the clock by 10 ms only: the 3 further reads are done long
    // before 2 s have passed, so the elapsed time has to hold the helper back.
    const clock = fakeClock(10);
    const store = laggingStore(clock, [{ at: 0, value: ONE_STORED_TURN }]);

    const result = await settleOnExpected(store.read, ONE_STORED_TURN, optionsFor(clock));

    expect(result.outcome).toBe('settled');
    expect(clock.now()).toBe(FOOTPRINT_SETTLE.quietMs);
    expect(result.reads).toBe(FOOTPRINT_SETTLE.quietMs / 10 + 1);
  });

  it('also wants the further reads when the clock leaps past the window on every sleep', async () => {
    // One sleep is already 10 s of clock time, so the elapsed time is enough
    // after the first further read; the read count has to hold the helper back.
    const clock = fakeClock(10_000);
    const store = laggingStore(clock, [{ at: 0, value: ONE_STORED_TURN }]);

    const result = await settleOnExpected(store.read, ONE_STORED_TURN, optionsFor(clock));

    expect(result.outcome).toBe('settled');
    expect(result.reads).toBe(1 + FOOTPRINT_SETTLE.quietReads);
  });

  it('starts the window when the first matching read returns and ends it with a read issued after it', async () => {
    // Every read costs 800 ms of clock time (a slow store), so the first
    // matching read returns at t=800. One further read is enough by count
    // here, which leaves the elapsed time to decide: the read issued at 2600
    // is only 1800 ms after the match, the one issued at 3900 is 3100 ms after.
    // A window counted from the first read's start (t=0) would have ended at 2600.
    const clock = fakeClock();
    const store = laggingStore(clock, [{ at: 0, value: ONE_STORED_TURN }], 800);

    const result = await settleOnExpected(store.read, ONE_STORED_TURN, optionsFor(clock, { quietReads: 1 }));

    expect(result.outcome).toBe('settled');
    expect(store.readTimes).toEqual([0, 1300, 2600, 3900]);
  });
});

describe('settleOnExpected: a failing read', () => {
  const boom = new Error('query on node1 failed (500)');

  it('propagates an error from the first read', async () => {
    await expect(settleOnExpected(async () => { throw boom; }, ONE_STORED_TURN, optionsFor(fakeClock())))
      .rejects.toBe(boom);
  });

  it('propagates an error from a read while it converges', async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      if (reads === 3) throw boom;
      return NO_CHAT_TURN;
    };

    await expect(settleOnExpected(read, ONE_STORED_TURN, optionsFor(fakeClock()))).rejects.toBe(boom);
    expect(reads).toBe(3);
  });

  it('propagates an error from a read in the quiet window', async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      if (reads === 3) throw boom;
      return structuredClone(ONE_STORED_TURN);
    };

    await expect(settleOnExpected(read, ONE_STORED_TURN, optionsFor(fakeClock()))).rejects.toBe(boom);
    expect(reads).toBe(3);
  });
});

describe('FOOTPRINT_SETTLE', () => {
  it('keeps the previous convergence timing and adds a quiet window that the suite can afford', () => {
    expect(FOOTPRINT_SETTLE.pollMs).toBe(500);
    expect(FOOTPRINT_SETTLE.deadlineMs).toBe(15_000);
    // A real window: at least 2 s and 3 further reads, with room for more than
    // one poll inside it so the clock check and the count check both matter.
    expect(FOOTPRINT_SETTLE.quietMs).toBeGreaterThanOrEqual(2_000);
    expect(FOOTPRINT_SETTLE.quietReads).toBeGreaterThanOrEqual(3);
    expect(FOOTPRINT_SETTLE.quietMs).toBeGreaterThan(FOOTPRINT_SETTLE.pollMs);
    // The worst settled read of one test (two per test at most) must stay far
    // below the suite's 120 s testTimeout.
    expect(2 * (FOOTPRINT_SETTLE.deadlineMs + FOOTPRINT_SETTLE.quietMs + 2 * FOOTPRINT_SETTLE.pollMs)).toBeLessThan(60_000);
  });
});
