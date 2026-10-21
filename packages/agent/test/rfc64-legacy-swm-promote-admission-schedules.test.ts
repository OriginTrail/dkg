// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3052, seeded schedules for the promote's admission wait. Each schedule
 * raises leases and retirements of random kind, scope, start and length
 * (including ones that stay up for minutes) on two graphs, and starts promotes
 * of random assets at random instants. In a third of the schedules the node
 * begins to stop at a random instant. Every change of a fence, and the start of
 * every timer callback (one turn of the event loop), is recorded as it happens,
 * and every promote's wait is then checked against that record:
 *
 * 1. It never waits past the end of a turn in which neither its graph nor its
 *    asset is fenced (it ends at the drop, also when a holder hands the fence on
 *    and the last one drops later).
 * 2. It never waits past the first instant at which it has waited for the limit,
 *    or a fence in front of it has been up for the limit without a break, or the
 *    node has begun to stop. The age of a fence is taken from the record (when
 *    the scope went from no holder to one), not from the coordinator.
 * 3. It ends `unfenced` only when nothing fences it, and stops waiting only when
 *    something does and one of the conditions in (2) holds.
 * 4. A promote that ended `unfenced` is admitted by the prepare; one that stopped
 *    waiting is refused.
 * 5. Leases and retirements still start their work only when no preparation of
 *    their scope is in flight (the waits reserve nothing and change no order).
 * 6. Every promote and every holder ends, and nothing is left on the coordinator.
 * 7. While the cap of promotes waits the full time, one more that meets a fence
 *    waits the short bound only, and ends `waiters-limit` if a fence is still up
 *    then; whether a promote was one more is worked out from the record. A third
 *    family runs with a cap of three, so that it happens often.
 *
 * A second family of schedules raises a fence again in the same turn in which
 * it dropped, one to twelve microtasks later. There a promote may end
 * `unfenced` and still be refused by the prepare, because the fence came back
 * between the end of its wait and its prepare. That is the race the wait cannot
 * close (it reserves nothing); the checks there accept it only when the fence
 * was down in that same turn, and count it.
 *
 * The same checks reject the two-second wait the promote had before, a wait
 * without the age limit, an age limit that counts the age of the oldest holder
 * instead of the fence, and a wait that ignores the cap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertRfc64LegacySwmPreparationAdmittedV1,
  beginRfc64LegacySwmPreparationV1,
  createRfc64LegacySwmFenceCoordinatorV1,
  endRfc64LegacySwmAdmissionWaitsV1,
  runRfc64LegacySwmRetirementV1,
  waitForRfc64LegacySwmPreparationAdmissionV1,
  waitForRfc64LegacySwmPromoteAdmissionV1,
  type Rfc64LegacySwmAdmissionWaitEndV1,
  type Rfc64LegacySwmFenceCoordinatorV1,
  type Rfc64LegacySwmFenceSourceV1,
} from '../src/rfc64/legacy-swm-boundary-fence-v1.js';
import {
  RFC64_LEGACY_SWM_PREPARATION_ADMISSION_WAIT_MS,
  RFC64_LEGACY_SWM_PROMOTE_ADMISSION_WAIT_MS,
  RFC64_LEGACY_SWM_PROMOTE_ADMISSION_WAITERS,
} from '../src/rfc64/legacy-swm-boundary-v1.js';

const LIMIT_MS = RFC64_LEGACY_SWM_PROMOTE_ADMISSION_WAIT_MS;
const GRAPHS = ['graph-a', 'graph-b'] as const;
const ASSETS = [1, 2, 3].map((n) => `did:dkg:test:31337/0x1111111111111111111111111111111111111111/${n}`);
const WORK_MS = [0, 40, 1_500, 4_000, 9_000, 25_000, 45_000, 75_000, 200_000];
const COMMIT_MS = [0, 15, 600, 3_000];

type Waiter = (
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  contextGraphId: string,
  kaUal: string,
) => Promise<Rfc64LegacySwmAdmissionWaitEndV1>;

