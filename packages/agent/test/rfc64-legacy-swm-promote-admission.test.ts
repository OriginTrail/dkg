// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3052: a promote that meets the legacy SWM retirement fence waits for the
 * fence to drop instead of being refused after two seconds and retried by the
 * promote queue a minute or more later. The wait follows the fence from one
 * holder to the next, ends at the drop, and is bounded twice: by its own limit,
 * and by the age of the fence in front (a fence that has been up that long is
 * not waited for). The Core's StorageACK keeps its two-second wait.
 *
 * Every timer here is faked and the fences read the faked `Date.now()`, so the
 * instants are exact. The last block drives the agent's REAL promote seam (the
 * resolver the agent hands its publisher), so it fails on a build whose seam
 * still gives up at two seconds.
 */
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { type AuthorCatalogScopeV1 } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/index.js';
import {
  assertRfc64LegacySwmPreparationAdmittedV1,
  createRfc64LegacySwmFenceCoordinatorV1,
  describeRfc64LegacySwmFenceEventV1,
  endRfc64LegacySwmAdmissionWaitsV1,
  rfc64LegacySwmFenceEventLoggerV1,
  runRfc64LegacySwmRetirementV1,
  waitForRfc64LegacySwmPreparationAdmissionV1,
  waitForRfc64LegacySwmPromoteAdmissionV1,
  type Rfc64LegacySwmFenceCoordinatorV1,
  type Rfc64LegacySwmFenceEventV1,
  type Rfc64LegacySwmFenceSourceV1,
} from '../src/rfc64/legacy-swm-boundary-fence-v1.js';
import {
  acquireRfc64LegacySwmBoundaryReceiverLeaseV1,
  awaitRfc64LegacySwmPromoteAdmissionV1,
  endRfc64LegacySwmBoundaryAdmissionWaitsV1,
  initializeRfc64LegacySwmBoundaryV1,
  prepareRfc64LateLegacySwmBoundaryV1,
  rfc64LateLegacySwmCompanionResolverV1,
  RFC64_LEGACY_SWM_PREPARATION_ADMISSION_WAIT_MS,
  RFC64_LEGACY_SWM_PROMOTE_ADMISSION_WAIT_MS,
} from '../src/rfc64/legacy-swm-boundary-v1.js';

const CG = 'fence-graph';
const KA = 'did:dkg:test:31337/0x1111111111111111111111111111111111111111/1';
const PROMOTE_BOUNDS = Object.freeze({
  waitLimitMs: 60_000, maxFenceAgeMs: 60_000, maxWaiters: 16, overflowWaitLimitMs: 2_000,
});

const BOUNDARY_CG = '0x1111111111111111111111111111111111111111/promote-admission';
const BOUNDARY_UAL = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/1';
const BOUNDARY_SCOPE = Object.freeze({
  networkId: 'otp:20430',
  contextGraphId: BOUNDARY_CG,
  governanceChainId: null,
  governanceContractAddress: null,
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: '0x1111111111111111111111111111111111111111',
  era: '0',
  bucketCount: '1',
}) as AuthorCatalogScopeV1;

const roots: string[] = [];
const agents: DKGAgent[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

function fenceWithEvents(): { fence: Rfc64LegacySwmFenceCoordinatorV1; events: Rfc64LegacySwmFenceEventV1[] } {
  const events: Rfc64LegacySwmFenceEventV1[] = [];
  const fence = createRfc64LegacySwmFenceCoordinatorV1({
    now: () => Date.now(),
    onFenceEvent: (event) => events.push(event),
  });
  return { fence, events };
}

/** A retirement or a lease that holds its fence until `release()`. */
function hold(
  fence: Rfc64LegacySwmFenceCoordinatorV1,
  source: Rfc64LegacySwmFenceSourceV1,
  kaUal?: string,
): { release: () => void; done: Promise<unknown> } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const done = runRfc64LegacySwmRetirementV1(
    fence,
    { source, contextGraphId: CG, ...(kaUal === undefined ? {} : { kaUal }) },
    () => released,
  );
  return { release, done };
}

