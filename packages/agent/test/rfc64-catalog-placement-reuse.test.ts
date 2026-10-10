/**
 * GH#3081 / GH#3072 — placing one asset in an author catalog no longer reads and verifies the
 * whole applied catalog three times. Everything below runs through a real agent: its observer,
 * finalized-private supervisor, catalog upsert, successor producer and durable stores. The
 * durable stores are counted and the core row verifier is counted; nothing is replaced.
 */
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

import type { DKGAgent } from '../src/index.js';
import {
  Rfc64CatalogMutationMemoryV1,
  installRfc64CatalogMutationMemoryV1,
  readVerifiedRfc64CatalogMutationStateV1,
  resolveCatalogMutationMemoryLimitsV1,
  rfc64CatalogMutationMemoryV1,
} from '../src/internal/catalog-mutation-memory.js';
import {
  PLACEMENT_MUTATION as MUTATION,
  PLACEMENT_PROJECTION as PROJECTION,
  PLACEMENT_SCOPE as SCOPE,
  PLACEMENT_SCOPE_DIGEST as SCOPE_DIGEST,
  appliedCatalogObjectsV1 as appliedCatalogObjects,
  appliedPlacementHeadV1 as appliedHead,
  kaNumbersV1 as kaNumbers,
  observeConfirmationV1 as observe,
  placeAssetV1 as place,
  placementAssetV1 as asset,
  placementPersistenceV1 as persistenceOf,
  placementPolicyDigestV1 as policyDigest,
  shareAssetV1 as share,
  startPlacementAgentV1 as startPlacementAgent,
  upsertPlacementV1,
  watchPlacementStoresV1,
} from './support/rfc64-catalog-placement-fixture.js';
import { AUTHOR, NETWORK_ID } from './support/rfc64-local-catalog-repair-fixture.js';

/** A state served from memory: the applied head and its delegation are read again, no bundle is. */
const SERVED_FROM_MEMORY = Object.freeze({ bundles: 0, controlObjects: 2 });

function upsert(agent: DKGAgent, placed: Parameters<typeof upsertPlacementV1>[1], author?: unknown) {
  return upsertPlacementV1(agent, placed, { author });
}

/** Count the agent's durable reads from now on; a reset also restarts the count of verified rows. */
function watchDurableStores(agent: DKGAgent) {
  return watchPlacementStoresV1(agent, () => { verifications.transferredBundle = 0; });
}

