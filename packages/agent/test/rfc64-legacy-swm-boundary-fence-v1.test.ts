// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  isRfc64LegacySwmBoundaryRetirementInProgressError,
  type AuthorCatalogScopeV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

import {
  acquireRfc64LegacySwmBoundaryReceiverLeaseV1,
  awaitRfc64LateLegacySwmBoundaryAdmissionV1,
  initializeRfc64LegacySwmBoundaryV1,
  markRfc64LegacySwmRepublishedV1,
  readRfc64LegacySwmBoundaryCountV1,
  retireRfc64LegacySwmAfterFinalizedVmV1,
  rfc64LateLegacySwmCompanionResolverV1,
} from '../src/rfc64/legacy-swm-boundary-v1.js';

import {
  assertRfc64LegacySwmPreparationAdmittedV1,
  beginRfc64LegacySwmPreparationV1,
  createRfc64LegacySwmFenceCoordinatorV1,
  describeRfc64LegacySwmFenceEventV1,
  runRfc64LegacySwmRetirementV1,
  waitForRfc64LegacySwmPreparationAdmissionV1,
  type Rfc64LegacySwmFenceEventV1,
} from '../src/rfc64/legacy-swm-boundary-fence-v1.js';

const CG = 'fence-graph';
const OTHER_CG = 'other-graph';
const KA = 'did:dkg:test:31337/0x1111111111111111111111111111111111111111/1';
const OTHER_KA = 'did:dkg:test:31337/0x1111111111111111111111111111111111111111/2';

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