const OVERFLOW_MS = RFC64_LEGACY_SWM_PREPARATION_ADMISSION_WAIT_MS;
const promoteRuleWithCap = (maxWaiters: number): Waiter => (fence, contextGraphId, kaUal) => (
  waitForRfc64LegacySwmPromoteAdmissionV1(fence, contextGraphId, kaUal, {
    waitLimitMs: LIMIT_MS, maxFenceAgeMs: LIMIT_MS, maxWaiters, overflowWaitLimitMs: OVERFLOW_MS,
  })
);
const promoteRule = promoteRuleWithCap(RFC64_LEGACY_SWM_PROMOTE_ADMISSION_WAITERS);
/** The promote's wait in 10.0.24: two seconds, no age limit. */
const twoSecondWait: Waiter = (fence, contextGraphId, kaUal) => waitForRfc64LegacySwmPreparationAdmissionV1(
  fence, contextGraphId, kaUal, 2_000,
);
const noAgeLimit: Waiter = (fence, contextGraphId, kaUal) => waitForRfc64LegacySwmPreparationAdmissionV1(
  fence, contextGraphId, kaUal, LIMIT_MS,
);
/**
 * A frozen copy of the first version of this change: the age limit counted from the oldest holder
 * in front, so a fence handed from holder to holder could hold a promote for the whole minute.
 */
const oldestHolderAge: Waiter = async (fence, contextGraphId, kaUal) => {
  type Scope = { holders: Holder[]; fenceDropped: Promise<void> };
  const keys = [contextGraphId, `${contextGraphId}#${kaUal}`];
  const deadline = fence.now() + LIMIT_MS;
  for (;;) {
    const fenced = keys
      .map((key) => fence.scopes.get(key) as Scope | undefined)
      .filter((scope): scope is Scope => (scope?.holders.length ?? 0) > 0);
    if (fenced.length === 0) return 'unfenced';
    if (!fence.admissionWaitsOpen) return 'closed';
    const now = fence.now();
    if (deadline - now <= 0) return 'wait-limit';
    const ageLeftMs = Math.min(...fenced.map((scope) => scope.holders[0]!.raisedAt)) + LIMIT_MS - now;
    if (ageLeftMs <= 0) return 'fence-age-limit';
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    const timer = setTimeout(wake, Math.min(deadline - now, ageLeftMs));
    fence.admissionWakers.add(wake);
    try {
      await Promise.race([woken, ...fenced.map((scope) => scope.fenceDropped)]);
    } finally {
      clearTimeout(timer);
      fence.admissionWakers.delete(wake);
    }
  }
};

interface Holder { readonly source: Rfc64LegacySwmFenceSourceV1; readonly raisedAt: number }
interface FenceChange { readonly seq: number; readonly at: number; readonly key: string; readonly holders: number }
interface PromoteRecord {
  readonly name: string;
  readonly keys: readonly [string, string];
  readonly startSeq: number;
  readonly startAt: number;
  endSeq?: number;
  endAt?: number;
  end?: Rfc64LegacySwmAdmissionWaitEndV1;
  admitted?: boolean;
  /** Waited the full time (true), the short bound because the cap was reached (false), or met no fence. */
  full?: boolean;
}
/** What the schedules reached, so a change to the generator cannot quietly stop testing a case. */
interface Reach {
  promotes: number;
  longWaitsEndedAtDrop: number;
  waitLimitEnds: number;
  fenceAgeLimitEnds: number;
  closedEnds: number;
  raisedAgainBeforePrepare: number;
  waitersLimitEnds: number;
}