/** A promise's state after the pending microtasks ran, without moving the clock. */
async function settled<T>(promise: Promise<T>): Promise<{ done: false } | { done: true; value: T }> {
  let state: { done: false } | { done: true; value: T } = { done: false };
  void promise.then((value) => { state = { done: true, value }; });
  await vi.advanceTimersByTimeAsync(0);
  return state;
}

async function secureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-promote-admission-'));
  await chmod(dir, 0o700);
  roots.push(dir);
  return dir;
}

describe('the admission wait follows the fence and ends at the drop', () => {
  it('waits through a lease handed to the next one, and ends when the last drops', async () => {
    fakeClock();
    const { fence } = fenceWithEvents();
    const first = hold(fence, 'receiver-lease');
    const second = hold(fence, 'receiver-lease');
    const startedAt = Date.now();
    const wait = waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 60_000, { maxFenceAgeMs: 60_000 });

    await vi.advanceTimersByTimeAsync(10_000);
    first.release();
    await first.done;
    // The second lease asked while the first was at work: its fence was already up, so nothing dropped.
    expect(await settled(wait)).toEqual({ done: false });

    await vi.advanceTimersByTimeAsync(10_000);
    second.release();
    await second.done;
    expect(await settled(wait)).toEqual({ done: true, value: 'unfenced' });
    expect(Date.now() - startedAt).toBe(20_000);
    expect(() => assertRfc64LegacySwmPreparationAdmittedV1(fence, CG, KA)).not.toThrow();
  });

  it('ends at its own bound while the fence is still up', async () => {
    fakeClock();
    const { fence } = fenceWithEvents();
    const lease = hold(fence, 'receiver-lease');
    const wait = waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 60_000, { maxFenceAgeMs: 600_000 });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(await settled(wait)).toEqual({ done: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(wait)).toEqual({ done: true, value: 'wait-limit' });
    expect(() => assertRfc64LegacySwmPreparationAdmittedV1(fence, CG, KA)).toThrow(/raised by receiver-lease/);
    lease.release();
    await lease.done;
  });

  it('does not wait at all for a fence that has been up for the age limit', async () => {
    fakeClock();
    const { fence } = fenceWithEvents();
    const lease = hold(fence, 'receiver-lease');
    await vi.advanceTimersByTimeAsync(60_000);

    const wait = waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 60_000, { maxFenceAgeMs: 60_000 });
    expect(await settled(wait)).toEqual({ done: true, value: 'fence-age-limit' });
    lease.release();
    await lease.done;
  });

  it('stops waiting when the fence in front reaches the age limit, before its own bound', async () => {
    fakeClock();
    const { fence } = fenceWithEvents();
    const lease = hold(fence, 'receiver-lease');
    await vi.advanceTimersByTimeAsync(45_000);
    const wait = waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 60_000, { maxFenceAgeMs: 60_000 });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(await settled(wait)).toEqual({ done: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(wait)).toEqual({ done: true, value: 'fence-age-limit' });
    lease.release();
    await lease.done;
  });

  it('counts the age of the fence, not of its holder: a fence handed on keeps its age', async () => {
    fakeClock();
    const { fence } = fenceWithEvents();
    const first = hold(fence, 'receiver-lease');
    await vi.advanceTimersByTimeAsync(50_000);
    const second = hold(fence, 'republish-retirement');
    const wait = waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 60_000, { maxFenceAgeMs: 60_000 });

    // The first lease hands the fence to the second 5 s into the wait; the fence stays up.
    await vi.advanceTimersByTimeAsync(5_000);
    first.release();
    await first.done;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await settled(wait)).toEqual({ done: false });
    // A minute after the fence went up the wait stops, although the second lease is 10 s old.
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(wait)).toEqual({ done: true, value: 'fence-age-limit' });
    second.release();
    await second.done;
  });

  it('starts the age again when the fence has dropped in between', async () => {
    fakeClock();
    const { fence } = fenceWithEvents();
    const first = hold(fence, 'receiver-lease');
    await vi.advanceTimersByTimeAsync(50_000);
    first.release();
    await first.done;
    const second = hold(fence, 'receiver-lease');
    await vi.advanceTimersByTimeAsync(5_000);
    const wait = waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 120_000, { maxFenceAgeMs: 60_000 });

    // The fence went up again 55 s after the first one; it reaches the limit 55 s into the wait.
    await vi.advanceTimersByTimeAsync(54_999);
    expect(await settled(wait)).toEqual({ done: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(wait)).toEqual({ done: true, value: 'fence-age-limit' });
    second.release();
    await second.done;
  });

  it('a younger holder queued behind a stuck one does not extend the wait', async () => {
    fakeClock();
    // The queued holder must not give up its own wait for a turn before the promote's limit.
    const fence = createRfc64LegacySwmFenceCoordinatorV1({ now: () => Date.now(), waitLimitMs: 120_000 });
    const stuck = hold(fence, 'receiver-lease');
    await vi.advanceTimersByTimeAsync(20_000);
    const queued = hold(fence, 'republish-retirement');
    const wait = waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 60_000, { maxFenceAgeMs: 60_000 });

    // The stuck lease reaches the age limit 40 s into the wait, while the queued one is 40 s old.
    await vi.advanceTimersByTimeAsync(39_999);
    expect(await settled(wait)).toEqual({ done: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(wait)).toEqual({ done: true, value: 'fence-age-limit' });
    stuck.release();
    await stuck.done;
    queued.release();
    await queued.done;
  });

  it('counts the asset fence too: an old retirement of the asset ends the wait although the graph fence is young', async () => {
    fakeClock();
    // The lease must not give up its own wait for a turn while the promote waits.
    const fence = createRfc64LegacySwmFenceCoordinatorV1({ now: () => Date.now(), waitLimitMs: 120_000 });
    const retirement = hold(fence, 'finalized-vm-retirement', KA);
    await vi.advanceTimersByTimeAsync(30_000);
    const lease = hold(fence, 'receiver-lease');
    const wait = waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 60_000, { maxFenceAgeMs: 60_000 });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(await settled(wait)).toEqual({ done: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(wait)).toEqual({ done: true, value: 'fence-age-limit' });
    retirement.release();
    lease.release();
    await Promise.all([retirement.done, lease.done]);
  });
});

