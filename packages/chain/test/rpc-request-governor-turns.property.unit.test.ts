// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRequestGovernor } from '../src/rpc-request-governor.js';
import { withRpcRequestContext } from '../src/rpc-request-transport.js';
import { RpcRequestGovernor as GovernorBeforeTurns } from './fixtures/rpc-request-governor-before-turns.js';

/**
 * Seeded schedules against the governor's turn rule.
 *
 * A schedule is a policy (rate, burst, foreground reserve, queue size) and a
 * set of arrivals of the governor's kinds of request: authority reads and
 * ordinary requests of the foreground class, ordinary and authority requests
 * of the background class. An arrival may give up after a while, and may come
 * back for another permit each time it has been admitted, which is how a
 * stream that asks for more than the budget is built.
 *
 * What is checked, for every schedule:
 *   - a foreground request waits for one admission of the other foreground
 *     kind at most, and for one background admission at most;
 *   - beside sustained foreground work, of either kind or both, a waiting
 *     background backlog is admitted at half of what its bucket and a third
 *     of the lane allow, or better;
 *   - a schedule of one class alone is admitted exactly as by the governor
 *     before the rule: same order, same instants, same refusals. That covers
 *     each class's whole rate and, for the background class, its bucket, its
 *     start-up rule and its own authority passes.
 */

type Kind = 'authority' | 'ordinary' | 'background' | 'background-authority';

interface Policy {
  readonly maxRequestsPerSecond: number;
  readonly burstRequests: number;
  readonly foregroundReservePercent: number;
  readonly maxQueueSize: number;
}

interface Arrival {
  readonly atMs: number;
  readonly kind: Kind;
  /** Gives up this long after asking, unless admitted first. */
  readonly giveUpAfterMs?: number;
  /** Asks again this many times, each time `thinkMs` after its last permit. */
  readonly repeats: number;
  readonly thinkMs: number;
}

interface Schedule {
  readonly policy: Policy;
  readonly arrivals: readonly Arrival[];
  readonly runMs: number;
}

interface Request {
  readonly id: string;
  readonly kind: Kind;
  /** Position of each moment in the one order everything happened in. */
  readonly askedAt: number;
  readonly askedAtMs: number;
  settledAt?: number;
  settledAtMs?: number;
  outcome?: 'admitted' | 'gave up' | 'refused';
}

type GovernorClass = new (policy: Policy & { startupJitterMs: number }) => {
  acquireActiveRequest(): Promise<void>;
};

/** mulberry32: small, seedable, and the same sequence on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)]!;
}

function policyFor(next: () => number): Policy {
  return {
    maxRequestsPerSecond: pick(next, [1, 2, 5, 10, 25]),
    burstRequests: pick(next, [1, 1, 2, 5, 20]),
    foregroundReservePercent: pick(next, [0, 0, 20, 50, 80, 99]),
    maxQueueSize: pick(next, [10_000, 10_000, 10_000, 24, 6]),
  };
}

/** Arrivals of the given kinds, spread over `spanMs`, some of them streams. */
function arrivalsFor(next: () => number, kinds: readonly Kind[], spanMs: number): Arrival[] {
  const count = 12 + Math.floor(next() * 48);
  return Array.from({ length: count }, (): Arrival => {
    const stream = next() < 0.2;
    return {
      atMs: Math.floor(next() * spanMs),
      kind: pick(next, kinds),
      ...(next() < 0.15 ? { giveUpAfterMs: 50 + Math.floor(next() * 3_000) } : {}),
      repeats: stream ? 1 + Math.floor(next() * 12) : 0,
      thinkMs: stream ? Math.floor(next() * 150) : 0,
    };
  }).sort((left, right) => left.atMs - right.atMs);
}

function scheduleFor(seed: number, kinds: readonly Kind[]): Schedule {
  const next = random(seed);
  const spanMs = 2_000 + Math.floor(next() * 6_000);
  const policy = policyFor(next);
  const arrivals = arrivalsFor(next, kinds, spanMs);
  // Long enough for every foreground request to be admitted three times over.
  const asked = arrivals.reduce((sum, arrival) => sum + 1 + arrival.repeats, 0);
  const runMs = spanMs + 10_000 + Math.ceil((asked * 3_000) / policy.maxRequestsPerSecond);
  return { policy, arrivals, runMs };
}

