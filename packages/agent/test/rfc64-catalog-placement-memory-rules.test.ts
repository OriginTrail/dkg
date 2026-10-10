/**
 * GH#3081 / GH#3072 — what the catalog mutation memory may and may not change, on a real agent
 * whose memory is warm: the share-time projection signs the same bytes with and without it, a
 * failure after the applied-head CAS keeps the committed state, an expired delegation, the kill
 * switch, an inactive lane and a cancellation act as they do without it, and a decision that ends
 * work finds what it rests on in the durable store again.
 */
import { createOperationContext } from '@origintrail-official/dkg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifications = vi.hoisted(() => ({ transferredBundle: 0 }));
vi.mock('@origintrail-official/dkg-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return {
    ...actual,
    verifyTransferredCatalogBundleV1: (
      ...args: Parameters<typeof actual.verifyTransferredCatalogBundleV1>
    ) => {
      verifications.transferredBundle += 1;
      return actual.verifyTransferredCatalogBundleV1(...args);
    },
  };
});

/** Every call that retires the legacy markers of the rows a projection pass has placed. */
const legacyRetirements = vi.hoisted(() => ({ republished: [] as string[][] }));
vi.mock('../src/rfc64/legacy-swm-boundary-v1.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rfc64/legacy-swm-boundary-v1.js')>();
  return {
    ...actual,
    markRfc64LegacySwmRepublishedV1: (
      ...args: Parameters<typeof actual.markRfc64LegacySwmRepublishedV1>
    ) => {
      legacyRetirements.republished.push(args[2].map(({ kaUal }) => kaUal.split('/').at(-1)!));
      return actual.markRfc64LegacySwmRepublishedV1(...args);
    },
  };
});

import type { DKGAgent } from '../src/index.js';
import {
  Rfc64CatalogMutationMemoryV1,
  installRfc64CatalogMutationMemoryV1,
  resolveCatalogMutationMemoryLimitsV1,
  rfc64CatalogMutationMemoryV1,
} from '../src/internal/catalog-mutation-memory.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from
  '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import {
  PLACEMENT_DELEGATION_EXPIRES_AT,
  PLACEMENT_MUTATION as MUTATION,
  PLACEMENT_SCOPE_DIGEST as SCOPE_DIGEST,
  appliedCatalogObjectsV1 as appliedCatalogObjects,
  appliedPlacementHeadV1 as appliedHead,
  kaNumbersV1 as kaNumbers,
  placeAssetV1 as place,
  placementAssetV1 as asset,
  placementPersistenceV1 as persistenceOf,
  startPlacementAgentV1 as startPlacementAgent,
  upsertPlacementV1 as upsert,
  watchPlacementStoresV1,
} from './support/rfc64-catalog-placement-fixture.js';
import {
  AUTHOR,
  AUTHOR_WALLET,
  CONTEXT_GRAPH_ID,
  seedDurableWorkspaceAssetV1,
} from './support/rfc64-local-catalog-repair-fixture.js';

function watchDurableStores(agent: DKGAgent) {
  return watchPlacementStoresV1(agent, () => { verifications.transferredBundle = 0; });
}

/** An agent that reads and verifies the durable catalog on every use. */
function withoutMemory(agent: DKGAgent): DKGAgent {
  installRfc64CatalogMutationMemoryV1(
    agent,
    new Rfc64CatalogMutationMemoryV1(resolveCatalogMutationMemoryLimitsV1('0')),
  );
  return agent;
}

/** The same step on an agent that remembers and on one that does not. */
async function both<T>(
  agents: readonly DKGAgent[],
  step: (agent: DKGAgent) => Promise<T>,
): Promise<T[]> {
  const outcomes: T[] = [];
  for (const agent of agents) outcomes.push(await step(agent));
  return outcomes;
}

/**
 * The step in which a mutation hands the head it committed over to its peers: the announcement
 * itself, or where a delivery owner sends it later, the hand-off to that owner.
 */
function watchHandOver(agent: DKGAgent) {
  return vi.spyOn(
    agent as any,
    'deliverRfc64CatalogHeadV1' in agent ? 'deliverRfc64CatalogHeadV1' : 'announceRfc64PublicCatalogHeadV1',
  );
}

async function rejectionOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (cause) {
    const messages: string[] = [];
    for (let error: unknown = cause; error instanceof Error; error = error.cause) messages.push(error.message);
    return messages.join(' <- ');
  }
  throw new Error('the work was expected to reject');
}