describe('the admission waits end when the node begins to stop', () => {
  it('ends a waiting promote at once, and every later wait that meets a fence', async () => {
    fakeClock();
    const { fence, events } = fenceWithEvents();
    const lease = hold(fence, 'receiver-lease');
    const waiting = waitForRfc64LegacySwmPromoteAdmissionV1(fence, CG, KA, PROMOTE_BOUNDS);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(fence.admissionWakers.size).toBe(1);

    endRfc64LegacySwmAdmissionWaitsV1(fence);
    expect(await settled(waiting)).toEqual({ done: true, value: 'closed' });
    expect(fence.admissionWakers.size).toBe(0);
    expect(describeRfc64LegacySwmFenceEventV1(events.find((event) => event.kind === 'admission-wait')!)).toBe(
      `A promote of ${KA} stopped waiting after 7000 ms for the RFC-64 legacy SWM fence raised by receiver-lease `
        + `on the graph of ${CG} (closed); the promote is refused, and a queued share is retried later`,
    );
    // A wait that starts afterwards does not sleep; one that meets no fence is admitted as before.
    expect(await settled(waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 60_000)))
      .toEqual({ done: true, value: 'closed' });
    lease.release();
    await lease.done;
    expect(await settled(waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 60_000)))
      .toEqual({ done: true, value: 'unfenced' });
  });

  it('leaves no waker behind, however the waits ended', async () => {
    fakeClock();
    const { fence } = fenceWithEvents();
    const lease = hold(fence, 'receiver-lease');
    const waits = Array.from({ length: 20 }, (_, index) => waitForRfc64LegacySwmPreparationAdmissionV1(
      fence, CG, KA, 60_000 + index, { maxFenceAgeMs: index % 2 === 0 ? 30_000 : 600_000 },
    ));
    expect(fence.admissionWakers.size).toBe(20);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fence.admissionWakers.size).toBe(10);
    lease.release();
    await lease.done;
    await expect(Promise.all(waits)).resolves.toEqual(
      Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? 'fence-age-limit' : 'unfenced')),
    );
    expect(fence.admissionWakers.size).toBe(0);
  });
});