afterEach(() => {
  vi.useRealTimers();
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The coordinator's scope map, recording every change of a scope's holder count
 * the moment it happens (a holder raised, or dropped) with the fake instant.
 */
class RecordingScopes extends Map<string, { holders: Holder[] }> {
  constructor(private readonly onChange: (key: string, holders: number) => void) {
    super();
  }

  override set(key: string, scope: { holders: Holder[] }): this {
    const onChange = this.onChange;
    scope.holders = new Proxy(scope.holders, {
      set(array, property, value, receiver) {
        const done = Reflect.set(array, property, value, receiver);
        if (property === 'length') onChange(key, array.length);
        return done;
      },
    });
    return super.set(key, scope);
  }
}

/** The recorded fence of each scope key: whether it is up, and since when without a break. */
class FenceTimeline {
  constructor(readonly changes: readonly FenceChange[], readonly turns: readonly number[]) {}

  /** The state of the keys after every change before `seq`. */
  stateBefore(seq: number, keys: readonly string[]): { fenced: boolean; upSince: number } {
    let fenced = false;
    let upSince = Infinity;
    for (const key of keys) {
      let holders = 0;
      let since = Infinity;
      for (const change of this.changes) {
        if (change.seq >= seq) break;
        if (change.key !== key) continue;
        if (holders === 0 && change.holders > 0) since = change.at;
        holders = change.holders;
      }
      if (holders > 0) {
        fenced = true;
        upSince = Math.min(upSince, since);
      }
    }
    return { fenced, upSince };
  }

  /** The seq at which the turn running at `seq` ends (the start of the next turn). */
  endOfTurn(seq: number): number {
    return this.turns.find((turn) => turn > seq) ?? Infinity;
  }
}

interface ScheduleOptions {
  raiseAgainInTheSameTurn?: boolean;
  reach?: Reach;
  /** The cap the checker expects (the waiter's own may differ, for a negative control). */
  cap?: number;
}

async function runSchedule(seed: number, waiter: Waiter, options: ScheduleOptions = {}): Promise<string[]> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const rng = mulberry32(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(rng() * values.length)]!;
  const instant = (spanMs: number): number => (
    rng() < 0.5 ? Math.floor(rng() * spanMs / 1_000) * 1_000 : Math.floor(rng() * spanMs)
  );
  const violations: string[] = [];
  const changes: FenceChange[] = [];
  const turns: number[] = [];
  const promotes: PromoteRecord[] = [];
  const pending: { name: string; settled: boolean }[] = [];
  const track = (name: string, promise: Promise<unknown>) => {
    const entry = { name, settled: false };
    pending.push(entry);
    void promise.then(
      () => { entry.settled = true; },
      (error: unknown) => { entry.settled = true; violations.push(`${name} failed: ${String(error)}`); },
    );
  };
  const origin = Date.now();
  let seq = 0;
  // Every timer callback starts a turn of the event loop; the fake clock runs the microtasks of one
  // turn before it starts the next. The coordinator's own timers go through this wrapper too.
  const fakeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => (
    fakeSetTimeout(() => { turns.push(seq++); callback(...args); }, ms)
  )) as typeof setTimeout;
  const fence = createRfc64LegacySwmFenceCoordinatorV1({ now: () => Date.now() });
  // Holders to raise again, by scope key, a few microtasks after that scope's fence drops.
  const raiseAgain = new Map<string, (() => void)[]>();
  (fence as unknown as { scopes: Map<string, unknown> }).scopes = new RecordingScopes((key, holders) => {
    changes.push({ seq: seq++, at: Date.now() - origin, key, holders });
    const again = holders === 0 ? raiseAgain.get(key)?.shift() : undefined;
    if (again === undefined) return;
    let hops: Promise<void> = Promise.resolve();
    for (let hop = 1 + Math.floor(rng() * 12); hop > 1; hop -= 1) hops = hops.then(() => undefined);
    void hops.then(again);
  });
  const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

  let closedAt: number | undefined;
  if (rng() < 1 / 3) {
    setTimeout(() => {
      closedAt = Date.now() - origin;
      endRfc64LegacySwmAdmissionWaitsV1(fence);
    }, instant(250_000));
  }

  const raise = (
    name: string,
    graph: string,
    source: Rfc64LegacySwmFenceSourceV1,
    kaUal: string | undefined,
    workMs: number,
  ): Promise<unknown> => {
    const scopeKey = kaUal === undefined ? graph : `${graph}#${kaUal}`;
    const done = runRfc64LegacySwmRetirementV1(
      fence,
      { source, contextGraphId: graph, ...(kaUal === undefined ? {} : { kaUal }) },
      async () => {
        const inFlight = (fence.scopes.get(scopeKey) as { activePreparations?: number } | undefined)
          ?.activePreparations ?? 0;
        if (inFlight !== 0) {
          violations.push(`${source} on ${scopeKey} started its work with ${inFlight} preparation(s) in flight`);
        }
        await sleep(workMs);
      },
    );
    track(`${name} (${source} on ${scopeKey})`, done);
    return done;
  };
  const holderCount = 2 + Math.floor(rng() * 9);
  for (let index = 0; index < holderCount; index += 1) {
    const graph = pick(GRAPHS);
    const source = pick<Rfc64LegacySwmFenceSourceV1>(['receiver-lease', 'republish-retirement', 'finalized-vm-retirement']);
    const kaUal = source === 'finalized-vm-retirement' ? pick(ASSETS) : undefined;
    const workMs = pick(WORK_MS);
    const againMs = options.raiseAgainInTheSameTurn === true && rng() < 0.5 ? pick(WORK_MS) : undefined;
    setTimeout(() => {
      raise(`holder ${index}`, graph, source, kaUal, workMs);
      if (againMs !== undefined) {
        const key = kaUal === undefined ? graph : `${graph}#${kaUal}`;
        const queued = raiseAgain.get(key) ?? [];
        queued.push(() => { raise(`holder ${index} again`, graph, source, kaUal, againMs); });
        raiseAgain.set(key, queued);
      }
    }, instant(150_000));
  }

  const promoteCount = 2 + Math.floor(rng() * 11);
  for (let index = 0; index < promoteCount; index += 1) {
    const graph = pick(GRAPHS);
    const kaUal = pick(ASSETS);
    const commitMs = pick(COMMIT_MS);
    setTimeout(() => {
      const record: PromoteRecord = {
        name: `promote ${index} of ${kaUal.slice(-1)} on ${graph}`,
        keys: [graph, `${graph}#${kaUal}`],
        startSeq: seq++,
        startAt: Date.now() - origin,
      };
      promotes.push(record);
      track(record.name, (async () => {
        const end = await waiter(fence, graph, kaUal);
        record.endSeq = seq++;
        record.endAt = Date.now() - origin;
        record.end = end;
        try {
          assertRfc64LegacySwmPreparationAdmittedV1(fence, graph, kaUal);
          record.admitted = true;
        } catch {
          record.admitted = false;
          return;
        }
        const release = beginRfc64LegacySwmPreparationV1(fence, graph, kaUal);
        await sleep(commitMs);
        release();
      })());
    }, instant(220_000));
  }

  try {
    await vi.runAllTimersAsync();
  } finally {
    globalThis.setTimeout = fakeSetTimeout;
    vi.useRealTimers();
  }
  // Every timer has run; what has not settled by now never will.
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  for (const entry of pending) {
    if (!entry.settled) violations.push(`${entry.name} never ended`);
  }

  const timeline = new FenceTimeline(changes, turns);
  // Which promotes waited the full time: in the order they started, one that met a fence did while
  // fewer than the cap of earlier full waiters were still waiting.
  const cap = options.cap ?? RFC64_LEGACY_SWM_PROMOTE_ADMISSION_WAITERS;
  const fullWaiters: PromoteRecord[] = [];
  for (const record of [...promotes].sort((a, b) => a.startSeq - b.startSeq)) {
    if (!timeline.stateBefore(record.startSeq, record.keys).fenced) continue;
    record.full = fullWaiters.filter((other) => (other.endSeq ?? Infinity) > record.startSeq).length < cap;
    if (record.full) fullWaiters.push(record);
  }
  for (const record of promotes) {
    violations.push(...checkPromote(record, timeline, closedAt, options.raiseAgainInTheSameTurn === true, options.reach));
  }
  for (const [key, scope] of fence.scopes) {
    const left = scope as { holders: Holder[]; activePreparations: number };
    if (left.holders.length > 0 || left.activePreparations > 0) violations.push(`scope ${key} was left behind`);
  }
  if (fence.admissionWakers.size > 0 || fence.promoteAdmissionWaiters !== 0) {
    violations.push(`left ${fence.admissionWakers.size} waker(s) and ${fence.promoteAdmissionWaiters} waiter(s)`);
  }
  return violations.map((violation) => `seed ${seed}: ${violation}`);
}

