import { describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { assertionLifecycleUri, contextGraphAssertionUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, StoreSchedulerBusyError, type Quad } from '@origintrail-official/dkg-storage';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { createPromotionAgentForTest } from './_helpers/promotion-agent.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

const CG = 'partial-commit-2963';
const AUTHOR = `0x${'11'.repeat(20)}`;
const NAME = 'interrupted-share';
const DKG = 'http://dkg.io/ontology/';
const lifecycle = assertionLifecycleUri(CG, AUTHOR, NAME);
const meta = contextGraphMetaUri(CG);

class LifecycleInsertFaultStore extends OxigraphStore {
  fault?: Error;
  trips = 0;
  override async insert(quads: Quad[]): Promise<void> {
    if (this.fault && quads.some(q => q.subject === lifecycle && q.predicate === `${DKG}state` && q.object === '"promoted"')) {
      const error = this.fault;
      this.fault = undefined;
      this.trips++;
      throw error;
    }
    return super.insert(quads);
  }
}

describe('GH#2963 modern allocator lifecycle delete/insert interruption', () => {
  it.each(['typed-not-started', 'untyped'] as const)('preserves the immutable operation across %s failure and explicit replay', async kind => {
    const store = new LifecycleInsertFaultStore();
    const allocator = makeTestKaNumberAllocator();
    const options = { agentAddress: AUTHOR, peerId: '12D3KooWPartialCommit2963', kaAllocator: allocator };
    const { agent, publisher } = await createPromotionAgentForTest(store, options);
    await publisher.assertionCreate(CG, NAME, AUTHOR);
    await publisher.assertionWrite(CG, NAME, AUTHOR, [
      { subject: 'urn:2963:asset', predicate: 'https://schema.org/name', object: '"unchanged payload"' },
      { subject: 'urn:2963:asset', predicate: 'https://schema.org/version', object: '"original"' },
    ]);
    const finalized = await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR });
    const quads = async (graph: string, subject?: string) => {
      const r = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ${subject ? `VALUES ?s { <${subject}> }` : ''} ?s ?p ?o } }`);
      if (r.type !== 'quads') throw new Error('Expected quads');
      return r.quads.map(({ subject, predicate, object }) => JSON.stringify({ subject, predicate, object })).sort();
    };
    const sealBefore = await quads(meta, contextGraphAssertionUri(CG, AUTHOR, NAME));
    const contentBefore = await quads(finalized.graphUri);
    store.fault = kind === 'typed-not-started'
      ? new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'test.2963.lifecycleInsert', { storeOperation: 'insert' })
      : new Error('dependency unavailable after lifecycle deletion');
    const failure = await agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR, accessPolicy: 'public' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(store.trips).toBe(1);
    expect(await agent.assertion.history(CG, NAME, { agentAddress: AUTHOR })).toBeNull();
    const incomplete = await quads(meta, lifecycle);
    for (const predicate of ['state', 'memoryLayer', 'assertionGraph']) {
      expect(incomplete.some(q => JSON.parse(q).predicate === `${DKG}${predicate}`)).toBe(false);
    }
    const identity = incomplete.filter(q => ['shareOperationId', 'promoteOperationIntent'].some(p => JSON.parse(q).predicate === `${DKG}${p}`));
    expect(identity).toHaveLength(2);
    expect(await quads(finalized.sharedGraphUri)).toEqual(contentBefore);
    expect(await quads(finalized.graphUri)).toEqual(contentBefore);
    expect(await quads(meta, contextGraphAssertionUri(CG, AUTHOR, NAME))).toEqual(sealBefore);

    // Explicit replay is characterization, deliberately not automatic-recovery proof.
    const restarted = await createPromotionAgentForTest(store, options);
    const replay = await restarted.agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR, accessPolicy: 'public' });
    expect(replay).toMatchObject({ promotedCount: 0, publishReady: true });
    expect(await restarted.agent.assertion.history(CG, NAME, { agentAddress: AUTHOR })).toMatchObject({ state: 'promoted', memoryLayer: 'SWM' });
    const repaired = await quads(meta, lifecycle);
    expect(repaired.filter(q => ['shareOperationId', 'promoteOperationIntent'].some(p => JSON.parse(q).predicate === `${DKG}${p}`))).toEqual(identity);
    expect(await quads(meta, contextGraphAssertionUri(CG, AUTHOR, NAME))).toEqual(sealBefore);
    expect(await quads(finalized.sharedGraphUri)).toEqual(contentBefore);
    expect(await quads(finalized.graphUri)).toEqual([]);
    await store.close();
  });
});