describe('the promote admission wait holds a bounded number of promotes', () => {
  it('lets one promote more wait the short bound only, says so, and counts the waiters back down', async () => {
    fakeClock();
    const { fence, events } = fenceWithEvents();
    const lease = hold(fence, 'receiver-lease');
    const bounds = { ...PROMOTE_BOUNDS, maxWaiters: 3 };
    const held = [0, 1, 2].map(() => waitForRfc64LegacySwmPromoteAdmissionV1(fence, CG, KA, bounds));
    const overflow = waitForRfc64LegacySwmPromoteAdmissionV1(fence, CG, KA, bounds);
    // Only the promotes that wait the full time are counted.
    expect(fence.promoteAdmissionWaiters).toBe(3);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled(overflow)).toEqual({ done: true, value: 'waiters-limit' });
    expect(describeRfc64LegacySwmFenceEventV1(events.find((event) => event.kind === 'admission-wait')!)).toBe(
      `A promote of ${KA} stopped waiting after 2000 ms for the RFC-64 legacy SWM fence raised by receiver-lease `
        + `on the graph of ${CG} (waiters-limit); the promote is refused, and a queued share is retried later`,
    );
    expect(fence.promoteAdmissionWaiters).toBe(3);
    // A promote that arrives while three wait gets the short bound too.
    const late = waitForRfc64LegacySwmPromoteAdmissionV1(fence, CG, KA, bounds);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled(late)).toEqual({ done: true, value: 'waiters-limit' });

    await vi.advanceTimersByTimeAsync(10_000);
    lease.release();
    await lease.done;
    await expect(Promise.all(held)).resolves.toEqual(['unfenced', 'unfenced', 'unfenced']);
    expect(fence.promoteAdmissionWaiters).toBe(0);
    // A promote that meets no fence is not counted at all.
    await expect(waitForRfc64LegacySwmPromoteAdmissionV1(fence, CG, KA, bounds)).resolves.toBe('unfenced');
    expect(fence.promoteAdmissionWaiters).toBe(0);
  });
});

describe('the promote admission wait names what it waited for', () => {
  it('reports nothing when it met no fence, or waited for no longer than a long fence lasts', async () => {
    fakeClock();
    const { fence, events } = fenceWithEvents();
    await expect(waitForRfc64LegacySwmPromoteAdmissionV1(fence, CG, KA, PROMOTE_BOUNDS)).resolves.toBe('unfenced');

    const lease = hold(fence, 'receiver-lease');
    const wait = waitForRfc64LegacySwmPromoteAdmissionV1(fence, CG, KA, PROMOTE_BOUNDS);
    await vi.advanceTimersByTimeAsync(5_000);
    lease.release();
    await lease.done;
    await expect(wait).resolves.toBe('unfenced');
    expect(events).toEqual([]);
  });

  it('reports a long wait with the fence it waited for and the asset of the promote', async () => {
    fakeClock();
    const { fence, events } = fenceWithEvents();
    const lease = hold(fence, 'receiver-lease');
    await vi.advanceTimersByTimeAsync(3_000);
    const wait = waitForRfc64LegacySwmPromoteAdmissionV1(fence, CG, KA, PROMOTE_BOUNDS);
    await vi.advanceTimersByTimeAsync(12_000);
    lease.release();
    await lease.done;
    await expect(wait).resolves.toBe('unfenced');

    const admissionWaits = events.filter((event) => event.kind === 'admission-wait');
    expect(admissionWaits).toEqual([{
      kind: 'admission-wait',
      source: 'receiver-lease',
      scope: 'graph',
      contextGraphId: CG,
      kaUal: KA,
      elapsedMs: 12_000,
      waitEnd: 'unfenced',
    }]);
    expect(describeRfc64LegacySwmFenceEventV1(admissionWaits[0]!)).toBe(
      `A promote of ${KA} waited 12000 ms for the RFC-64 legacy SWM fence raised by receiver-lease on the graph of ${CG}`,
    );
    // The lease reports its own long fence as before.
    expect(events.filter((event) => event.kind === 'long-fence')).toHaveLength(1);
  });

  it('reports a promote that stopped waiting, with the fence that stood longest', async () => {
    fakeClock();
    const { fence, events } = fenceWithEvents();
    const retirement = hold(fence, 'finalized-vm-retirement', KA);
    await vi.advanceTimersByTimeAsync(20_000);
    const wait = waitForRfc64LegacySwmPromoteAdmissionV1(fence, CG, KA, PROMOTE_BOUNDS);
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(wait).resolves.toBe('fence-age-limit');

    expect(events).toEqual([expect.objectContaining({
      kind: 'admission-wait',
      source: 'finalized-vm-retirement',
      scope: 'asset',
      kaUal: KA,
      elapsedMs: 40_000,
      waitEnd: 'fence-age-limit',
    })]);
    expect(describeRfc64LegacySwmFenceEventV1(events[0]!)).toBe(
      `A promote of ${KA} stopped waiting after 40000 ms for the RFC-64 legacy SWM fence raised by `
        + `finalized-vm-retirement on the asset of ${CG} (fence-age-limit); the promote is refused, `
        + 'and a queued share is retried later',
    );
    retirement.release();
    await retirement.done;
  });
});

