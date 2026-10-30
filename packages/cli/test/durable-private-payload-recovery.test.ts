import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-agent', () => import('../../agent/src/index.js'));
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { assertionLifecycleUri, createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, PrivateContentStore, StoreSchedulerBusyError, type Quad } from '@origintrail-official/dkg-storage';
import { createPromotionAgentForTest } from '../../agent/test/_helpers/promotion-agent.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { readAssertionPromoteEvidence } from '../../publisher/src/assertion-promote-evidence.js';
import { durableSynchronousShare } from '../src/daemon/routes/durable-synchronous-share.js';
import { DurableShareFailure } from '../src/daemon/routes/durable-share-failure.js';
import { createPromoteWorkerSupervisor } from '../src/daemon/worker/async-promote-worker.js';
import { daemonState } from '../src/daemon/state.js';

const signer = new Wallet(`0x${'11'.repeat(32)}`);
const AUTHOR = signer.address.toLowerCase(), CG = 'private-recovery-2963', NAME = 'mixed';
const publicQuads = [{ subject: 'urn:asset', predicate: 'urn:name', object: '"public"', graph: '' }];
const privateQuads = [{ subject: 'urn:asset', predicate: 'urn:secret', object: '"original private"', graph: '' }];
class LifecycleFaultStore extends OxigraphStore {
  failNextLifecycle = false;
  override async insert(quads: Quad[]): Promise<void> {
    if (this.failNextLifecycle && quads.some(q => q.subject === assertionLifecycleUri(CG, AUTHOR, NAME)
      && q.predicate.endsWith('/state') && q.object === '"promoted"')) {
      this.failNextLifecycle = false;
      throw new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'test.lifecycleInsert', { storeOperation: 'insert' });
    }
    return super.insert(quads);
  }
}
async function freshAgent(store: OxigraphStore) {
  const { agent, publisher } = await createPromotionAgentForTest(store, {
    agentAddress: AUTHOR, peerId: '12D3KooWPrivateRecovery', kaAllocator: makeTestKaNumberAllocator(),
  });
  // Isolate payload/queue recovery; catalog authority has separate real-store coverage.
  agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'legacy', killSwitchActive: false });
  agent.createRfc64CatalogAuthorSignerV1 = () => ({ address: AUTHOR, signMessage: signer.signMessage.bind(signer) });
  agent.configurePromoteQueue({ backoff: () => 0, maxRetries: 1 });
  return { agent, publisher };
}
async function payload(store: OxigraphStore, graph: string) {
  const result = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  expect(result.type).toBe('quads');
  return result.type === 'quads' ? result.quads.map(q => ({ ...q, graph: '' })) : [];
}
afterEach(() => { daemonState.promoteWorkerAvailable = false; vi.restoreAllMocks(); });