/** Run a schedule on fake timers and return every request in the order it asked. */
async function run(Governor: GovernorClass, schedule: Schedule): Promise<Request[]> {
  vi.setSystemTime(0);
  const governor = new Governor({ ...schedule.policy, startupJitterMs: 0 });
  const requests: Request[] = [];
  let moment = 0;

  const ask = (arrival: Arrival, index: number, attempt: number): void => {
    const request: Request = {
      id: `${index}.${attempt}`,
      kind: arrival.kind,
      askedAt: moment++,
      askedAtMs: Date.now(),
    };
    requests.push(request);
    const givingUp = arrival.giveUpAfterMs === undefined ? undefined : new AbortController();
    const timer = givingUp === undefined
      ? undefined
      : setTimeout(() => givingUp.abort(new Error('gave up')), arrival.giveUpAfterMs);
    const settle = (outcome: Request['outcome']): void => {
      request.outcome = outcome;
      request.settledAt = moment++;
      request.settledAtMs = Date.now();
      if (timer !== undefined) clearTimeout(timer);
    };
    const foreground = arrival.kind === 'authority' || arrival.kind === 'ordinary';
    const authority = arrival.kind === 'authority' || arrival.kind === 'background-authority';
    withRpcRequestContext(
      {
        requestClass: foreground ? 'foreground' : 'background',
        ...(authority ? { admissionPriority: 'authority' as const } : {}),
        ...(givingUp === undefined ? {} : { signal: givingUp.signal }),
      },
      () => governor.acquireActiveRequest(),
    ).then(
      () => {
        settle('admitted');
        if (attempt < arrival.repeats) {
          setTimeout(() => ask(arrival, index, attempt + 1), arrival.thinkMs);
        }
      },
      () => settle(givingUp?.signal.aborted === true ? 'gave up' : 'refused'),
    );
  };

  schedule.arrivals.forEach((arrival, index) => {
    setTimeout(() => ask(arrival, index, 0), arrival.atMs);
  });
  await vi.advanceTimersByTimeAsync(schedule.runMs);
  vi.clearAllTimers();
  return requests;
}

const admitted = (request: Request): boolean => request.outcome === 'admitted';
const describeSchedule = (seed: number, schedule: Schedule): string => (
  `seed ${seed}, policy ${JSON.stringify(schedule.policy)}, ${schedule.arrivals.length} arrivals`
);

/**
 * For every admitted request of `kind`: the admissions of each other kind
 * between the moment it became the oldest waiting request of its own kind and
 * its own admission.
 */
function passedWhileOldest(requests: readonly Request[], kind: Kind): Array<Record<Kind, number> & { id: string }> {
  const own = requests.filter((request) => request.kind === kind);
  const admissions = requests.filter(admitted);
  let oldestSince = -1;
  return own.flatMap((request) => {
    // It is the oldest once it has asked and everything of its kind in front
    // of it has been settled; `own` is in the order the requests asked.
    const since = Math.max(request.askedAt, oldestSince);
    oldestSince = Math.max(oldestSince, request.settledAt ?? Number.POSITIVE_INFINITY);
    if (!admitted(request)) return [];
    const passed: Record<Kind, number> = { authority: 0, ordinary: 0, background: 0, 'background-authority': 0 };
    for (const other of admissions) {
      if (other.kind !== kind && other.settledAt! > since && other.settledAt! < request.settledAt!) {
        passed[other.kind] += 1;
      }
    }
    return [{ id: request.id, ...passed }];
  });
}

const SEEDS = 300;
/** The backlog schedules run hot for ten seconds each; fewer of them cover the same policies. */
const BACKLOG_SEEDS = 60;
const ALL_KINDS: readonly Kind[] = ['authority', 'ordinary', 'background', 'background-authority'];

