/**
 * GH#3081 — a confirmed publication is terminal once its catalog placement is durably owed, not
 * once the placement was attempted.
 *
 * The terminal boundary of a publication on a finalized private lane is: chain finality observed,
 * VM content materialized, the placement marker stored, and the placement requested from the
 * catalog supervisor. Every row runs the real async publisher (queue, detached execution,
 * reconciliation walk, terminal write) against the agent's real completion tail, recovery
 * finalizer, post-confirmation observer, finalized-private supervisor and catalog repair. A
 * placement is parked from inside the real repair body, where it starts to produce its successor
 * and holds the asset lock and the catalog mutation lock, exactly as a slow placement does.
 *
 * The fixture clock moves only where a row moves it, so a job's wait after finality is exactly
 * the time the row let pass before the terminal record was written.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/named-ka-publish-recovery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/named-ka-publish-recovery.js')>(),
  // The chain normalization needs an adapter bound to the asset's chain; it answers here as it
  // does for a publish that is the asset's current version. Everything after it is real.
  normalizeRecoveredNamedKaPublish: async (
    input: Parameters<typeof recoveredNamedKaPublishV1>[0],
  ) => recoveredNamedKaPublishV1(input),
}));

import { resolveDurableGraphScopedAuthorSealCandidateV1 } from '../src/durable-author-seal-resolver-v1.js';
import {
  AUTHOR,
  CONTEXT_GRAPH_ID,
} from './support/rfc64-local-catalog-repair-fixture.js';
import {
  confirmedSynchronousPublishTailV1,
  createPublicationPathV1,
  drivePublicationsV1,
  fulfilledWithinV1,
  recoveredNamedKaPublishV1,
  reopenForEditingV1,
  seedPlacementAssetV1,
  settledWithinV1,
  startPlacementAgentV1,
  untilV1,
  type PlacementAgentV1,
  type PlacementAssetV1,
  type PlacementCountsV1,
} from './support/rfc64-publication-placement-fixture.js';

function fields(line: string): Record<string, string> {
  return Object.fromEntries(line.split(' ').slice(1).map((pair) => {
    const separator = pair.indexOf('=');
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

/** The real steps of the placements that ran between two readings. */
function since(before: PlacementCountsV1, after: PlacementCountsV1): PlacementCountsV1 {
  return {
    repairs: after.repairs - before.repairs,
    coverageChecks: after.coverageChecks - before.coverageChecks,
    successors: after.successors - before.successors,
    signatures: after.signatures - before.signatures,
    announcements: after.announcements - before.announcements,
  };
}

/** The steps of the terminal boundary, without the supervisor's own interleaved events. */
function boundary(events: readonly string[]): string[] {
  return events.filter((event) => !event.startsWith('coverage-proof:') && !event.startsWith('marker-retired:'));
}

/** How each detached execution ended; the publisher itself swallows what one rejects with. */
function executions(events: readonly string[]): string[] {
  return events.filter((event) => event.startsWith('executor-'));
}

/** What happened to the markers: stored, proved covered or not, retired. */
function markerLife(events: readonly string[]): string[] {
  return events.filter((event) => /^(marker-stored|coverage-proof|marker-retired):/.test(event));
}

/** Whether the assertion of `asset` still carries an active author seal, as the repair reads it. */
async function hasActiveSeal(fixture: PlacementAgentV1, asset: PlacementAssetV1): Promise<boolean> {
  return await resolveDurableGraphScopedAuthorSealCandidateV1({
    store: fixture.agent.store,
    contextGraphId: CONTEXT_GRAPH_ID,
    agentAddress: AUTHOR,
    assertionCoordinate: asset.assertionCoordinate,
    source: 'test.placement.activeSeal',
  }) !== undefined;
}

/** Author signatures the fixture counts: three for a catalog genesis, three for each successor. */
const GENESIS_SIGNATURES = 3;
const SUCCESSOR_SIGNATURES = 3;
const FIRST_PLACEMENT_SIGNATURES = GENESIS_SIGNATURES + SUCCESSOR_SIGNATURES;