describe('bound recovery preserves a nonempty private partition', () => {
  it.each(['original', 'substituted', 'missing'] as const)('reopens persisted synchronous work with %s private content', async variant => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-private-recovery-'));
    const path = join(dir, 'store.nq');
    let store: OxigraphStore = new LifecycleFaultStore(path);
    let supervisor: ReturnType<typeof createPromoteWorkerSupervisor> | undefined;
    try {
      const first = await freshAgent(store);
      await first.publisher.assertionCreate(CG, NAME, AUTHOR);
      await first.publisher.assertionWrite(CG, NAME, AUTHOR, publicQuads);
      await first.publisher.assertionWritePrivate(CG, NAME, AUTHOR, privateQuads);
      // Canonical combined seal and real private graph; only author signature bytes are fixture data.
      const finalized = await finalizeRootlessAssertionForTest({ publisher: first.publisher, store,
        contextGraphId: CG, name: NAME, agentAddress: AUTHOR });
      const originalSeal = (await readAssertionPromoteEvidence(store, CG, NAME, AUTHOR)).seal;
      expect(originalSeal).toMatchObject({ publicTripleCount: 1, privateTripleCount: 1,
        kaUal: finalized.kaUal, assertionVersion: finalized.assertionVersion });
      expect(originalSeal?.privateMerkleRoot).toBeTruthy();
      daemonState.promoteWorkerAvailable = true;
      (store as LifecycleFaultStore).failNextLifecycle = true;
      const failure = await durableSynchronousShare(first.agent, CG, NAME, { agentAddress: AUTHOR }).catch(e => e);
      expect(failure).toBeInstanceOf(DurableShareFailure);
      expect(failure.observation.state).toBe('pending');
      const original = await first.agent.promoteQueue.getStatus(failure.observation.jobId);
      expect(original).toMatchObject({ state: 'failed_retrying', attempt: { count: 1 } });
      const evidence = await readAssertionPromoteEvidence(store, CG, NAME, AUTHOR);
      expect(evidence.readOperation()).toEqual({ kind: 'complete', intent: original.request.recoveryBinding.intent });
      expect(await payload(store, finalized.sharedGraphUri)).toEqual(publicQuads);
      const scope = createGraphKnowledgeAssetScope(finalized.kaUal, finalized.assertionVersion);
      const privateStore = new PrivateContentStore(store, new GraphManager(store));
      expect(await privateStore.getKnowledgeAssetPrivateTriples(CG, scope)).toEqual(privateQuads);
      const expectedPrivate = variant === 'original' ? privateQuads : variant === 'missing' ? []
        : [{ ...privateQuads[0], object: '"substituted private"' }];
      if (variant !== 'original') await privateStore.replaceKnowledgeAssetPrivateTriples(CG, scope, expectedPrivate);
      await store.close();

      // New store, publisher, agent and queue: recovery reads persisted RDF, not retained objects.
      store = new OxigraphStore(path);
      const second = await freshAgent(store);
      const prepare = vi.spyOn(second.agent, 'prepareAtomicAssertionShare');
      supervisor = createPromoteWorkerSupervisor({ agent: second.agent, workerConcurrency: 1,
        pollIntervalMs: 10, heartbeatIntervalMs: 60_000, log: () => undefined });
      await supervisor.start();
      await vi.waitFor(async () => expect((await second.agent.promoteQueue.getStatus(original.jobId)).state)
        .toBe(variant === 'original' ? 'succeeded' : 'failed'), { timeout: 10_000 });
      await supervisor.stop(); supervisor = undefined;
      const jobs = await second.agent.promoteQueue.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ jobId: original.jobId, request: original.request, attempt: { count: 2 } });
      expect(prepare).not.toHaveBeenCalled();
      const after = await readAssertionPromoteEvidence(store, CG, NAME, AUTHOR);
      expect(after.seal).toEqual(originalSeal);
      expect(after.readOperation()).toEqual(evidence.readOperation());
      expect(await payload(store, finalized.sharedGraphUri)).toEqual(publicQuads);
      expect(await new PrivateContentStore(store, new GraphManager(store)).getKnowledgeAssetPrivateTriples(CG, scope)).toEqual(expectedPrivate);
      expect(await new PrivateContentStore(store, new GraphManager(store)).getKnowledgeAssetPrivateDraftTriples(CG, AUTHOR, NAME)).toEqual([]);
      if (variant === 'original') {
        expect(await store.countQuads(finalized.graphUri)).toBe(0);
        expect(await second.agent.assertion.history(CG, NAME, { agentAddress: AUTHOR })).toMatchObject({ state: 'promoted', memoryLayer: 'SWM' });
        expect(await second.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
      } else {
        expect(jobs[0].attempt.lastError).toMatchObject({ retryable: false });
        expect(jobs[0].attempt.lastError.message).toMatch(/private.*(mismatch|count)/i);
        expect(await second.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(false);
        expect(await second.agent.promoteQueue.clearTerminalJob(original.jobId)).toMatchObject({ outcome: 'rejected' });
      }
    } finally {
      await supervisor?.stop(); await store.close(); await rm(dir, { recursive: true, force: true });
    }
  });
});