function checkPromote(
  record: PromoteRecord,
  timeline: FenceTimeline,
  closedAt: number | undefined,
  raisedAgainInTheSameTurn: boolean,
  reach: Reach | undefined,
): string[] {
  if (record.end === undefined || record.endAt === undefined || record.endSeq === undefined) {
    return [`${record.name} never ended its wait`];
  }
  const { startAt, startSeq, endAt, endSeq, keys } = record;
  const violations: string[] = [];
  // The first instant at which a promote behind a fence that went up at `upSince` must stop waiting.
  const ownLimitMs = record.full === false ? OVERFLOW_MS : LIMIT_MS;
  const giveUpAt = (upSince: number) => Math.min(
    startAt + ownLimitMs,
    upSince + LIMIT_MS,
    closedAt === undefined ? Infinity : Math.max(startAt, closedAt),
  );

  // (1) At the end of every turn during the wait, something fences the promote.
  for (const turnEnd of timeline.turns) {
    if (turnEnd <= startSeq) continue;
    if (turnEnd > endSeq) break;
    if (!timeline.stateBefore(turnEnd, keys).fenced) {
      violations.push(`${record.name} kept waiting past the end of a turn in which nothing fenced it (ended ${endAt})`);
      break;
    }
  }

  // (2) It does not wait past the first instant at which it must stop. Between two changes the fence
  // in front, and so the instant, stays the same.
  const changesDuring = timeline.changes.filter((change) => change.seq > startSeq && change.seq < endSeq);
  const points = [{ seq: startSeq, at: startAt }, ...changesDuring.map((change) => ({ seq: change.seq, at: change.at }))];
  for (const [index, point] of points.entries()) {
    const state = timeline.stateBefore(point.seq + 1, keys);
    if (!state.fenced) continue;
    const nextAt = points[index + 1]?.at ?? endAt;
    const due = Math.max(point.at, giveUpAt(state.upSince));
    if (due < nextAt && due < endAt) {
      violations.push(`${record.name} kept waiting from ${startAt} past ${due}, where it should have stopped, to ${endAt}`);
      break;
    }
  }

  // (3) and (4): the end is what the record says it should be.
  const atEnd = timeline.stateBefore(endSeq, keys);
  if (record.end === 'unfenced') {
    if (atEnd.fenced) {
      // The fence came back after the wait ended and before this continuation ran: possible only in a
      // turn in which it was down, and only in the schedules that raise fences again within a turn.
      const downInThisTurn = raisedAgainInTheSameTurn && timeline.changes.some((change) => (
        change.seq > startSeq && change.seq < endSeq && keys.includes(change.key)
        && timeline.endOfTurn(change.seq) > endSeq && !timeline.stateBefore(change.seq + 1, keys).fenced
      ));
      if (!downInThisTurn) violations.push(`${record.name} ended unfenced at ${endAt} while fenced`);
      else if (reach !== undefined) reach.raisedAgainBeforePrepare += 1;
      if (record.admitted) violations.push(`${record.name} was admitted while fenced at ${endAt}`);
    } else if (!record.admitted) {
      violations.push(`${record.name} ended unfenced at ${endAt}, but the prepare refused it`);
    }
  } else {
    if (!atEnd.fenced) {
      violations.push(`${record.name} stopped waiting (${record.end}) at ${endAt} while nothing fenced it`);
    } else if (giveUpAt(atEnd.upSince) > endAt) {
      violations.push(`${record.name} stopped waiting (${record.end}) at ${endAt}, before ${giveUpAt(atEnd.upSince)}`);
    }
    if (record.end === 'closed' && (closedAt === undefined || endAt < closedAt)) {
      violations.push(`${record.name} stopped waiting (closed) at ${endAt} before the node began to stop`);
    }
    if ((record.end === 'waiters-limit') !== (record.full === false && endAt - startAt >= OVERFLOW_MS
      && record.end !== 'closed' && record.end !== 'fence-age-limit')) {
      violations.push(`${record.name} ended ${record.end} at ${endAt} as a ${record.full ? 'full' : 'short'} waiter`);
    }
    if (record.end === 'wait-limit' && record.full !== true) {
      violations.push(`${record.name} ended wait-limit at ${endAt} although it was not a full waiter`);
    }
    if (record.admitted) violations.push(`${record.name} stopped waiting (${record.end}) but the prepare admitted it`);
  }

  if (reach !== undefined) {
    reach.promotes += 1;
    if (record.end === 'unfenced' && endAt - startAt > 2_000) reach.longWaitsEndedAtDrop += 1;
    if (record.end === 'wait-limit') reach.waitLimitEnds += 1;
    if (record.end === 'fence-age-limit') reach.fenceAgeLimitEnds += 1;
    if (record.end === 'closed') reach.closedEnds += 1;
    if (record.end === 'waiters-limit') reach.waitersLimitEnds += 1;
  }
  return violations;
}

