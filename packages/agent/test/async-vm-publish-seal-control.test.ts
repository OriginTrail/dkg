import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextGraphAssertionUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import {
  GraphManager, OxigraphStore, StorePriorityScheduler, buildStoreControlPath,
  selectStoreScheduler, setStoreControlPathForTesting,
} from '@origintrail-official/dkg-storage';
import {
  storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { CG, KA_UAL, MEMBER, MERKLE, NAME, PUBLIC_QUAD, sealFor, stubAgent } from './_helpers/foreign-author-resolution-fixtures.js';

afterEach(() => {
  setStoreControlPathForTesting(undefined);
  vi.restoreAllMocks();
});

async function fixture() {
  const store = new OxigraphStore();
  const graphManager = new GraphManager(store);
  const shareOperationId = 'sealed-control-read-share';
  await store.insert(sealFor(MEMBER));
  await storeKnowledgeAssetOperationPublicQuads({
    store, graphManager, contextGraphId: CG, shareOperationId, kaUal: KA_UAL,
    assertionVersion: 1, quads: [PUBLIC_QUAD], privateTripleCount: 0,
    publisherPeerId: 'unit-peer', agentAddress: MEMBER, accessPolicy: 'public',
  });
  await storeKnowledgeAssetWorkspaceHead({
    store, graphManager, contextGraphId: CG, shareOperationId, kaUal: KA_UAL,
    assertionVersion: 1,
  });
  const agent = stubAgent(store, MEMBER);
  agent.publisher = { hasSwmShareComplete: async () => true };
  Object.defineProperty(agent, 'assertion', {
    value: { history: async () => ({
      events: [], currentShareOperationId: shareOperationId,
      swmCurrentAssertion: `0x${Buffer.from(MERKLE).toString('hex')}`,
    }) },
    configurable: true,
  });
  return { store, agent, shareOperationId };
}

describe('async VM admission seal metadata scheduling', () => {
  it.each([true, false])('dispatches the seal independently of occupied NORMAL slots only when control is enabled (%s)', async enabled => {
    const { store, agent, shareOperationId } = await fixture();
    const shared = new StorePriorityScheduler({
      maxConcurrent: 2, ackReservedSlots: 0, healthReservedSlots: 0,
      normalReservedSlots: 0, backgroundReservedSlots: 0,
    });
    // A share control lane must not be needed for publisher admission.
    setStoreControlPathForTesting(enabled ? buildStoreControlPath({ share: 0, publisher: 2 }, shared) : {});
    const release: Array<() => void> = [];
    const held: Promise<void>[] = [];
    let atSeal!: () => void;
    const reachedSeal = new Promise<void>(resolve => { atSeal = resolve; });
    let dispatched = false;
    const query = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation((sparql, options) => {
      if (options?.source !== 'agent.asyncVmPublish.seal') return query(sparql, options);
      // Occupy ordinary capacity precisely at the observed admission point;
      // earlier author/history checks have already completed.
      for (let i = 0; i < 2; i++) held.push(shared.run('normal', 'unit.bulk-read',
        () => new Promise<void>(resolve => { release.push(resolve); })));
      const result = selectStoreScheduler(shared, options).run(undefined, options.source, async () => {
        dispatched = true;
        return query(sparql, options);
      });
      atSeal();
      return result;
    });
    const intent = agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: MEMBER });
    try {
      await Promise.race([reachedSeal, intent.then(() => { throw new Error('Intent skipped the seal lookup'); })]);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(shared.snapshot.normalInflight).toBe(2);
      expect(dispatched).toBe(enabled);
      release.forEach(resolve => resolve());
      await expect(intent).resolves.toMatchObject({
        contextGraphId: CG, name: NAME, agentAddress: MEMBER,
        shareOperationId, kaUal: KA_UAL.toLowerCase(),
        sealMerkleRoot: `0x${Buffer.from(MERKLE).toString('hex')}`,
      });
    } finally {
      release.forEach(resolve => resolve());
      await Promise.allSettled([...held, intent]);
      await store.close();
    }
  });

  it('still refuses missing seal metadata before creating an intent', async () => {
    const { store, agent } = await fixture();
    setStoreControlPathForTesting(buildStoreControlPath({ share: 1, publisher: 2 }));
    try {
      await store.deleteByPattern({
        subject: contextGraphAssertionUri(CG, MEMBER, NAME), graph: contextGraphMetaUri(CG),
      });
      await expect(agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: MEMBER }))
        .rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });
    } finally {
      await store.close();
    }
  });
});