async function expectSameCatalog(remembering: DKGAgent, rereading: DKGAgent): Promise<void> {
  expect(appliedHead(remembering)).toEqual(appliedHead(rereading));
  const expected = await appliedCatalogObjects(rereading);
  const actual = await appliedCatalogObjects(remembering);
  // Signed head, directory root and bucket, signatures included.
  expect(actual.history).toEqual(expected.history);
  expect(actual.state).toEqual(expected.state);
}

describe('RFC-64 catalog mutation memory on a running agent', () => {
  beforeEach(() => {
    verifications.transferredBundle = 0;
    legacyRetirements.republished.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the share-time projection of a public lane', () => {
    /** Share one asset the way a durable promotion does: its inventory row, then its projection. */
    async function share(agent: DKGAgent, kaNumber: number, settle = true): Promise<void> {
      const seeded = await seedDurableWorkspaceAssetV1(agent, `shared-${kaNumber}`, BigInt(kaNumber));
      await agent.observeRfc64DurableSwmPromotionV1({
        contextGraphId: CONTEXT_GRAPH_ID,
        assertionCoordinate: seeded.assertionCoordinate,
        lifecycleAgentAddress: AUTHOR,
        shareOperationId: seeded.shareOperationId,
        ctx: createOperationContext('share', `share-${kaNumber}`),
      });
      if (settle) await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    }

    /** Every result of the projection's catalog reconciliation, in order. */
    function watchReconciliations(agent: DKGAgent) {
      const results: Array<{ status: string; sourceCurrent: boolean; successorsApplied: number }> = [];
      const real = (agent as any).reconcileRfc64SwmInventoryCatalogV1.bind(agent);
      vi.spyOn(agent as any, 'reconcileRfc64SwmInventoryCatalogV1').mockImplementation(async (params: unknown) => {
        const result = await real(params);
        results.push({
          status: result.status,
          sourceCurrent: result.sourceCurrent,
          successorsApplied: result.successorsApplied,
        });
        return result;
      });
      return results;
    }

    it('signs the same catalog, byte for byte, with and without the memory', async () => {
      const remembering = await startPlacementAgent('projection-identical-a', { shareTimeProjection: true });
      const rereading = withoutMemory(
        await startPlacementAgent('projection-identical-b', { shareTimeProjection: true }),
      );
      const agents = [rereading, remembering];
      const stores = new Map(agents.map((agent) => [agent, watchDurableStores(agent)]));
      const reconciliations = new Map(agents.map((agent) => [agent, watchReconciliations(agent)]));
      let now = 1_773_900_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);

      for (const kaNumber of [3, 1]) {
        now += 1_000;
        await both(agents, (agent) => share(agent, kaNumber));
        await expectSameCatalog(remembering, rereading);
      }

      // Asset 4 is shared while the successor that adds asset 2 is being produced: the projection
      // commits the branch it signed, finds its source moved and carries on from that head.
      now += 1_000;
      await both(agents, async (agent) => {
        const produce = agent.publishAuthorCatalogExactSetSuccessorV1.bind(agent);
        const produced = vi.spyOn(agent, 'publishAuthorCatalogExactSetSuccessorV1')
          .mockImplementationOnce(async (params) => {
            await share(agent, 4, false);
            return produce(params);
          });
        await share(agent, 2);
        produced.mockRestore();
      });
      await expectSameCatalog(remembering, rereading);
      expect(appliedHead(remembering)).toMatchObject({ inventoryRowCount: '4', catalogVersion: '4' });
      for (const agent of agents) {
        expect(reconciliations.get(agent)!.map(({ sourceCurrent }) => sourceCurrent)).toContain(false);
      }

      // A pass that finds the catalog equal to its inventory signs nothing on either agent.
      now += 1_000;
      const [expectedPass, actualPass] = await both(agents, async (agent) => {
        const watched = stores.get(agent)!;
        watched.reset();
        const seen = reconciliations.get(agent)!.length;
        expect(agent.requestRfc64SwmCatalogProjectionV1({
          contextGraphId: CONTEXT_GRAPH_ID,
          authorAddress: AUTHOR,
        })).toBe(true);
        await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
        return { reads: { ...watched.reads }, results: reconciliations.get(agent)!.slice(seen) };
      });
      expect(actualPass!.results).toEqual([{ status: 'existing', sourceCurrent: true, successorsApplied: 0 }]);
      expect(expectedPass!.results).toEqual(actualPass!.results);
      await expectSameCatalog(remembering, rereading);
      // The agent that remembers read the applied head and its delegation, then head, directory
      // root and bucket, and every row's bundle back: the pass retires the legacy markers of all
      // four rows. The other read the whole catalog, the same four bundles among it.
      expect(actualPass!.reads).toMatchObject({ bundles: 4, controlObjects: 2 + 3, cas: 0 });
      expect(expectedPass!.reads).toMatchObject({ bundles: 4, cas: 0 });
      expect(verifications.transferredBundle).toBe(0);
      expect(kaNumbers((await appliedCatalogObjects(remembering)).state.assets))
        .toEqual(['1@1', '2@1', '3@1', '4@1']);
    }, 120_000);

    it('retires no legacy marker for a pass that finds nothing to sign while a row\'s bundle is not in the durable store', async () => {
      const remembering = await startPlacementAgent('projection-lost-bundle-a', { shareTimeProjection: true });
      const rereading = withoutMemory(
        await startPlacementAgent('projection-lost-bundle-b', { shareTimeProjection: true }),
      );
      const agents = [rereading, remembering];
      const memory = rfc64CatalogMutationMemoryV1(remembering);
      let now = 1_773_900_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      for (const kaNumber of [1, 2]) {
        now += 1_000;
        await both(agents, (agent) => share(agent, kaNumber));
      }
      await expectSameCatalog(remembering, rereading);
      const { history } = await appliedCatalogObjects(remembering);
      const bundleDigests = history.previousBucket!.payload.rows.map(({ transfer }) => transfer.blobDigest);
      expect(bundleDigests).toHaveLength(2);
      const stores = new Map(agents.map((agent) => [agent, watchDurableStores(agent)]));
      /** One pass of the projection, as its supervisor runs it. */
      const pass = (agent: DKGAgent) => agent.reconcileRfc64PublicCatalogFromSwmInventoryV1({
        contextGraphId: CONTEXT_GRAPH_ID,
        authorAddress: AUTHOR,
      });
      await both(agents, async (agent) => expect(await pass(agent)).toMatchObject({ status: 'existing' }));
      expect(memory.retained.states).toBe(1);

      for (const bundleDigest of bundleDigests) {
        legacyRetirements.republished.length = 0;
        now += 1_000;
        const [expected, actual] = await both(agents, (agent) => {
          stores.get(agent)!.lose(bundleDigest);
          return rejectionOf(pass(agent));
        });
        // Both passes fail with the same words, before the step that retires the legacy markers of
        // the rows they found placed: their supervisor repeats a pass that failed.
        expect(actual).toBe(expected);
        expect(actual).toContain(`RFC-64 applied catalog bundle ${bundleDigest} is unavailable`);
        expect(legacyRetirements.republished).toEqual([]);
        expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });

        await both(agents, async (agent) => {
          stores.get(agent)!.restore(bundleDigest);
          expect(await pass(agent)).toMatchObject({ status: 'existing', successorsApplied: 0 });
        });
        expect(legacyRetirements.republished).toEqual([['1', '2'], ['1', '2']]);
        expect(memory.retained.states).toBe(1);
      }
      await expectSameCatalog(remembering, rereading);
    }, 120_000);
  });

  describe('a failure after the applied-head CAS', () => {
    it('keeps the committed state when handing that head over to its peers throws', async () => {
      const agent = await startPlacementAgent('memory-rules-announce-throws');
      const memory = rfc64CatalogMutationMemoryV1(agent);
      await upsert(agent, await asset(1));
      await upsert(agent, await asset(2));
      const stores = watchDurableStores(agent);
      watchHandOver(agent).mockImplementationOnce(() => {
        throw new Error('the catalog service has stopped');
      });

      await expect(upsert(agent, await asset(3), { peers: ['a-peer'] }))
        .rejects.toThrow('the catalog service has stopped');

      // The head was durable and applied before anyone was told about it.
      expect(appliedHead(agent)).toMatchObject({ inventoryRowCount: '3', catalogVersion: '3' });
      expect(memory.retained.states).toBe(1);
      expect(memory.verifiedRows(SCOPE_DIGEST, AUTHOR)!.size).toBe(3);

      stores.reset();
      await expect(upsert(agent, await asset(4))).resolves.toMatchObject({ inventoryRowCount: '4' });
      // The next placement starts from that state: one row is verified, and besides the producer's
      // own reads only the applied head and its delegation are read again.
      expect(verifications.transferredBundle).toBe(1);
      expect(stores.reads).toMatchObject({ bundles: 3, controlObjects: 3 + 2, cas: 1 });
    }, 60_000);

    it('hands every head to its peers, and keeps the committed state when none of them can be reached', async () => {
      const agent = await startPlacementAgent('memory-rules-announce-peers');
      const memory = rfc64CatalogMutationMemoryV1(agent);
      const handedOver = watchHandOver(agent);
      const stores = watchDurableStores(agent);
      const peers = ['a-peer-that-is-not-connected'];
      const perPlacement: Array<{ verified: number; bundles: number }> = [];

      for (let kaNumber = 1; kaNumber <= 5; kaNumber += 1) {
        stores.reset();
        await upsert(agent, await asset(kaNumber), { peers });
        perPlacement.push({ verified: verifications.transferredBundle, bundles: stores.reads.bundles });
      }

      // Every head went to the peer list; that the peer cannot be reached fails no mutation.
      expect(handedOver.mock.calls.map(([input]) => (input as { peers: readonly string[] }).peers))
        .toEqual(Array.from({ length: 5 }, () => peers));
      expect(appliedHead(agent)).toMatchObject({ inventoryRowCount: '5', catalogVersion: '5' });
      expect(memory.retained.states).toBe(1);
      // From the third placement on every placement starts from the remembered state.
      expect(perPlacement.slice(2)).toEqual([
        { verified: 1, bundles: 2 },
        { verified: 1, bundles: 3 },
        { verified: 1, bundles: 4 },
      ]);
    }, 60_000);

    it('keeps the state of the last successor it committed when it is cancelled before the next one', async () => {
      const remembering = await startPlacementAgent('memory-rules-cancel-between-a');
      const rereading = withoutMemory(await startPlacementAgent('memory-rules-cancel-between-b'));
      const agents = [rereading, remembering];
      const stores = new Map(agents.map((agent) => [agent, watchDurableStores(agent)]));
      let now = 1_773_900_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      for (const kaNumber of [1, 2, 3, 4]) {
        now += 1_000;
        await both(agents, async (agent) => upsert(agent, await asset(kaNumber)));
      }
      // Rows 2 and 4 go: two successors of one reconciliation.
      const target = [await asset(1), await asset(3)];

      now += 1_000;
      await both(agents, async (agent) => {
        const cancelled = new AbortController();
        stores.get(agent)!.afterNextCas(() => cancelled.abort());
        await expect(agent.reconcileRfc64PublicRootCatalogExactSetV1({
          ...MUTATION,
          assets: target,
          signal: cancelled.signal,
        })).rejects.toThrow();
      });
      await expectSameCatalog(remembering, rereading);
      expect(appliedHead(remembering)).toMatchObject({ inventoryRowCount: '3', catalogVersion: '5' });
      await vi.waitFor(() => expect(rfc64CatalogMutationMemoryV1(remembering).retained.states).toBe(1));

      now += 1_000;
      const resume = (agent: DKGAgent) => agent.reconcileRfc64PublicRootCatalogExactSetV1({
        ...MUTATION,
        assets: target,
      });
      const expected = await resume(rereading);
      const watched = stores.get(remembering)!;
      watched.reset();
      const actual = await resume(remembering);
      // It carried on from the committed state: no row was verified again, and besides the
      // producer's own reads only the applied head and its delegation were read.
      expect(verifications.transferredBundle).toBe(0);
      expect(watched.reads).toMatchObject({ bundles: 2, controlObjects: 3 + 2, cas: 1 });
      expect(actual).toEqual(expected);
      expect(actual).toMatchObject({ status: 'advanced', successorsApplied: 1, targetAssetCount: 2 });
      await expectSameCatalog(remembering, rereading);
    }, 120_000);
  });

  describe('what a successor rechecks every time', () => {
    it('refuses a successor once the catalog key\'s delegation has expired, as it does without the memory', async () => {
      const remembering = await startPlacementAgent('memory-rules-expiry-a');
      const rereading = withoutMemory(await startPlacementAgent('memory-rules-expiry-b'));
      const agents = [rereading, remembering];
      let now = 1_773_900_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      for (const kaNumber of [1, 2]) {
        now += 1_000;
        await both(agents, async (agent) => upsert(agent, await asset(kaNumber)));
      }
      const memory = rfc64CatalogMutationMemoryV1(remembering);
      expect(memory.retained.states).toBe(1);

      const inTime = now;
      now = Number(PLACEMENT_DELEGATION_EXPIRES_AT);
      const [expected, actual] = await both(agents, async (agent) => rejectionOf(upsert(agent, await asset(3))));
      expect(actual).toBe(expected);
      expect(actual).toContain('catalog head issuedAt is outside the child half-open interval');
      await expectSameCatalog(remembering, rereading);
      expect(appliedHead(remembering)).toMatchObject({ inventoryRowCount: '2' });
      // The failed successor leaves nothing remembered.
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });

      now = inTime + 1_000;
      await both(agents, async (agent) => upsert(agent, await asset(3)));
      await expectSameCatalog(remembering, rereading);
      expect(appliedHead(remembering)).toMatchObject({ inventoryRowCount: '3', catalogVersion: '3' });
    }, 120_000);

    it('signs nothing while the kill switch is on, and carries on from memory once it is off', async () => {
      const agent = await startPlacementAgent('memory-rules-kill-switch');
      const memory = rfc64CatalogMutationMemoryV1(agent);
      await upsert(agent, await asset(1));
      await upsert(agent, await asset(2));
      const head = appliedHead(agent);
      const stores = watchDurableStores(agent);
      const signer = vi.spyOn(AUTHOR_WALLET, 'signMessage');
      const config = (agent as any).config;
      const plan = config.rfc64CatalogExecutionPlan;

      config.rfc64CatalogExecutionPlan = Object.freeze({ ...plan, killSwitchActive: true });
      stores.reset();
      await expect(upsert(agent, await asset(3))).rejects.toThrow('disabled by the Track-2 kill switch');
      await expect(agent.reconcileRfc64PublicRootCatalogExactSetV1({ ...MUTATION, assets: [await asset(1)] }))
        .rejects.toThrow('disabled by the Track-2 kill switch');
      expect(signer).not.toHaveBeenCalled();
      expect(stores.reads).toMatchObject({ cas: 0, bundles: 0 });
      expect(appliedHead(agent)).toEqual(head);
      // The switch says nothing about the catalog: what was verified is still held.
      expect(memory.retained.states).toBe(1);

      config.rfc64CatalogExecutionPlan = plan;
      stores.reset();
      await expect(upsert(agent, await asset(3))).resolves.toMatchObject({ inventoryRowCount: '3' });
      expect(verifications.transferredBundle).toBe(1);
      expect(stores.reads).toMatchObject({ bundles: 2, controlObjects: 3 + 2, cas: 1 });
    }, 60_000);

    it('refuses the placement of an already placed asset while its lane is inactive, and keeps the marker', async () => {
      const agent = await startPlacementAgent('memory-rules-inactive-lane');
      const repairs = vi.spyOn(agent as any, 'repairObservedRfc64FinalizedPrivateCatalogPlacementV1');
      await place(agent, 1);
      await place(agent, 2);
      const repair = repairs.mock.calls.at(-1)![0] as Rfc64FinalizedPrivatePlacementRepairV1;
      const markers = persistenceOf(agent).finalizedPrivatePlacementRepairs;
      expect(markers.list()).toEqual([]);
      const stores = watchDurableStores(agent);
      const lane = vi.mocked((agent as any).resolveRfc64CatalogAuthoringLaneV1);

      // The same confirmation is owed again, as after a restart, and the lane no longer accepts it.
      await markers.put(repair);
      lane.mockReturnValueOnce(null);
      stores.reset();
      await expect(agent.repairRfc64FinalizedPrivateCatalogPlacementV1(repair))
        .rejects.toThrow('RFC-64 finalized-private placement repair lane is inactive');
      // Nothing was asked of the catalog, remembered or durable.
      expect(stores.reads).toEqual({ bundles: 0, controlObjects: 0, appliedHead: 0, inventorySnapshot: 0, cas: 0 });
      expect(markers.list()).toEqual([repair]);

      const serving = agent.resolveRfc64CatalogServingAuthorityV1.bind(agent);
      const authority = vi.spyOn(agent, 'resolveRfc64CatalogServingAuthorityV1')
        .mockImplementation((contextGraphId) => (
          { ...serving(contextGraphId), authoringAllowed: false } as never
        ));
      await expect(upsert(agent, await asset(3))).rejects.toThrow('disabled for legacy-mode CG');
      authority.mockRestore();

      // With its lane back the repair finds the row placed and retires the marker.
      await expect(agent.repairRfc64FinalizedPrivateCatalogPlacementV1(repair)).resolves.toBe('already-complete');
      expect(markers.list()).toEqual([]);
    }, 60_000);

    it('forgets the scope when a successor is cancelled while it is being signed, and signs the same catalog afterwards', async () => {
      const remembering = await startPlacementAgent('memory-rules-cancel-signing-a');
      const rereading = withoutMemory(await startPlacementAgent('memory-rules-cancel-signing-b'));
      const agents = [rereading, remembering];
      let now = 1_773_900_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      for (const kaNumber of [1, 2, 3]) {
        now += 1_000;
        await both(agents, async (agent) => upsert(agent, await asset(kaNumber)));
      }
      const memory = rfc64CatalogMutationMemoryV1(remembering);
      expect(memory.retained.states).toBe(1);
      const target = [await asset(1), await asset(2), await asset(3), await asset(4)];

      now += 1_000;
      await both(agents, async (agent) => {
        const cancelled = new AbortController();
        // The wallet is asked for the first of the successor's signatures, and the caller gives up.
        const author = {
          address: AUTHOR,
          signMessage: async (message: Uint8Array) => {
            cancelled.abort();
            return AUTHOR_WALLET.signMessage(message);
          },
        };
        await expect(agent.reconcileRfc64PublicRootCatalogExactSetV1({
          ...MUTATION,
          author: author as never,
          assets: target,
          signal: cancelled.signal,
        })).rejects.toThrow();
      });
      await vi.waitFor(() => expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 }));
      await expectSameCatalog(remembering, rereading);
      expect(appliedHead(remembering)).toMatchObject({ inventoryRowCount: '3', catalogVersion: '3' });

      now += 1_000;
      const [expected, actual] = await both(agents, (agent) => agent.reconcileRfc64PublicRootCatalogExactSetV1({
        ...MUTATION,
        assets: target,
      }));
      expect(actual).toEqual(expected);
      await expectSameCatalog(remembering, rereading);
      expect(appliedHead(remembering)).toMatchObject({ inventoryRowCount: '4', catalogVersion: '4' });
    }, 120_000);
  });

  describe('a durable object that is gone while the memory is warm', () => {
    /** Three rows placed through the supervisor, and the marker and bundle digest of the second. */
    async function placed(name: string) {
      const agent = await startPlacementAgent(name);
      const repairs = vi.spyOn(agent as any, 'repairObservedRfc64FinalizedPrivateCatalogPlacementV1');
      await place(agent, 1);
      await place(agent, 2);
      const repair = repairs.mock.calls.at(-1)![0] as Rfc64FinalizedPrivatePlacementRepairV1;
      await place(agent, 3);
      const { history, state } = await appliedCatalogObjects(agent);
      const row = history.previousBucket!.payload.rows.find(({ kaId }) => repair.kaUal.endsWith(`/${BigInt(kaId) & 0xffffn}`))!;
      return {
        agent,
        repair,
        bundleDigest: row.transfer.blobDigest,
        headDigest: state.previousHead.objectDigest,
        delegationDigest: state.catalogIssuerAuthorization.catalogIssuerDelegation.objectDigest,
        rootDigest: history.previousDirectoryPath[0]!.objectDigest,
        bucketDigest: history.previousBucket!.objectDigest,
        markers: persistenceOf(agent).finalizedPrivatePlacementRepairs,
        memory: rfc64CatalogMutationMemoryV1(agent),
        stores: watchDurableStores(agent),
      };
    }

    it('keeps the marker of a placed row whose bundle is no longer in the durable store', async () => {
      const { agent, repair, bundleDigest, markers, memory, stores } = await placed('memory-rules-lost-bundle');
      expect(memory.retained.states).toBe(1);

      await markers.put(repair);
      stores.lose(bundleDigest);
      await expect(agent.repairRfc64FinalizedPrivateCatalogPlacementV1(repair))
        .rejects.toThrow(`RFC-64 applied catalog bundle ${bundleDigest} is unavailable`);
      expect(markers.list()).toEqual([repair]);
      // Nothing remembered about the catalog is trusted after that.
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
      // The read of the durable catalog that follows refuses it with the same words, as it always did.
      await expect(agent.repairRfc64FinalizedPrivateCatalogPlacementV1(repair))
        .rejects.toThrow(`RFC-64 applied catalog bundle ${bundleDigest} is unavailable`);
      expect(markers.list()).toEqual([repair]);

      stores.restore(bundleDigest);
      await expect(agent.repairRfc64FinalizedPrivateCatalogPlacementV1(repair)).resolves.toBe('already-complete');
      expect(markers.list()).toEqual([]);
    }, 60_000);

    it('refuses a placement that is already there when its bundle is no longer in the durable store', async () => {
      const agent = await startPlacementAgent('memory-rules-lost-bundle-upsert');
      await upsert(agent, await asset(1));
      await upsert(agent, await asset(2, '2'));
      const head = appliedHead(agent);
      const { history } = await appliedCatalogObjects(agent);
      const stores = watchDurableStores(agent);
      const [first, second] = history.previousBucket!.payload.rows.map(({ transfer }) => transfer.blobDigest);

      // The asset itself again, and a delayed confirmation of its earlier version.
      stores.lose(first!);
      await expect(upsert(agent, await asset(1))).rejects.toThrow(`bundle ${first} is unavailable`);
      stores.restore(first!);
      await expect(upsert(agent, await asset(1))).resolves.toEqual(head);
      stores.lose(second!);
      await expect(upsert(agent, await asset(2))).rejects.toThrow(`bundle ${second} is unavailable`);
      stores.restore(second!);
      await expect(upsert(agent, await asset(2))).resolves.toEqual(head);
    }, 60_000);

    it.each([
      ['applied head', 'headDigest', 'RFC-64 applied author head is not durably staged'],
      ['delegation of the applied head', 'delegationDigest', 'RFC-64 applied author head delegation is not durably staged'],
      ['directory root of the applied head', 'rootDigest', 'RFC-64 predecessor directory root is not staged'],
      ['bucket of the applied head', 'bucketDigest', 'RFC-64 predecessor bucket is not staged'],
    ] as const)('refuses every use of the catalog while the %s is not in the durable store', async (_object, which, refusal) => {
      const context = await placed(`memory-rules-lost-${which}`);
      const { agent, repair, markers, memory, stores } = context;
      expect(memory.retained.states).toBe(1);

      // The repair of a row that is placed: the answer would retire its marker.
      stores.lose(context[which]);
      await markers.put(repair);
      await expect(agent.repairRfc64FinalizedPrivateCatalogPlacementV1(repair)).rejects.toThrow(refusal);
      expect(markers.list()).toEqual([repair]);
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
      await expect(upsert(agent, await asset(4))).rejects.toThrow(refusal);
      expect(appliedHead(agent)).toMatchObject({ inventoryRowCount: '3' });

      stores.restore(context[which]);
      await expect(agent.repairRfc64FinalizedPrivateCatalogPlacementV1(repair)).resolves.toBe('already-complete');
      expect(markers.list()).toEqual([]);
      await expect(upsert(agent, await asset(4))).resolves.toMatchObject({ inventoryRowCount: '4' });
    }, 60_000);

    it.each([
      ['directory root', 'rootDigest'],
      ['bucket', 'bucketDigest'],
    ] as const)('keeps the marker of a placed row while the %s of the applied head cannot be read', async (_object, which) => {
      const context = await placed(`memory-rules-spoilt-${which}`);
      const { agent, repair, markers, memory, stores } = context;
      expect(memory.retained.states).toBe(1);

      stores.spoil(context[which]);
      await markers.put(repair);
      await expect(agent.repairRfc64FinalizedPrivateCatalogPlacementV1(repair))
        .rejects.toThrow(`stored control object ${context[which]} does not verify`);
      expect(markers.list()).toEqual([repair]);
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });

      stores.restore(context[which]);
      await expect(agent.repairRfc64FinalizedPrivateCatalogPlacementV1(repair)).resolves.toBe('already-complete');
      expect(markers.list()).toEqual([]);
    }, 60_000);

    it.each([
      ['directory root', 'RFC-64 predecessor directory root is not staged'],
      ['bucket', 'RFC-64 predecessor bucket is not staged'],
    ] as const)('reports nothing as already done while the %s of the applied head is gone', async (object, refusal) => {
      const agent = await startPlacementAgent(`memory-rules-nothing-done-${object.replace(' ', '-')}`);
      const memory = rfc64CatalogMutationMemoryV1(agent);
      await upsert(agent, await asset(1));
      await upsert(agent, await asset(2));
      const head = appliedHead(agent);
      const { history } = await appliedCatalogObjects(agent);
      const gone = object === 'bucket'
        ? history.previousBucket!.objectDigest
        : history.previousDirectoryPath[0]!.objectDigest;
      const stores = watchDurableStores(agent);
      const upToDate = async () => agent.reconcileRfc64PublicRootCatalogExactSetV1({
        ...MUTATION,
        assets: [await asset(1), await asset(2)],
      });

      // An asset that is already placed: the upsert would answer from the remembered state.
      expect(memory.retained.states).toBe(1);
      stores.lose(gone);
      await expect(upsert(agent, await asset(1))).rejects.toThrow(refusal);
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
      stores.restore(gone);
      await expect(upsert(agent, await asset(1))).resolves.toEqual(head);

      // A target the catalog already equals: so would the reconciliation.
      expect(memory.retained.states).toBe(1);
      stores.lose(gone);
      await expect(upToDate()).rejects.toThrow(refusal);
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
      stores.restore(gone);
      await expect(upToDate()).resolves.toMatchObject({ status: 'existing', successorsApplied: 0 });
      expect(appliedHead(agent)).toEqual(head);
    }, 60_000);

    it.each([
      ['first', 0],
      ['second', 1],
    ] as const)('reports no set as already placed while the bundle of its %s row is not in the durable store', async (which, index) => {
      const agent = await startPlacementAgent(`memory-rules-set-lost-bundle-${which}`);
      const memory = rfc64CatalogMutationMemoryV1(agent);
      await upsert(agent, await asset(1));
      await upsert(agent, await asset(2));
      const head = appliedHead(agent);
      const { history } = await appliedCatalogObjects(agent);
      const bundleDigest = history.previousBucket!.payload.rows[index]!.transfer.blobDigest;
      const stores = watchDurableStores(agent);
      const upToDate = async () => agent.reconcileRfc64PublicRootCatalogExactSetV1({
        ...MUTATION,
        assets: [await asset(1), await asset(2)],
      });

      // A target the catalog already equals: the reconciliation would answer from the remembered state.
      expect(memory.retained.states).toBe(1);
      stores.lose(bundleDigest);
      await expect(upToDate()).rejects.toThrow(`RFC-64 applied catalog bundle ${bundleDigest} is unavailable`);
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
      // The read of the durable catalog that follows refuses it with the same words, as it always did.
      await expect(upToDate()).rejects.toThrow(`RFC-64 applied catalog bundle ${bundleDigest} is unavailable`);
      expect(appliedHead(agent)).toEqual(head);

      stores.restore(bundleDigest);
      await expect(upToDate()).resolves.toMatchObject({ status: 'existing', successorsApplied: 0 });
      expect(memory.retained.states).toBe(1);
      stores.reset();
      await expect(upToDate()).resolves.toMatchObject({ status: 'existing', successorsApplied: 0 });
      // From memory: the applied head and its delegation, then head, directory root, bucket and
      // the bundle of each of the two rows.
      expect(stores.reads).toMatchObject({ bundles: 2, controlObjects: 2 + 3, cas: 0 });
      expect(appliedHead(agent)).toEqual(head);
    }, 60_000);

    it('forgets the scope when the head it has just committed cannot be read back for the next successor', async () => {
      const agent = await startPlacementAgent('memory-rules-lost-new-head');
      const memory = rfc64CatalogMutationMemoryV1(agent);
      for (const kaNumber of [1, 2, 3, 4]) await upsert(agent, await asset(kaNumber));
      const stores = watchDurableStores(agent);
      // Rows 2 and 4 go: two successors of one reconciliation.
      const target = [await asset(1), await asset(3)];
      let committedHead = '';
      stores.afterNextCas((headDigest) => {
        committedHead = headDigest;
        stores.lose(headDigest);
      });

      await expect(agent.reconcileRfc64PublicRootCatalogExactSetV1({ ...MUTATION, assets: target }))
        .rejects.toThrow('RFC-64 predecessor head is not durably staged');

      // The first successor is applied. Its state was the committed one, and a further successor
      // was asked of it: what failed then may be the catalog, so nothing of it stays remembered.
      expect(appliedHead(agent)).toMatchObject({ inventoryRowCount: '3', catalogVersion: '5' });
      expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });

      stores.restore(committedHead);
      stores.reset();
      await expect(agent.reconcileRfc64PublicRootCatalogExactSetV1({ ...MUTATION, assets: target }))
        .resolves.toMatchObject({ status: 'advanced', successorsApplied: 1 });
      // The durable catalog was read and verified in full before it carried on.
      expect(stores.reads.bundles).toBe(3 + 2);
      expect(verifications.transferredBundle).toBe(2);
    }, 60_000);

    it('puts back the missing bundle of an unchanged row when it produces the next successor', async () => {
      const { agent, bundleDigest, memory, stores } = await placed('memory-rules-lost-bundle-successor');
      expect(memory.retained.states).toBe(1);

      stores.lose(bundleDigest);
      stores.reset();
      await expect(upsert(agent, await asset(4))).resolves.toMatchObject({ inventoryRowCount: '4' });

      // The successor read every unchanged row's bundle back and staged the one it did not find,
      // from the bytes it had verified: the row is durable again and nothing was reported.
      expect(stores.stagedAgain).toEqual([bundleDigest]);
      expect(stores.reads).toMatchObject({ bundles: 3, cas: 1 });
      expect(verifications.transferredBundle).toBe(1);
      expect(memory.retained.states).toBe(1);
    }, 60_000);
  });

  it('holds nothing of a catalog whose durable stores were closed', async () => {
    const agent = await startPlacementAgent('memory-rules-closed-stores');
    const memory = rfc64CatalogMutationMemoryV1(agent);
    await upsert(agent, await asset(1));
    await upsert(agent, await asset(2));
    expect(memory.retained.states).toBe(1);

    await agent.stop();

    expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
  }, 60_000);
});