async function violationsOver(seeds: number, waiter: Waiter, options: ScheduleOptions = {}): Promise<string[]> {
  const violations: string[] = [];
  for (let seed = 1; seed <= seeds; seed += 1) {
    violations.push(...await runSchedule(seed, waiter, options));
  }
  return violations;
}

const emptyReach = (): Reach => ({
  promotes: 0,
  longWaitsEndedAtDrop: 0,
  waitLimitEnds: 0,
  fenceAgeLimitEnds: 0,
  closedEnds: 0,
  raisedAgainBeforePrepare: 0,
  waitersLimitEnds: 0,
});

describe('the promote admission wait over seeded schedules (GH#3052)', () => {
  it('ends at the drop, stops at its limits and nowhere else, and changes nothing for the holders', async () => {
    const reach = emptyReach();
    const violations = await violationsOver(300, promoteRule, { reach });
    expect(violations).toEqual([]);
    // Each case the rule is about occurs many times over these seeds.
    expect(reach.promotes).toBeGreaterThan(1_500);
    expect(reach.longWaitsEndedAtDrop).toBeGreaterThan(100);
    expect(reach.fenceAgeLimitEnds).toBeGreaterThan(100);
    expect(reach.closedEnds).toBeGreaterThan(100);
    // Rare by construction: a minute of waiting behind fences that went up after the promote.
    expect(reach.waitLimitEnds).toBeGreaterThan(0);
  });

  it('keeps those rules when fences go up again in the turn in which they dropped', async () => {
    const reach = emptyReach();
    const violations = await violationsOver(300, promoteRule, { raiseAgainInTheSameTurn: true, reach });
    expect(violations).toEqual([]);
    expect(reach.promotes).toBeGreaterThan(1_500);
    expect(reach.longWaitsEndedAtDrop).toBeGreaterThan(50);
    // The race the wait leaves open does occur here, and ends in a refusal, nothing worse.
    expect(reach.raisedAgainBeforePrepare).toBeGreaterThan(0);
  });

  it('holds no more than the cap of promotes for the full time', async () => {
    const reach = emptyReach();
    const violations = await violationsOver(300, promoteRuleWithCap(3), { cap: 3, reach });
    expect(violations).toEqual([]);
    expect(reach.waitersLimitEnds).toBeGreaterThan(5);
    expect(reach.longWaitsEndedAtDrop).toBeGreaterThan(50);
  });

  it('the same checks reject a wait that ignores the cap', async () => {
    const violations = await violationsOver(120, promoteRuleWithCap(1_000), { cap: 3 });
    expect(violations.some((violation) => /where it should have stopped/.test(violation))).toBe(true);
  });

  it('the same checks reject the two-second wait the promote had before', async () => {
    const violations = await violationsOver(60, twoSecondWait);
    expect(violations.some((violation) => /stopped waiting \(wait-limit\) at \d+, before/.test(violation))).toBe(true);
  });

  it('the same checks reject a wait that also waits for a fence that has been up for the limit', async () => {
    const violations = await violationsOver(120, noAgeLimit);
    expect(violations.some((violation) => /where it should have stopped/.test(violation))).toBe(true);
  });

  it('the same checks reject an age limit counted from the oldest holder instead of the fence', async () => {
    const violations = await violationsOver(300, oldestHolderAge);
    expect(violations.some((violation) => /where it should have stopped/.test(violation))).toBe(true);
  });
});