describe('a confirmed publication and its catalog placement', () => {
  it('finalizes the job while the placement is parked, and releasing it completes the placement', async () => {
    const fixture = await startPlacementAgentV1({ name: 'terminal-before-placement' });
    const { agent, clock } = fixture;
    const asset = await seedPlacementAssetV1(agent, 'held', 91n);
    const path = createPublicationPathV1(fixture);
    const parked = fixture.holdPlacements();
    const seeded = fixture.counts();
    try {
      const jobId = await path.enqueue(asset);
      expect((await path.broadcast('wallet-1'))?.status).toBe('broadcast');
      // The executor tail observed the confirmation and the supervisor admitted the placement,
      // which is now parked inside the real repair body, before its applied-head CAS.
      await parked.entered();
      expect(fixture.markers()).toHaveLength(1);
      expect(fixture.catalogRows()).toBeNull();

      // Finality is observed at 1 s on the fixture clock, which then stands still until the row
      // releases the placement: any wait the job sees is the placement's.
      clock.now = 1_000;
      // The executor tail returns although its placement attempt has not ended.
      await fulfilledWithinV1(path.publisher.drainDetachedExecutions(), 'the executor tail');
      // Recovery proves the transaction, observes the same confirmation again from the agent's
      // recovery finalizer, and writes the terminal record: one job reconciled.
      expect(await fulfilledWithinV1(path.publisher.recover(), 'the recovery pass')).toBe(1);

      const job = await path.job(jobId);
      expect(job?.status).toBe('finalized');
      expect(job?.timestamps).toMatchObject({ finalityObservedAt: 1_000, finalizedAt: 1_000 });
      expect(await path.postFinalityWaitMs(jobId)).toBe(0);

      // The boundary, in order, for both completion paths: each stored the marker and asked the
      // supervisor for the placement before it returned, and recovery proved finality and the VM
      // content first.
      expect(boundary(fixture.events())).toEqual([
        'marker-stored:repair-held',
        'placement-requested:repair-held:accepted',
        'executor-settled:repair-held',
        'finality-observed:repair-held',
        'vm-materialization:promoted',
        'marker-stored:repair-held',
        'placement-requested:repair-held:accepted',
        'recovery-finalized:repair-held',
      ]);

      // The placement is still owed. Its marker is durable, its one attempt is still running (the
      // catalog genesis is signed, the successor is not), the second observation did not start
      // another, and status reports the backlog.
      expect(parked.parked()).toBe(1);
      expect(fixture.markers()).toHaveLength(1);
      expect(fixture.catalogRows()).toBeNull();
      expect(since(seeded, fixture.counts())).toEqual({
        repairs: 1, coverageChecks: 1, successors: 1, signatures: GENESIS_SIGNATURES, announcements: 0,
      });
      expect(fixture.queue()).toMatchObject({ pending: 1, oldestPendingAgeMs: 1_000, passRunning: true });
      expect(fixture.placementLines()).toEqual([]);

      // The confirmed-version fence was set before the observer's first await and does not end
      // with it: the exact promotion stays fenced while its placement runs.
      await expect(agent.recordRfc64SwmAuthorInventoryShadowV1({
        contextGraphId: CONTEXT_GRAPH_ID,
        assertionCoordinate: asset.assertionCoordinate,
        lifecycleAgentAddress: AUTHOR,
        shareOperationId: asset.shareOperationId,
      })).resolves.toMatchObject({ status: 'dormant', dormantReason: 'vm-confirmed' });

      clock.now = 61_000;
      parked.release();
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();

      // Releasing it completes the placement, once, for both observations.
      expect(fixture.markers()).toEqual([]);
      expect(fixture.catalogRows()).toBe('1');
      expect(since(seeded, fixture.counts())).toEqual({
        repairs: 1, coverageChecks: 1, successors: 1, signatures: FIRST_PLACEMENT_SIGNATURES, announcements: 1,
      });
      expect(fixture.queue()).toMatchObject({ pending: 0, oldestPendingAgeMs: null, waiters: 0, passRunning: false });
      // Each observation's line is written at that release: 61 s from the executor tail's call,
      // 60 s from recovery's, which joined the attempt already in flight.
      expect(fixture.placementLines().map(fields)).toEqual([
        expect.objectContaining({
          observerCall: '1', outcome: 'completed', covered: 'false', source: jobId,
          totalMs: '61000', queueMs: '0', attemptMs: '61000', successorMs: '61000',
        }),
        expect.objectContaining({
          observerCall: '2', outcome: 'completed', source: jobId, totalMs: '60000', queueMs: '0', attemptMs: '60000',
        }),
      ]);
    } finally {
      parked.release();
      await path.publisher.drainDetachedExecutions();
    }
  }, 120_000);

  it('keeps the job live until recovery has proved the VM content, then finalizes it without the placement', async () => {
    const fixture = await startPlacementAgentV1({ name: 'terminal-needs-vm-content' });
    const { agent, clock } = fixture;
    const asset = await seedPlacementAssetV1(agent, 'vm-content', 92n);
    const path = createPublicationPathV1(fixture);
    const parked = fixture.holdPlacements();
    try {
      // The VM content is verified, and its confirmed metadata is not written yet.
      path.materialization = 'verified-vm-metadata-pending';
      const jobId = await path.enqueue(asset);
      await path.broadcast('wallet-1');
      await parked.entered();
      await fulfilledWithinV1(path.publisher.drainDetachedExecutions(), 'the executor tail');

      // Finality is observed, and the executor tail already stored the marker and requested the
      // placement. Recovery still cannot prove the VM content, so the pass settles nothing and
      // the record stays live.
      clock.now = 1_000;
      expect(await fulfilledWithinV1(path.publisher.recover(), 'the recovery pass without VM content')).toBe(0);
      expect((await path.job(jobId))?.status).toBe('broadcast');
      expect(boundary(fixture.events())).toEqual([
        'marker-stored:repair-vm-content',
        'placement-requested:repair-vm-content:accepted',
        'executor-settled:repair-vm-content',
        'finality-observed:repair-vm-content',
        'vm-materialization:verified-vm-metadata-pending',
      ]);

      // Once the VM content is there the next pass finalizes the job. The second it waited was
      // for the VM content; the placement is parked throughout.
      path.materialization = 'promoted';
      clock.now = 2_000;
      expect(await fulfilledWithinV1(path.publisher.recover(), 'the recovery pass with VM content')).toBe(1);
      expect((await path.job(jobId))?.status).toBe('finalized');
      expect(await path.postFinalityWaitMs(jobId)).toBe(1_000);
      expect(parked.parked()).toBe(1);
      expect(fixture.markers()).toHaveLength(1);
    } finally {
      parked.release();
      await path.publisher.drainDetachedExecutions();
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    }
  }, 120_000);

  it('finalizes a burst in one reconciliation pass while every placement is still owed', async () => {
    const fixture = await startPlacementAgentV1({ name: 'terminal-burst' });
    const { agent, clock } = fixture;
    const path = createPublicationPathV1(fixture);
    const parked = fixture.holdPlacements();
    const jobIds: string[] = [];
    try {
      for (let index = 0; index < 6; index += 1) {
        const asset = await seedPlacementAssetV1(agent, `burst-${index}`, BigInt(100 + index));
        jobIds.push(await path.enqueue(asset));
        await path.broadcast(`wallet-${index}`);
      }
      const seeded = fixture.counts();
      // The supervisor runs one placement at a time: the first is parked, five are queued behind it.
      await parked.entered();
      clock.now = 1_000;
      await fulfilledWithinV1(path.publisher.drainDetachedExecutions(), 'the six executor tails');
      expect(executions(fixture.events())).toEqual(
        Array.from({ length: 6 }, (_, index) => `executor-settled:repair-burst-${index}`),
      );
      // One pass of the recovery walk finalizes all six. No job waits behind another job's
      // placement, and none waits for its own.
      expect(await fulfilledWithinV1(path.publisher.recover(), 'the recovery pass')).toBe(6);
      expect(await Promise.all(jobIds.map(async (jobId) => (await path.job(jobId))?.status)))
        .toEqual(Array.from({ length: 6 }, () => 'finalized'));
      expect(await Promise.all(jobIds.map((jobId) => path.postFinalityWaitMs(jobId))))
        .toEqual([0, 0, 0, 0, 0, 0]);

      // Nothing waits on the backlog, and status still shows it: six placements owed, the oldest
      // known for a second, one attempt running. No asset, author or graph is named.
      expect(fixture.markers()).toHaveLength(6);
      expect(parked.entries()).toBe(1);
      expect(fixture.queue()).toMatchObject({ pending: 6, oldestPendingAgeMs: 1_000, passRunning: true });
      expect(Object.keys(fixture.queue()!).sort()).toEqual([
        'cooldownSkips', 'depth', 'lastPassDurationMs', 'oldestPendingAgeMs', 'oldestWaiterAgeMs',
        'passRunning', 'pending', 'waiters',
      ]);

      // The supervisor works the backlog off one placement at a time, 20 s each on the fixture clock.
      for (let placed = 1; placed <= 6; placed += 1) {
        await parked.entered(placed);
        clock.now += 20_000;
        parked.releaseNext();
        await untilV1(() => fixture.queue()?.pending === 6 - placed, `placement ${placed} is retired`);
        expect(fixture.markers()).toHaveLength(6 - placed);
      }
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
      expect(fixture.catalogRows()).toBe('6');
      expect(fixture.queue()).toMatchObject({ pending: 0, oldestPendingAgeMs: null, waiters: 0, passRunning: false });
      // Twelve observations, six placements: one successor and one announcement per asset.
      expect(since(seeded, fixture.counts())).toEqual({
        repairs: 6,
        coverageChecks: 6,
        successors: 6,
        signatures: GENESIS_SIGNATURES + 6 * SUCCESSOR_SIGNATURES,
        announcements: 6,
      });
    } finally {
      parked.release();
      await path.publisher.drainDetachedExecutions();
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    }
  }, 240_000);

  it('observes a confirmation again from recovery without a second successor, signature or announcement', async () => {
    const fixture = await startPlacementAgentV1({ name: 'terminal-idempotent' });
    const { agent } = fixture;
    const asset = await seedPlacementAssetV1(agent, 'again', 93n);
    const path = createPublicationPathV1(fixture);
    const seeded = fixture.counts();

    // The executor tail observes the confirmation and its placement runs to the end.
    const jobId = await path.enqueue(asset);
    await path.broadcast('wallet-1');
    await path.publisher.drainDetachedExecutions();
    expect(executions(fixture.events())).toEqual(['executor-settled:repair-again']);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    const placed = fixture.counts();
    expect(since(seeded, placed)).toEqual({
      repairs: 1, coverageChecks: 1, successors: 1, signatures: FIRST_PLACEMENT_SIGNATURES, announcements: 1,
    });
    expect(fixture.markers()).toEqual([]);
    expect(fixture.catalogRows()).toBe('1');

    // Recovery observes the same confirmation. The marker returns and the supervisor visits it
    // once more; the positive proof that the catalog covers the row is all that retires it.
    expect(await path.publisher.recover()).toBe(1);
    expect((await path.job(jobId))?.status).toBe('finalized');
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(since(placed, fixture.counts())).toEqual({
      repairs: 1, coverageChecks: 1, successors: 0, signatures: 0, announcements: 0,
    });
    expect(fixture.markers()).toEqual([]);
    expect(fixture.catalogRows()).toBe('1');
    expect(markerLife(fixture.events())).toEqual([
      'marker-stored:repair-again',
      'coverage-proof:repair-again:false',
      'marker-retired:repair-again',
      'marker-stored:repair-again',
      'coverage-proof:repair-again:true',
      'marker-retired:repair-again',
    ]);
  }, 120_000);

  it('finalizes a held failed job without keeping the claim lock for its placement', async () => {
    const fixture = await startPlacementAgentV1({ name: 'terminal-held-failed' });
    const { agent, clock } = fixture;
    const asset = await seedPlacementAssetV1(agent, 'held-failed', 94n);
    const other = await seedPlacementAssetV1(agent, 'other', 95n);
    const path = createPublicationPathV1(fixture);
    const parked = fixture.holdPlacements();
    try {
      const jobId = await path.failAfterBroadcast(asset);
      expect((await path.job(jobId))?.status).toBe('failed');

      // The chain-proof dispatcher finalizes the held job inside the node-wide claim transaction.
      // The observer returns there with the placement owed, so the transaction ends.
      clock.now = 1_000;
      expect(await fulfilledWithinV1(path.publisher.recover(), 'the recovery pass')).toBe(1);
      expect((await path.job(jobId))?.status).toBe('finalized');
      expect(await path.postFinalityWaitMs(jobId)).toBe(0);

      // The placement runs after it, and the claim lock is free while it is parked: another
      // publish is admitted, and a wallet claims exactly that job.
      await parked.entered();
      const otherJobId = await fulfilledWithinV1(path.enqueue(other), 'the admission of another publish');
      expect(otherJobId).not.toBe(jobId);
      const claimed = await fulfilledWithinV1(path.publisher.claimNext('wallet-2'), 'the claim of another publish');
      expect(claimed).toMatchObject({ jobId: otherJobId, status: 'claimed', claim: { walletId: 'wallet-2' } });
      expect(parked.parked()).toBe(1);
      expect(fixture.markers()).toHaveLength(1);
    } finally {
      parked.release();
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    }
    expect(fixture.markers()).toEqual([]);
    expect(fixture.catalogRows()).toBe('1');
  }, 120_000);

  it('returns from the tail a synchronous publish awaits while the placement is parked', async () => {
    const fixture = await startPlacementAgentV1({ name: 'terminal-sync-tail' });
    const { agent } = fixture;
    const asset = await seedPlacementAssetV1(agent, 'sync', 96n);
    const parked = fixture.holdPlacements();
    try {
      // `publishFromFinalizedAssertion` ends in this call and returns its result right after it.
      // It completes, and does so while the placement it requested is parked.
      expect(await settledWithinV1(confirmedSynchronousPublishTailV1(agent, asset)))
        .toEqual({ status: 'fulfilled', value: undefined });
      await parked.entered();
      expect(parked.parked()).toBe(1);
      expect(boundary(fixture.events())).toEqual([
        'marker-stored:repair-sync',
        'placement-requested:repair-sync:accepted',
      ]);
      expect(fixture.markers()).toHaveLength(1);
    } finally {
      parked.release();
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    }
    expect(fixture.markers()).toEqual([]);
    expect(fixture.catalogRows()).toBe('1');
  }, 120_000);

  it('places a publication whose assertion was re-opened for editing while its placement was queued', async () => {
    const fixture = await startPlacementAgentV1({ name: 'terminal-reopened' });
    const { agent, clock } = fixture;
    const blocking = await seedPlacementAssetV1(agent, 'blocking', 120n);
    const reopened = await seedPlacementAssetV1(agent, 'reopened', 121n);
    const path = createPublicationPathV1(fixture);
    const parked = fixture.holdPlacements();
    try {
      const jobIds = [await path.enqueue(blocking)];
      await path.broadcast('wallet-1');
      await parked.entered();
      jobIds.push(await path.enqueue(reopened));
      await path.broadcast('wallet-2');
      clock.now = 1_000;
      await fulfilledWithinV1(path.publisher.drainDetachedExecutions(), 'the executor tails');
      expect(executions(fixture.events())).toEqual([
        'executor-settled:repair-blocking',
        'executor-settled:repair-reopened',
      ]);
      expect(await fulfilledWithinV1(path.publisher.recover(), 'the recovery pass')).toBe(2);
      // Both publications are terminal. The second one's placement is owed and has not started:
      // it is queued behind the first, which is parked.
      expect(await Promise.all(jobIds.map(async (jobId) => (await path.job(jobId))?.status)))
        .toEqual(['finalized', 'finalized']);
      expect(fixture.markers()).toHaveLength(2);
      expect(parked.entries()).toBe(1);
      expect(fixture.events().filter((event) => event.startsWith('coverage-proof:')))
        .toEqual(['coverage-proof:repair-blocking:false']);

      // Its publication has returned, so the author goes on editing it. The pull-from archives
      // the published version's seal and clears the active one, which the queued placement was
      // still going to read.
      expect(await hasActiveSeal(fixture, reopened)).toBe(true);
      await reopenForEditingV1(agent, reopened);
      expect(await hasActiveSeal(fixture, reopened)).toBe(false);

      // The placement still runs for the version that was published: the marker names its seal
      // by digest, and the archived copy is that seal.
      const before = fixture.counts();
      parked.release();
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
      expect(markerLife(fixture.events()).slice(-3)).toEqual([
        'marker-retired:repair-blocking',
        'coverage-proof:repair-reopened:false',
        'marker-retired:repair-reopened',
      ]);
      expect(fixture.markers()).toEqual([]);
      expect(fixture.catalogRows()).toBe('2');
      expect(since(before, fixture.counts())).toMatchObject({ repairs: 1, successors: 1, announcements: 2 });
      expect(fixture.queue()).toMatchObject({ pending: 0, oldestPendingAgeMs: null, waiters: 0 });
      expect(fixture.placementLines().map(fields).map(({ source, outcome }) => ({ source, outcome }))).toEqual([
        { source: jobIds[0], outcome: 'completed' },
        { source: jobIds[0], outcome: 'completed' },
        { source: jobIds[1], outcome: 'completed' },
        { source: jobIds[1], outcome: 'completed' },
      ]);
    } finally {
      parked.release();
      await path.publisher.drainDetachedExecutions();
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    }
  }, 120_000);

  it('finalizes a publication whose marker could not be stored, and says that nothing owes its placement', async () => {
    // What happens when the marker write itself fails: the observer logs and the publication
    // finalizes with no obligation behind it. This row records that behaviour; it does not
    // endorse it. Making the write a condition of the terminal record is a follow-up.
    const fixture = await startPlacementAgentV1({ name: 'terminal-marker-write-fails' });
    const { agent } = fixture;
    const asset = await seedPlacementAssetV1(agent, 'unrecorded', 97n);
    const path = createPublicationPathV1(fixture);
    fixture.failMarkerWrite = new Error('the marker store refused the write');

    const jobId = await path.enqueue(asset);
    await path.broadcast('wallet-1');
    await path.publisher.drainDetachedExecutions();
    expect(await path.publisher.recover()).toBe(1);

    expect((await path.job(jobId))?.status).toBe('finalized');
    // The failed write is not a failed publication: both completion paths ran to their end.
    expect(fixture.events()).toEqual([
      'executor-settled:repair-unrecorded',
      'finality-observed:repair-unrecorded',
      'vm-materialization:promoted',
      'recovery-finalized:repair-unrecorded',
    ]);
    expect(fixture.markers()).toEqual([]);
    expect(fixture.catalogRows()).toBeNull();
    expect(fixture.counts().repairs).toBe(0);
    expect(fixture.queue()?.pending ?? 0).toBe(0);
    // Both observations say so, once each.
    expect(fixture.warnings().filter((line) => line.includes('finalized-private placement was not recorded'))).toEqual([
      'Confirmed queued publish but RFC-64 finalized-private placement was not recorded, so nothing owes it: '
      + 'the marker store refused the write',
      'Confirmed queued publish but RFC-64 finalized-private placement was not recorded, so nothing owes it: '
      + 'the marker store refused the write',
    ]);
  }, 120_000);
});