describe('RpcRequestGovernor: the turn rule over seeded schedules', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets a foreground request wait for one admission of the other foreground kind at most, and for one background admission at most', async () => {
    let authorityReadsPassed = 0;
    let ordinaryRequestsPassed = 0;
    let passedByBackground = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const schedule = scheduleFor(seed, ALL_KINDS);
      const requests = await run(RpcRequestGovernor, schedule);
      const label = describeSchedule(seed, schedule);

      for (const [kind, other] of [['authority', 'ordinary'], ['ordinary', 'authority']] as const) {
        for (const passed of passedWhileOldest(requests, kind)) {
          expect(passed[other], `${label}: ${other} admissions in front of ${kind} request ${passed.id}`).toBeLessThanOrEqual(1);
          expect(
            passed.background + passed['background-authority'],
            `${label}: background admissions in front of ${kind} request ${passed.id}`,
          ).toBeLessThanOrEqual(1);
          if (kind === 'authority') authorityReadsPassed += passed.ordinary;
          else ordinaryRequestsPassed += passed.authority;
          passedByBackground += passed.background + passed['background-authority'];
        }
      }
      // Nothing is left waiting that was not refused and did not give up.
      const foregroundLeft = requests.filter((request) => (
        request.outcome === undefined && (request.kind === 'authority' || request.kind === 'ordinary')
      ));
      expect(foregroundLeft.map((request) => request.id), `${label}: foreground requests never admitted`).toEqual([]);
    }
    // The schedules do put the kinds in each other's way, every way round.
    expect(authorityReadsPassed).toBeGreaterThan(500);
    expect(ordinaryRequestsPassed).toBeGreaterThan(500);
    expect(passedByBackground).toBeGreaterThan(500);
  }, 300_000);

  it.each([
    ['ordinary foreground requests', ['ordinary']],
    ['authority reads', ['authority']],
    ['authority reads and ordinary foreground requests', ['authority', 'ordinary']],
  ] as const)('admits a waiting background backlog beside sustained %s, whatever else arrives', async (_name, sustained) => {
    for (let seed = 1; seed <= BACKLOG_SEEDS; seed += 1) {
      const next = random(seed * 7_919);
      const policy: Policy = { ...policyFor(next), maxQueueSize: 10_000 };
      const windowMs = 10_000;
      const perSecond = policy.maxRequestsPerSecond;
      // Foreground work that asks for the whole lane for the whole window, a
      // background backlog that is there from the start, and requests of the
      // other foreground kind that arrive as the seed has it: none, some, or
      // more than the lane.
      const other: Kind = sustained.length === 2 || sustained[0] === 'ordinary' ? 'authority' : 'ordinary';
      const otherEveryMs = pick(next, [0, 2_000, 400, 150, 60]);
      const arrivals: Arrival[] = [
        ...sustained.flatMap((kind) => Array.from(
          { length: 4 },
          (): Arrival => ({ atMs: 0, kind, repeats: 1_000_000, thinkMs: 0 }),
        )),
        ...Array.from({ length: 400 }, (): Arrival => ({ atMs: 0, kind: 'background', repeats: 0, thinkMs: 0 })),
        ...(otherEveryMs === 0 ? [] : Array.from(
          { length: Math.floor(windowMs / otherEveryMs) },
          (_, index): Arrival => ({ atMs: index * otherEveryMs, kind: other, repeats: 0, thinkMs: 0 }),
        )),
      ];
      const requests = await run(RpcRequestGovernor, { policy, arrivals, runMs: windowMs });
      const backgroundAdmitted = requests.filter((request) => request.kind === 'background' && admitted(request)).length;

      // The bucket's rate, and under three-way contention every third permit.
      // A request has to age a second first, and half is the margin.
      const backgroundPerSecond = perSecond * (100 - policy.foregroundReservePercent) / 100;
      const owed = Math.floor(0.5 * ((windowMs - 2_000) / 1_000) * Math.min(backgroundPerSecond, perSecond / 3));
      expect(
        backgroundAdmitted,
        `seed ${seed}, policy ${JSON.stringify(policy)}, one ${other} request every ${otherEveryMs} ms`,
      ).toBeGreaterThanOrEqual(owed);
    }
  }, 300_000);

  it.each([
    ['ordinary foreground requests', ['ordinary']],
    ['authority reads', ['authority']],
    ['the background class', ['background', 'background-authority']],
  ] as const)('admits a schedule of %s alone exactly as the governor did before the rule', async (_name, kinds) => {
    let admissions = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const schedule = scheduleFor(seed * 104_729, kinds);
      const withTurns = await run(RpcRequestGovernor, schedule);
      const before = await run(GovernorBeforeTurns, schedule);
      expect(withTurns, describeSchedule(seed, schedule)).toEqual(before);
      admissions += withTurns.filter(admitted).length;
    }
    expect(admissions).toBeGreaterThan(SEEDS * 10);
  }, 300_000);
});