describe('the promote admission event names the fence that held it at the end, at its own level', () => {
  it('names the fence that stood longest when the promote stopped, not the one it met first', async () => {
    fakeClock();
    const fence = createRfc64LegacySwmFenceCoordinatorV1({ now: () => Date.now(), waitLimitMs: 120_000 });
    const events: Rfc64LegacySwmFenceEventV1[] = [];
    (fence as { onFenceEvent?: (event: Rfc64LegacySwmFenceEventV1) => void }).onFenceEvent = (event) => {
      events.push(event);
    };
    const lease = hold(fence, 'receiver-lease');
    await vi.advanceTimersByTimeAsync(10_000);
    const wait = waitForRfc64LegacySwmPromoteAdmissionV1(fence, CG, KA, { ...PROMOTE_BOUNDS, waitLimitMs: 120_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const retirement = hold(fence, 'finalized-vm-retirement', KA);
    await vi.advanceTimersByTimeAsync(5_000);
    lease.release();
    await lease.done;

    // The asset's fence went up at 15 s; it is a minute old at 75 s.
    await vi.advanceTimersByTimeAsync(54_999);
    expect(await settled(wait)).toEqual({ done: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(wait)).toEqual({ done: true, value: 'fence-age-limit' });
    expect(events.find((event) => event.kind === 'admission-wait')).toMatchObject({
      source: 'finalized-vm-retirement', scope: 'asset', elapsedMs: 65_000, waitEnd: 'fence-age-limit',
    });
    retirement.release();
    await retirement.done;
  });

  it('logs a promote that was admitted after a wait as information, and every other event as a warning', () => {
    const lines: string[] = [];
    const log = {
      info: (ctx: string, message: string) => { lines.push(`info ${ctx}: ${message}`); },
      warn: (ctx: string, message: string) => { lines.push(`warn ${ctx}: ${message}`); },
    };
    const observe = rfc64LegacySwmFenceEventLoggerV1(log, 'ctx');
    const base = { source: 'receiver-lease' as const, scope: 'graph' as const, contextGraphId: CG, elapsedMs: 6_000 };
    observe({ ...base, kind: 'admission-wait', kaUal: KA, waitEnd: 'unfenced' });
    observe({ ...base, kind: 'admission-wait', kaUal: KA, waitEnd: 'wait-limit' });
    observe({ ...base, kind: 'long-fence' });
    expect(lines).toEqual([
      `info ctx: A promote of ${KA} waited 6000 ms for the RFC-64 legacy SWM fence raised by receiver-lease on the graph of ${CG}`,
      `warn ctx: A promote of ${KA} stopped waiting after 6000 ms for the RFC-64 legacy SWM fence raised by `
        + `receiver-lease on the graph of ${CG} (wait-limit); the promote is refused, and a queued share is retried later`,
      `warn ctx: RFC-64 legacy SWM fence raised by receiver-lease on the graph of ${CG} was up for 6000 ms`,
    ]);
  });
});

describe('the promote waits with its own bounds behind a real boundary', () => {
  async function boundary() {
    const owner = {};
    const events: Rfc64LegacySwmFenceEventV1[] = [];
    await initializeRfc64LegacySwmBoundaryV1(owner, await secureDir(), new OxigraphStore(), {
      now: () => Date.now(),
      onFenceEvent: (event) => events.push(event),
    });
    return { owner, events };
  }

  const identity = (shareOperationId: string) => ({
    contextGraphId: BOUNDARY_CG, kaUal: BOUNDARY_UAL, shareOperationId, assertionVersion: '1',
  });

  it('is admitted when the receiver lease is released, long after the two-second wait of other seams', async () => {
    const { owner } = await boundary();
    fakeClock();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(owner, BOUNDARY_SCOPE);
    const promoteWait = awaitRfc64LegacySwmPromoteAdmissionV1(owner, BOUNDARY_CG, BOUNDARY_UAL);
    const ackWait = rfc64LateLegacySwmCompanionResolverV1(owner).awaitAdmission({
      contextGraphId: BOUNDARY_CG, kaUal: BOUNDARY_UAL,
    });

    await vi.advanceTimersByTimeAsync(RFC64_LEGACY_SWM_PREPARATION_ADMISSION_WAIT_MS);
    // The StorageACK seam keeps its short wait; the promote keeps waiting.
    expect(await settled(ackWait)).toEqual({ done: true, value: undefined });
    expect(await settled(promoteWait)).toEqual({ done: false });

    await vi.advanceTimersByTimeAsync(23_000);
    lease.release();
    expect(await settled(promoteWait)).toEqual({ done: true, value: undefined });
    prepareRfc64LateLegacySwmBoundaryV1(owner, BOUNDARY_CG, BOUNDARY_UAL, 'share-after-lease', '1').settle(false);
  });

  it('ends at its bound under a lease that stays, and the prepare is then refused as before', async () => {
    const { owner, events } = await boundary();
    fakeClock();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(owner, BOUNDARY_SCOPE);
    const promoteWait = awaitRfc64LegacySwmPromoteAdmissionV1(owner, BOUNDARY_CG, BOUNDARY_UAL);
    await vi.advanceTimersByTimeAsync(RFC64_LEGACY_SWM_PROMOTE_ADMISSION_WAIT_MS - 1);
    expect(await settled(promoteWait)).toEqual({ done: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(promoteWait)).toEqual({ done: true, value: undefined });
    expect(() => rfc64LateLegacySwmCompanionResolverV1(owner)(identity('refused-share')))
      .toThrow(/fence raised by receiver-lease on the graph, up 60000 ms/);
    expect(events.find((event) => event.kind === 'admission-wait')).toMatchObject({
      source: 'receiver-lease', kaUal: BOUNDARY_UAL, elapsedMs: 60_000,
    });

    // A later promote does not wait for the same lease again: it has been up for the limit.
    const laterWait = awaitRfc64LegacySwmPromoteAdmissionV1(owner, BOUNDARY_CG, BOUNDARY_UAL);
    expect(await settled(laterWait)).toEqual({ done: true, value: undefined });
    lease.release();
  });

  it('ends with the boundary of the node that begins to stop, and does nothing for an owner without one', async () => {
    const { owner } = await boundary();
    fakeClock();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(owner, BOUNDARY_SCOPE);
    const promoteWait = awaitRfc64LegacySwmPromoteAdmissionV1(owner, BOUNDARY_CG, BOUNDARY_UAL);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await settled(promoteWait)).toEqual({ done: false });

    endRfc64LegacySwmBoundaryAdmissionWaitsV1({});
    expect(await settled(promoteWait)).toEqual({ done: false });
    endRfc64LegacySwmBoundaryAdmissionWaitsV1(owner);
    expect(await settled(promoteWait)).toEqual({ done: true, value: undefined });
    expect(() => rfc64LateLegacySwmCompanionResolverV1(owner)(identity('share-at-stop')))
      .toThrow(/fence raised by receiver-lease on the graph/);
    lease.release();
  });

  it('resolves at once for an owner without a boundary and for a UAL the prepare refuses anyway', async () => {
    const { owner } = await boundary();
    fakeClock();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(owner, BOUNDARY_SCOPE);
    expect(await settled(awaitRfc64LegacySwmPromoteAdmissionV1({}, BOUNDARY_CG, BOUNDARY_UAL)))
      .toEqual({ done: true, value: undefined });
    expect(await settled(awaitRfc64LegacySwmPromoteAdmissionV1(owner, BOUNDARY_CG, 'not-a-ual')))
      .toEqual({ done: true, value: undefined });
    lease.release();
  });
});

describe("the agent's promote seam (real agent wiring)", () => {
  async function createAgent() {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'PromoteAdmissionNode',
      dataDir: await secureDir(),
      listenPort: 0,
      listenHost: '127.0.0.1',
      store,
      chainAdapter: new NoChainAdapter(),
      nodeRole: 'edge',
      skills: [],
    });
    agents.push(agent);
    await initializeRfc64LegacySwmBoundaryV1(agent, await secureDir(), store, { now: () => Date.now() });
    const resolver = (agent as any).publisher.resolveDurableRootPromotionAtomicCompanion;
    const input = (shareOperationId: string) => Object.freeze({
      contextGraphId: BOUNDARY_CG,
      assertionCoordinate: 'promote-admission-asset',
      lifecycleAgentAddress: BOUNDARY_SCOPE.authorAddress,
      kaUal: BOUNDARY_UAL,
      assertionVersion: '1',
      shareOperationId,
    });
    return { agent, resolver, input };
  }

  it('holds the promote behind a receiver lease until it is released, then admits it', async () => {
    const { agent, resolver, input } = await createAgent();
    fakeClock();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(agent, BOUNDARY_SCOPE);
    const wait = resolver.awaitAdmission({ contextGraphId: BOUNDARY_CG, kaUal: BOUNDARY_UAL });

    // The seam used to give up here, two seconds in, and the refused share waited about a minute for its retry.
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await settled(wait)).toEqual({ done: false });
    await vi.advanceTimersByTimeAsync(8_000);
    lease.release();
    expect(await settled(wait)).toEqual({ done: true, value: undefined });
    resolver(input('share-after-lease')).settle(false);
  });

  it('ends the wait when the node begins to stop, and the promote is refused for the queue to retry', async () => {
    const { agent, resolver, input } = await createAgent();
    fakeClock();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(agent, BOUNDARY_SCOPE);
    const wait = resolver.awaitAdmission({ contextGraphId: BOUNDARY_CG, kaUal: BOUNDARY_UAL });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await settled(wait)).toEqual({ done: false });

    agent.endLegacySwmShareAdmissionWaits();
    expect(await settled(wait)).toEqual({ done: true, value: undefined });
    let refusal: any;
    try {
      resolver(input('share-at-stop'));
    } catch (error) {
      refusal = error;
    }
    expect(refusal?.code).toBe('PROMOTE_RETRYABLE_FAILURE');
    lease.release();
  });

  it('still refuses with the retryable failure when the lease outlasts the wait', async () => {
    const { agent, resolver, input } = await createAgent();
    fakeClock();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(agent, BOUNDARY_SCOPE);
    const wait = resolver.awaitAdmission({ contextGraphId: BOUNDARY_CG, kaUal: BOUNDARY_UAL });
    await vi.advanceTimersByTimeAsync(RFC64_LEGACY_SWM_PROMOTE_ADMISSION_WAIT_MS);
    expect(await settled(wait)).toEqual({ done: true, value: undefined });

    let refusal: any;
    try {
      resolver(input('refused-share'));
    } catch (error) {
      refusal = error;
    }
    expect(refusal?.code).toBe('PROMOTE_RETRYABLE_FAILURE');
    expect(refusal?.cause?.code).toBe('RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS');
    lease.release();
  });
});