describe('RFC-64 catalog placement over a remembered catalog', () => {
  beforeEach(() => {
    verifications.transferredBundle = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the applied catalog once per placement, and verifies one row, whatever the catalog holds', async () => {
    const agent = await startPlacementAgent('placement-reuse-walks');
    const stores = watchDurableStores(agent);
    const perPlacement: Array<typeof stores.reads & { rows: number; verified: number }> = [];
    for (let kaNumber = 1; kaNumber <= 9; kaNumber += 1) {
      const seal = await share(agent, kaNumber);
      stores.reset();
      await observe(agent, `reuse-${kaNumber}`, seal);
      perPlacement.push({ rows: kaNumber - 1, verified: verifications.transferredBundle, ...stores.reads });
    }
    expect(appliedHead(agent)).toMatchObject({ inventoryRowCount: '9', catalogVersion: '9' });

    // The second placement is the first to find a catalog; it reads and verifies it once and keeps it.
    for (const placement of perPlacement.slice(2)) {
      expect(placement).toEqual({
        rows: placement.rows,
        // The one row this successor adds.
        verified: 1,
        // Each unchanged row's bundle, once: the producer's proof that it is durably there.
        bundles: placement.rows,
        // The successor's predecessor (head, directory root and bucket), and the applied head and
        // its delegation again before each of the two uses of the remembered state.
        controlObjects: 3 + 2 * 2,
        // The authority for every use of the remembered state: coverage, then under the lock.
        appliedHead: 2,
        inventorySnapshot: 1,
        cas: 1,
      });
    }
  }, 120_000);

  it('answers a second observation of a placed asset from memory: it builds, signs, reads and announces nothing', async () => {
    const agent = await startPlacementAgent('placement-reuse-covered');
    await place(agent, 1);
    const seal = await place(agent, 2);
    const head = appliedHead(agent);
    const stores = watchDurableStores(agent);
    const successor = vi.spyOn(agent, 'publishAuthorCatalogExactSetSuccessorV1');
    const signer = vi.spyOn(agent, 'createRfc64CatalogAuthorSignerV1');
    // The one place a successor is applied and its head leaves the mutation for its peers.
    const applied = vi.spyOn(agent as any, 'applyRfc64CatalogSuccessorV1');
    const announce = vi.spyOn(agent, 'announceRfc64PublicCatalogHeadV1');

    // The detached path observes the same confirmation again from recovery.
    stores.reset();
    await observe(agent, 'reuse-2', seal);

    expect(successor).not.toHaveBeenCalled();
    expect(signer).not.toHaveBeenCalled();
    expect(applied).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    // What the answer rests on is read from the durable store again, and nothing else: the applied
    // head record; the head and its delegation; the head, its directory root and its bucket as a
    // successor would read them; and the bundle of the row the marker is about.
    expect(stores.reads).toEqual({ bundles: 1, controlObjects: 2 + 3, appliedHead: 1, inventorySnapshot: 0, cas: 0 });
    expect(verifications.transferredBundle).toBe(0);
    expect(appliedHead(agent)).toEqual(head);
    expect(persistenceOf(agent).finalizedPrivatePlacementRepairs.list()).toEqual([]);
  }, 60_000);

  it('reads the durable catalog once, as it does without the memory, when it remembers nothing about a placed asset', async () => {
    const remembering = await startPlacementAgent('placement-reuse-cold-a');
    const rereading = await startPlacementAgent('placement-reuse-cold-b');
    installRfc64CatalogMutationMemoryV1(
      rereading,
      new Rfc64CatalogMutationMemoryV1(resolveCatalogMutationMemoryLimitsV1('0')),
    );
    const reads: Array<Record<string, number>> = [];
    for (const agent of [rereading, remembering]) {
      await place(agent, 1);
      await place(agent, 2);
      const seal = await place(agent, 3);
      // As after a start: the catalog is durable and nothing about it is in memory.
      rfc64CatalogMutationMemoryV1(agent).forget(SCOPE_DIGEST, AUTHOR);
      const stores = watchDurableStores(agent);
      await observe(agent, 'reuse-3', seal);
      reads.push({ ...stores.reads });
      expect(persistenceOf(agent).finalizedPrivatePlacementRepairs.list()).toEqual([]);
    }

    // The read that found the row placed was the whole durable catalog, every bundle included:
    // the applied head, then head, directory root and bucket, and its delegation. Nothing of it
    // is read a second time before the marker is retired.
    expect(reads[1]).toEqual(reads[0]);
    expect(reads[1]).toEqual({ bundles: 3, controlObjects: 1 + 3 + 1, appliedHead: 1, inventorySnapshot: 0, cas: 0 });
    expect(rfc64CatalogMutationMemoryV1(remembering).retained.states).toBe(1);
  }, 60_000);

  it('signs the same catalog, byte for byte, as an agent that reads and verifies everything every time', async () => {
    const remembering = await startPlacementAgent('placement-reuse-identical-a');
    const rereading = await startPlacementAgent('placement-reuse-identical-b');
    installRfc64CatalogMutationMemoryV1(
      rereading,
      new Rfc64CatalogMutationMemoryV1(resolveCatalogMutationMemoryLimitsV1('0')),
    );
    const rereadingStores = watchDurableStores(rereading);
    const rememberingStores = watchDurableStores(remembering);
    let now = 1_773_900_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const steps: Array<(agent: DKGAgent) => Promise<unknown>> = [
      async (agent) => upsert(agent, await asset(3)),
      async (agent) => upsert(agent, await asset(1)),
      async (agent) => upsert(agent, await asset(2)),
      // The next assertion version of a row already there.
      async (agent) => upsert(agent, await asset(1, '2')),
      async (agent) => upsert(agent, await asset(4)),
      // An exact-set target without rows 2 and 4: two removals, one successor each.
      async (agent) => agent.reconcileRfc64PublicRootCatalogExactSetV1({
        ...MUTATION,
        assets: [await asset(1, '2'), await asset(3)],
      }),
      async (agent) => upsert(agent, await asset(5)),
    ];
    for (const step of steps) {
      now += 1_000;
      const expected = await step(rereading);
      const actual = await step(remembering);
      expect(actual).toEqual(expected);
      expect(appliedHead(remembering)).toEqual(appliedHead(rereading));
    }

    const expected = await appliedCatalogObjects(rereading);
    const actual = await appliedCatalogObjects(remembering);
    expect(appliedHead(remembering)).toMatchObject({ catalogVersion: '8', inventoryRowCount: '3' });
    // Signed head, directory root and bucket, signatures included.
    expect(actual.history).toEqual(expected.history);
    expect(actual.state).toEqual(expected.state);
    expect(kaNumbers(actual.state.assets)).toEqual(['1@2', '3@1', '5@1']);
    // And the two agents read different amounts from their durable stores for it.
    expect(rememberingStores.reads.bundles).toBeLessThan(rereadingStores.reads.bundles);
    expect(rememberingStores.reads.controlObjects).toBeLessThan(rereadingStores.reads.controlObjects);
  }, 120_000);

  it('keeps in memory exactly the state a verified read of the durable store returns', async () => {
    const agent = await startPlacementAgent('placement-reuse-carried');
    const memory = rfc64CatalogMutationMemoryV1(agent);
    const stores = watchDurableStores(agent);
    // The first placement starts from a genesis this memory never read: its state is read once,
    // by whoever asks next. Every later state is the carried one.
    await upsert(agent, await asset(3));
    stores.reset();
    await memory.read(persistenceOf(agent), SCOPE_DIGEST, AUTHOR, policyDigest(agent));
    expect(stores.reads).toMatchObject({ bundles: 1, controlObjects: 5 });
    for (const placed of [await asset(1), await asset(2), await asset(1, '2')]) {
      await upsert(agent, placed);
      stores.reset();
      const remembered = await memory.read(persistenceOf(agent), SCOPE_DIGEST, AUTHOR, policyDigest(agent));
      expect(stores.reads).toMatchObject(SERVED_FROM_MEMORY);
      expect(remembered).toEqual(
        await readVerifiedRfc64CatalogMutationStateV1(persistenceOf(agent), appliedHead(agent)!),
      );
    }
    // Several successors of one exact-set reconciliation are each carried forward too.
    await agent.reconcileRfc64PublicRootCatalogExactSetV1({ ...MUTATION, assets: [await asset(3)] });
    expect(appliedHead(agent)).toMatchObject({ inventoryRowCount: '1', catalogVersion: '6' });
    stores.reset();
    const remembered = await memory.read(persistenceOf(agent), SCOPE_DIGEST, AUTHOR, policyDigest(agent));
    expect(stores.reads).toMatchObject(SERVED_FROM_MEMORY);
    expect(remembered).toEqual(
      await readVerifiedRfc64CatalogMutationStateV1(persistenceOf(agent), appliedHead(agent)!),
    );
    expect(memory.verifiedRows(SCOPE_DIGEST, AUTHOR)!.size).toBe(1);
  }, 60_000);

  it('remembers its own copy of a placed asset, not the caller\'s', async () => {
    const agent = await startPlacementAgent('placement-reuse-own-copy');
    await upsert(agent, await asset(1));
    const callers = { ...(await asset(2)), projectionBytes: new Uint8Array(PROJECTION) };
    await upsert(agent, callers);

    // The caller reuses its buffer after the placement returned.
    callers.projectionBytes.fill(0x20);
    (callers as { assertionCoordinate: string }).assertionCoordinate = 'somewhere-else';

    const memory = rfc64CatalogMutationMemoryV1(agent);
    const stores = watchDurableStores(agent);
    stores.reset();
    const remembered = await memory.read(persistenceOf(agent), SCOPE_DIGEST, AUTHOR, policyDigest(agent));
    expect(stores.reads).toMatchObject(SERVED_FROM_MEMORY);
    expect(remembered).toEqual(
      await readVerifiedRfc64CatalogMutationStateV1(persistenceOf(agent), appliedHead(agent)!),
    );
    await expect(upsert(agent, await asset(3))).resolves.toMatchObject({ inventoryRowCount: '3' });
  }, 60_000);

  it('reads the durable catalog again when another writer moved the head between two placements', async () => {
    const agent = await startPlacementAgent('placement-reuse-foreign-head');
    const own = rfc64CatalogMutationMemoryV1(agent);
    await upsert(agent, await asset(1));
    await upsert(agent, await asset(2));
    expect(own.retained.states).toBe(1);

    // Another writer: the same durable stores, none of this memory.
    installRfc64CatalogMutationMemoryV1(agent, new Rfc64CatalogMutationMemoryV1());
    const foreign = await upsert(agent, await asset(7));
    installRfc64CatalogMutationMemoryV1(agent, own);

    const stores = watchDurableStores(agent);
    stores.reset();
    const committed = await upsert(agent, await asset(3));

    // The whole applied state was read again (three bundles), then the producer's own three.
    expect(stores.reads).toMatchObject({ bundles: 6, cas: 1 });
    // Every row was verified again: nothing remembered before the foreign change was trusted.
    expect(verifications.transferredBundle).toBe(4);
    // Built on the foreign head, not on the remembered one: the foreign row is still there.
    expect(committed).toMatchObject({ inventoryRowCount: '4', catalogVersion: '4' });
    expect(committed.currentCatalogHeadDigest).not.toBe(foreign.currentCatalogHeadDigest);
    expect(kaNumbers((await appliedCatalogObjects(agent)).state.assets)).toEqual(['1@1', '2@1', '3@1', '7@1']);
  }, 60_000);

  it('leaves nothing remembered after a failed applied-head CAS', async () => {
    const agent = await startPlacementAgent('placement-reuse-failed-cas');
    const memory = rfc64CatalogMutationMemoryV1(agent);
    await upsert(agent, await asset(1));
    await upsert(agent, await asset(2));
    const head = appliedHead(agent);
    expect(memory.retained.states).toBe(1);
    expect(memory.verifiedRows(SCOPE_DIGEST, AUTHOR)!.size).toBe(2);

    const stores = watchDurableStores(agent);
    stores.failNextCas(new Error('applied-head CAS conflict'));
    await expect(upsert(agent, await asset(3))).rejects.toThrow('applied-head CAS conflict');

    expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });
    expect(appliedHead(agent)).toEqual(head);

    stores.reset();
    await expect(upsert(agent, await asset(3))).resolves.toMatchObject({ inventoryRowCount: '3' });
    // The retry read the applied state from the durable store and verified every row.
    expect(stores.reads).toMatchObject({ bundles: 4, cas: 1 });
    expect(verifications.transferredBundle).toBe(3);
    expect(kaNumbers((await appliedCatalogObjects(agent)).state.assets)).toEqual(['1@1', '2@1', '3@1']);
  }, 60_000);

  it('leaves nothing remembered after a successor that could not be signed or a request it refuses', async () => {
    const agent = await startPlacementAgent('placement-reuse-failed-production');
    const memory = rfc64CatalogMutationMemoryV1(agent);
    await upsert(agent, await asset(1));
    await upsert(agent, await asset(2, '2'));
    expect(memory.retained.states).toBe(1);

    await expect(upsert(agent, await asset(3), {
      address: AUTHOR,
      signMessage: async () => { throw new Error('the wallet is locked'); },
    })).rejects.toThrow();
    expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });

    await upsert(agent, await asset(3));
    expect(memory.retained.states).toBe(1);
    // An older version of a row on another coordinate is not a placement.
    await expect(upsert(agent, { ...(await asset(2)), assertionCoordinate: 'elsewhere' as never }))
      .rejects.toThrow(/not a newer assertion version on the same coordinate/u);
    expect(memory.retained).toEqual({ scopes: 0, states: 0, bytes: 0 });

    // A delayed confirmation of the older version is complete as it stands, and changes nothing.
    const head = appliedHead(agent);
    await expect(upsert(agent, await asset(2))).resolves.toEqual(head);
    await expect(upsert(agent, await asset(3))).resolves.toEqual(head);
    expect(memory.retained.states).toBe(1);
  }, 60_000);

  it('reads the durable catalog again when the policy accepted for the scope changed', async () => {
    const agent = await startPlacementAgent('placement-reuse-policy');
    await upsert(agent, await asset(1));
    await upsert(agent, await asset(2));
    const service = (agent as any).rfc64PublicCatalogServiceV1;
    const accepted = service.acceptedPolicyDigestForCatalogScope.bind(service);
    const covers = () => agent.rfc64CatalogCoversConfirmedSwmRowV1({
      scope: SCOPE,
      expectedRow: {
        kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/2`,
        assertionCoordinate: 'upsert-2',
        assertionVersion: '1',
        sealDigest: `0x${'00'.repeat(32)}`,
      } as never,
    });
    const stores = watchDurableStores(agent);

    // Same policy: answered from memory. The seal digest differs, so the row is not covered.
    await expect(covers()).resolves.toBe(false);
    expect(stores.reads).toMatchObject({ ...SERVED_FROM_MEMORY, appliedHead: 1 });

    const digest = vi.spyOn(service, 'acceptedPolicyDigestForCatalogScope')
      .mockReturnValue(`0x${'ab'.repeat(32)}`);
    stores.reset();
    await expect(covers()).resolves.toBe(false);
    expect(stores.reads).toMatchObject({ bundles: 2, appliedHead: 1 });
    expect(stores.reads.controlObjects).toBeGreaterThan(0);

    // No policy accepted for this exact scope: the durable store answers, and nothing is kept.
    digest.mockImplementation(() => { throw new Error('no locally accepted policy snapshot'); });
    stores.reset();
    await expect(covers()).resolves.toBe(false);
    await expect(covers()).resolves.toBe(false);
    expect(stores.reads).toMatchObject({ bundles: 4, appliedHead: 2 });
    expect(rfc64CatalogMutationMemoryV1(agent).retained.states).toBe(0);

    digest.mockImplementation(accepted);
    await upsert(agent, await asset(3));
    expect(appliedHead(agent)).toMatchObject({ inventoryRowCount: '3' });
  }, 60_000);

  it('reads and verifies everything on every placement when the memory is switched off', async () => {
    const agent = await startPlacementAgent('placement-reuse-switched-off');
    installRfc64CatalogMutationMemoryV1(
      agent,
      new Rfc64CatalogMutationMemoryV1(resolveCatalogMutationMemoryLimitsV1('0')),
    );
    for (let kaNumber = 1; kaNumber <= 3; kaNumber += 1) await place(agent, kaNumber);
    const stores = watchDurableStores(agent);
    const seal = await share(agent, 4);
    stores.reset();

    await observe(agent, 'reuse-4', seal);

    // Coverage, the locked read and the producer each read the three bundles; every row is verified.
    expect(stores.reads).toMatchObject({ bundles: 9, appliedHead: 2, cas: 1 });
    expect(verifications.transferredBundle).toBe(4);
  }, 60_000);
});