/**
 * The wait between finality observed and the terminal record, as the fixture measures it: the
 * publisher reconciles pass after pass, as its runner does, and one parked placement is let go per
 * stated interval of fixture time whenever nothing else can move. Run against the code before this
 * change, the same two rows measure 60 000 ms for the single publication and 120 000 ms for each
 * of the six, because every job then waits for its own placement attempt, queues its second
 * observation behind the others, and holds the recovery walk while it does.
 */
describe('the wait after finality, as the fixture measures it', () => {
  it('is zero for one publication whose placement takes 60 s', async () => {
    const fixture = await startPlacementAgentV1({ name: 'terminal-measure-one' });
    const { agent, clock } = fixture;
    const asset = await seedPlacementAssetV1(agent, 'measured', 98n);
    const path = createPublicationPathV1(fixture);
    const parked = fixture.holdPlacements();
    try {
      const jobId = await path.enqueue(asset);
      await path.broadcast('wallet-1');
      await parked.entered();
      clock.now = 1_000;
      await drivePublicationsV1({ fixture, path, parked, jobIds: [jobId], placementMs: 60_000 });
      expect(executions(fixture.events())).toEqual(['executor-settled:repair-measured']);
      expect(await path.postFinalityWaitMs(jobId)).toBe(0);
    } finally {
      parked.release();
      await path.publisher.drainDetachedExecutions();
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    }
  }, 120_000);

  it('is zero for each of six publications at once, at 20 s per placement', async () => {
    const fixture = await startPlacementAgentV1({ name: 'terminal-measure-burst' });
    const { agent, clock } = fixture;
    const path = createPublicationPathV1(fixture);
    const parked = fixture.holdPlacements();
    const jobIds: string[] = [];
    try {
      for (let index = 0; index < 6; index += 1) {
        const asset = await seedPlacementAssetV1(agent, `measured-${index}`, BigInt(110 + index));
        jobIds.push(await path.enqueue(asset));
        await path.broadcast(`wallet-${index}`);
      }
      await parked.entered();
      clock.now = 1_000;
      await drivePublicationsV1({ fixture, path, parked, jobIds, placementMs: 20_000 });
      expect(executions(fixture.events())).toEqual(
        Array.from({ length: 6 }, (_, index) => `executor-settled:repair-measured-${index}`),
      );
      expect(await Promise.all(jobIds.map((jobId) => path.postFinalityWaitMs(jobId))))
        .toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      parked.release();
      await path.publisher.drainDetachedExecutions();
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    }
  }, 240_000);
});