function refusalOf(action: () => void): Error & Record<string, unknown> {
  try {
    action();
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error('expected a refusal');
}

const tick = () => new Promise<void>((resolve) => { setImmediate(resolve); });

describe('RFC-64 legacy SWM fence coordinator', () => {
  it('names the caller, the scope and the age of the fence in a refusal', async () => {
    let now = 1_000;
    const fence = createRfc64LegacySwmFenceCoordinatorV1({ now: () => now });
    const held = gate();
    const retirement = runRfc64LegacySwmRetirementV1(
      fence,
      { source: 'finalized-vm-retirement', contextGraphId: CG, kaUal: KA },
      () => held.promise,
    );
    await tick();
    now += 42;

    const refusal = refusalOf(() => assertRfc64LegacySwmPreparationAdmittedV1(fence, CG, KA));
    expect(isRfc64LegacySwmBoundaryRetirementInProgressError(refusal)).toBe(true);
    expect(refusal.message).toBe(
      'RFC-64 legacy SWM boundary retirement is in progress; retry promotion '
        + '(fence raised by finalized-vm-retirement on the asset, up 42 ms)',
    );
    expect(refusal).toMatchObject({
      fenceSource: 'finalized-vm-retirement',
      fenceScope: 'asset',
      fenceAgeMs: 42,
    });
    // Another asset of the graph is not fenced by an asset retirement.
    expect(() => assertRfc64LegacySwmPreparationAdmittedV1(fence, CG, OTHER_KA)).not.toThrow();

    held.open();
    await expect(retirement).resolves.toEqual({ ran: true, value: undefined });
    expect(() => assertRfc64LegacySwmPreparationAdmittedV1(fence, CG, KA)).not.toThrow();
    expect(fence.scopes.size).toBe(0);
  });

  it('attributes a graph fence to the oldest of its holders', async () => {
    const fence = createRfc64LegacySwmFenceCoordinatorV1();
    const lease = gate();
    const first = runRfc64LegacySwmRetirementV1(
      fence, { source: 'receiver-lease', contextGraphId: CG }, () => lease.promise,
    );
    const second = runRfc64LegacySwmRetirementV1(
      fence, { source: 'republish-retirement', contextGraphId: CG }, async () => 'retired',
    );
    await tick();

    expect(refusalOf(() => assertRfc64LegacySwmPreparationAdmittedV1(fence, CG, KA))).toMatchObject({
      fenceSource: 'receiver-lease',
      fenceScope: 'graph',
    });
    lease.open();
    await first;
    await expect(second).resolves.toEqual({ ran: true, value: 'retired' });
  });

  it('gives up on a preparation that never settles, drops its fence and frees the chain', async () => {
    const events: Rfc64LegacySwmFenceEventV1[] = [];
    const fence = createRfc64LegacySwmFenceCoordinatorV1({
      waitLimitMs: 20,
      onFenceEvent: (event) => events.push(event),
    });
    const releaseStuck = beginRfc64LegacySwmPreparationV1(fence, CG, KA);
    let ran = false;
    const stuck = runRfc64LegacySwmRetirementV1(
      fence,
      { source: 'republish-retirement', contextGraphId: CG },
      async () => { ran = true; },
    );
    // Queued behind the stuck retirement on the node-wide chain.
    const behind = runRfc64LegacySwmRetirementV1(
      fence,
      { source: 'finalized-vm-retirement', contextGraphId: OTHER_CG, kaUal: OTHER_KA },
      async () => 'retired',
    );
    expect(() => assertRfc64LegacySwmPreparationAdmittedV1(fence, CG, OTHER_KA)).toThrow();

    await expect(stuck).resolves.toEqual({ ran: false });
    expect(ran).toBe(false);
    expect(() => assertRfc64LegacySwmPreparationAdmittedV1(fence, CG, OTHER_KA)).not.toThrow();
    await expect(behind).resolves.toEqual({ ran: true, value: 'retired' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'wait-exceeded',
      source: 'republish-retirement',
      scope: 'graph',
      contextGraphId: CG,
      waitingOn: 'preparations',
      activePreparations: 1,
    });
    expect(describeRfc64LegacySwmFenceEventV1(events[0]!)).toMatch(
      /raised by republish-retirement on the graph of fence-graph gave up after \d+ ms waiting on preparations \(1 preparation\(s\) in flight\); nothing was retired/,
    );

    // The preparation settling later does not start the abandoned retirement.
    releaseStuck();
    await tick();
    expect(ran).toBe(false);
    expect(fence.scopes.size).toBe(0);
  });

  it('gives up while still waiting for its turn on the chain and then does nothing', async () => {
    const events: Rfc64LegacySwmFenceEventV1[] = [];
    const fence = createRfc64LegacySwmFenceCoordinatorV1({
      waitLimitMs: 20,
      longFenceMs: 60_000,
      onFenceEvent: (event) => events.push(event),
    });
    const lease = gate();
    const holder = runRfc64LegacySwmRetirementV1(
      fence, { source: 'receiver-lease', contextGraphId: OTHER_CG }, () => lease.promise,
    );
    let ran = false;
    const waiting = runRfc64LegacySwmRetirementV1(
      fence,
      { source: 'finalized-vm-retirement', contextGraphId: CG, kaUal: KA },
      async () => { ran = true; },
    );

    await expect(waiting).resolves.toEqual({ ran: false });
    expect(events.map((event) => [event.kind, event.waitingOn])).toEqual([
      ['wait-exceeded', 'mutation-chain'],
    ]);
    expect(() => assertRfc64LegacySwmPreparationAdmittedV1(fence, CG, KA)).not.toThrow();

    lease.open();
    await holder;
    await tick();
    expect(ran).toBe(false);
  });

  it('does not bound the work itself, and reports a fence that was up for long', async () => {
    let now = 0;
    const events: Rfc64LegacySwmFenceEventV1[] = [];
    const fence = createRfc64LegacySwmFenceCoordinatorV1({
      now: () => now,
      waitLimitMs: 10,
      longFenceMs: 5_000,
      onFenceEvent: (event) => { events.push(event); throw new Error('observer failure is contained'); },
    });
    const outcome = await runRfc64LegacySwmRetirementV1(
      fence,
      { source: 'receiver-lease', contextGraphId: CG },
      async () => {
        await new Promise<void>((resolve) => { setTimeout(resolve, 40); });
        now = 7_500;
        return 'done';
      },
    );
    expect(outcome).toEqual({ ran: true, value: 'done' });
    expect(events).toEqual([{
      kind: 'long-fence',
      source: 'receiver-lease',
      scope: 'graph',
      contextGraphId: CG,
      elapsedMs: 7_500,
    }]);
    expect(describeRfc64LegacySwmFenceEventV1(events[0]!)).toBe(
      'RFC-64 legacy SWM fence raised by receiver-lease on the graph of fence-graph was up for 7500 ms',
    );
  });

  it('lets the work drop the fence before it settles, and passes a failure through', async () => {
    const fence = createRfc64LegacySwmFenceCoordinatorV1();
    const held = gate();
    const dropped = gate();
    const lease = runRfc64LegacySwmRetirementV1(
      fence,
      { source: 'receiver-lease', contextGraphId: CG },
      async (dropFence) => {
        dropFence();
        dropped.open();
        await held.promise;
        throw new Error('work failed');
      },
    );
    await dropped.promise;
    expect(() => assertRfc64LegacySwmPreparationAdmittedV1(fence, CG, KA)).not.toThrow();
    held.open();
    await expect(lease).rejects.toThrow('work failed');
    // The chain is not poisoned by the failure.
    await expect(runRfc64LegacySwmRetirementV1(
      fence, { source: 'republish-retirement', contextGraphId: CG }, async () => 1,
    )).resolves.toEqual({ ran: true, value: 1 });
  });

  it('waits for in-flight preparations of its own scope only', async () => {
    const fence = createRfc64LegacySwmFenceCoordinatorV1();
    const releaseOther = beginRfc64LegacySwmPreparationV1(fence, CG, OTHER_KA);
    await expect(runRfc64LegacySwmRetirementV1(
      fence,
      { source: 'finalized-vm-retirement', contextGraphId: CG, kaUal: KA },
      async () => 'retired',
    )).resolves.toEqual({ ran: true, value: 'retired' });

    let ran = false;
    const graphWide = runRfc64LegacySwmRetirementV1(
      fence, { source: 'republish-retirement', contextGraphId: CG }, async () => { ran = true; },
    );
    await tick();
    expect(ran).toBe(false);
    releaseOther();
    await graphWide;
    expect(ran).toBe(true);
    expect(() => releaseOther()).toThrow('settlement is unbalanced');
  });

  describe('admission wait', () => {
    it('resolves at once when nothing fences the asset', async () => {
      const fence = createRfc64LegacySwmFenceCoordinatorV1();
      await waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 60_000);
    });

    it('resolves when the last fence over the asset drops', async () => {
      const fence = createRfc64LegacySwmFenceCoordinatorV1();
      const graphHeld = gate();
      const assetHeld = gate();
      const graphFence = runRfc64LegacySwmRetirementV1(
        fence, { source: 'receiver-lease', contextGraphId: CG }, () => graphHeld.promise,
      );
      const assetFence = runRfc64LegacySwmRetirementV1(
        fence,
        { source: 'finalized-vm-retirement', contextGraphId: CG, kaUal: KA },
        () => assetHeld.promise,
      );
      let admitted = false;
      const wait = waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 60_000)
        .then(() => { admitted = true; });

      graphHeld.open();
      await graphFence;
      await tick();
      expect(admitted).toBe(false);

      assetHeld.open();
      await assetFence;
      await wait;
      expect(() => assertRfc64LegacySwmPreparationAdmittedV1(fence, CG, KA)).not.toThrow();
    });

    it('gives the asset back to the caller at its bound while the fence is still up', async () => {
      const fence = createRfc64LegacySwmFenceCoordinatorV1();
      const held = gate();
      const lease = runRfc64LegacySwmRetirementV1(
        fence, { source: 'receiver-lease', contextGraphId: CG }, () => held.promise,
      );
      await waitForRfc64LegacySwmPreparationAdmissionV1(fence, CG, KA, 15);
      expect(() => assertRfc64LegacySwmPreparationAdmittedV1(fence, CG, KA)).toThrow(
        /raised by receiver-lease on the graph/,
      );
      held.open();
      await lease;
    });
  });
});

const BOUNDARY_CG = '0x1111111111111111111111111111111111111111/legacy-boundary';
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

describe('RFC-64 legacy SWM boundary behind the fence coordinator', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function boundary(waitLimitMs?: number) {
    const root = await mkdtemp(join(tmpdir(), 'dkg-rfc64-legacy-fence-'));
    await chmod(root, 0o700);
    roots.push(root);
    const owner = {};
    const events: Rfc64LegacySwmFenceEventV1[] = [];
    await initializeRfc64LegacySwmBoundaryV1(owner, root, new OxigraphStore(), {
      ...(waitLimitMs === undefined ? {} : { waitLimitMs }),
      onFenceEvent: (event) => events.push(event),
    });
    return { owner, events, resolver: rfc64LateLegacySwmCompanionResolverV1(owner) };
  }

  it('a share that never settles ends each retirement at the bound, with nothing retired and a named cause', async () => {
    const { owner, events, resolver } = await boundary(20);
    const stuck = resolver({
      contextGraphId: BOUNDARY_CG, kaUal: BOUNDARY_UAL, shareOperationId: 'stuck-share', assertionVersion: '1',
    });

    await expect(retireRfc64LegacySwmAfterFinalizedVmV1(owner, BOUNDARY_CG, BOUNDARY_UAL, '1'))
      .resolves.toBe(false);
    // A rejection, so the projection pass fails and its supervisor repeats it.
    await expect(markRfc64LegacySwmRepublishedV1(
      owner, BOUNDARY_CG, [{ kaUal: BOUNDARY_UAL, assertionVersion: '1' }],
    )).rejects.toThrow('RFC-64 legacy SWM republish retirement did not get its turn in time');
    await expect(acquireRfc64LegacySwmBoundaryReceiverLeaseV1(owner, BOUNDARY_SCOPE))
      .rejects.toThrow('RFC-64 legacy SWM boundary lease was not acquired in time');

    expect(readRfc64LegacySwmBoundaryCountV1(owner, BOUNDARY_CG)).toBe(1);
    expect(events.map((event) => [event.kind, event.source, event.scope, event.waitingOn])).toEqual([
      ['wait-exceeded', 'finalized-vm-retirement', 'asset', 'preparations'],
      ['wait-exceeded', 'republish-retirement', 'graph', 'preparations'],
      ['wait-exceeded', 'receiver-lease', 'graph', 'preparations'],
    ]);
    expect(events[0]).toMatchObject({ contextGraphId: BOUNDARY_CG, kaUal: BOUNDARY_UAL });

    // No fence is left behind, and the repeated pass retires the marker once
    // the share has settled, with no other change to the inventory.
    stuck.settle(true);
    await markRfc64LegacySwmRepublishedV1(
      owner, BOUNDARY_CG, [{ kaUal: BOUNDARY_UAL, assertionVersion: '1' }],
    );
    expect(readRfc64LegacySwmBoundaryCountV1(owner, BOUNDARY_CG)).toBe(0);
    resolver({
      contextGraphId: BOUNDARY_CG, kaUal: BOUNDARY_UAL, shareOperationId: 'next-share', assertionVersion: '1',
    }).settle(false);
  });

  it('the resolver admission wait ends when the lease is released, and the prepare is then admitted', async () => {
    const { owner, resolver } = await boundary();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(owner, BOUNDARY_SCOPE);
    const identity = {
      contextGraphId: BOUNDARY_CG, kaUal: BOUNDARY_UAL, shareOperationId: 'share-after-lease', assertionVersion: '1',
    };
    expect(() => resolver(identity)).toThrow(/fence raised by receiver-lease on the graph, up \d+ ms/);

    let admitted = false;
    const wait = resolver.awaitAdmission(identity).then(() => { admitted = true; });
    await tick();
    expect(admitted).toBe(false);
    lease.release();
    await wait;
    resolver(identity).settle(false);
  });

  it('the admission wait is bounded, and resolves at once for input the prepare refuses anyway', async () => {
    const { owner } = await boundary();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(owner, BOUNDARY_SCOPE);
    await awaitRfc64LateLegacySwmBoundaryAdmissionV1(owner, BOUNDARY_CG, BOUNDARY_UAL, 15);
    await awaitRfc64LateLegacySwmBoundaryAdmissionV1(owner, BOUNDARY_CG, 'not-a-ual');
    await awaitRfc64LateLegacySwmBoundaryAdmissionV1({}, BOUNDARY_CG, BOUNDARY_UAL);
    lease.release();
  });
});
