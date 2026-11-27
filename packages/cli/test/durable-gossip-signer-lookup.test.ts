import { afterEach, expect, it, vi } from 'vitest';
import { Wallet } from 'ethers';
vi.mock('@origintrail-official/dkg-agent', () => import('../../agent/src/index.js'));
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { connectRemoteSigners } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';
import { startFakeRemoteSigner } from '../../chain/test/helpers/fake-remote-signer.js';
import { createPromotionAgentForTest } from '../../agent/test/_helpers/promotion-agent.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { durableSynchronousShare } from '../src/daemon/routes/durable-synchronous-share.js';
import { DurableShareFailure } from '../src/daemon/routes/durable-share-failure.js';
import { createPromoteWorkerSupervisor } from '../src/daemon/worker/async-promote-worker.js';
import { daemonState } from '../src/daemon/state.js';

const author = new Wallet(`0x${'11'.repeat(32)}`);
const absent = new Wallet(`0x${'22'.repeat(32)}`);
const payer = new Wallet(`0x${'33'.repeat(32)}`);
const CG = 'signer-discovery-recovery', NAME = 'asset', AUTHOR = author.address.toLowerCase();
afterEach(() => { daemonState.promoteWorkerAvailable = false; vi.restoreAllMocks(); });

it.each(['timeout', 'http503', 'credentials', 'policy'] as const)(
  'classifies real external account discovery %s after durable admission', async fault => {
    let failing = false;
    const fake = await startFakeRemoteSigner({
      credentials: [{ token: 'payer-test', keys: [payer.privateKey] }, { token: 'author-test', keys: [author.privateKey] }],
      rawResponse: method => failing && method === 'eth_accounts' && (fault === 'http503' || fault === 'credentials')
        ? { status: fault === 'http503' ? 503 : 401, body: 'signer unavailable' } : undefined,
      reject: method => failing && method === 'eth_accounts' && fault === 'policy'
        ? { code: -32000, message: 'account discovery refused by policy' } : undefined,
      tamper: async (method, result) => {
        if (failing && method === 'eth_accounts' && fault === 'timeout') await new Promise(resolve => setTimeout(resolve, 1_000));
        return result;
      },
    });
    const remote = await connectRemoteSigners({ url: fake.url, authToken: 'payer-test', timeoutMs: 500,
      author: { authToken: 'author-test', address: author.address } });
    const store = new OxigraphStore();
    let supervisor: ReturnType<typeof createPromoteWorkerSupervisor> | undefined;
    try {
      const { agent, publisher } = await createPromotionAgentForTest(store,
        { agentAddress: AUTHOR, peerId: '12D3KooWRecovery', kaAllocator: makeTestKaNumberAllocator() });
      agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'legacy', killSwitchActive: false });
      agent.config.authorSigners = remote.authors;
      // A is not served, B is: every resolution must refresh accounts before choosing B.
      agent.localAgents = new Map([absent, author].map(wallet => [wallet.address.toLowerCase(), { agentAddress: wallet.address }]));
      agent.resolveContextGraphAgentGateAuthority = async () => ({ kind: 'gated', agentAddresses: [absent.address, author.address] });
      agent.resolveWorkspaceGossipSigningAgent = Object.getPrototypeOf(agent).resolveWorkspaceGossipSigningAgent;
      agent.configurePromoteQueue({ backoff: () => 250, maxRetries: 1 });
      await publisher.assertionCreate(CG, NAME, AUTHOR);
      await publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:asset', predicate: 'https://schema.org/name', object: '"original"' }]);
      const finalized = await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR });
      const contentBefore = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${finalized.graphUri}> { ?s ?p ?o } }`);
      const queue = agent.promoteQueue, admit = queue.enqueueAndClaim.bind(queue);
      vi.spyOn(queue, 'enqueueAndClaim').mockImplementation(async (...args: Parameters<typeof admit>) => {
        const job = await admit(...args); failing = true; return job;
      });
      daemonState.promoteWorkerAvailable = true;
      const failure = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR }).catch(e => e);
      expect(failure).toBeInstanceOf(DurableShareFailure);
      const original = await queue.getStatus(failure.observation.jobId);
      expect(original.request.recoveryBinding).toBeDefined();
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
      expect(await store.countQuads(finalized.graphUri)).toBe(1);
      const callsAtFailure = fake.calls('eth_accounts').length;
      expect(callsAtFailure).toBeGreaterThanOrEqual(4); // connection, admission, execution
      const permanent = fault === 'credentials' || fault === 'policy';
      expect(original.state).toBe(permanent ? 'failed' : 'failed_retrying');
      const reopened = new TripleStoreAsyncPromoteQueue(store, { backoff: () => 250, maxRetries: 1 });
      vi.spyOn(agent, 'promoteQueue', 'get').mockReturnValue(reopened);
      if (permanent) {
        failing = false;
        expect(await reopened.claimNext('worker')).toBeNull();
        expect(fake.calls('eth_accounts')).toHaveLength(callsAtFailure);
        expect((await reopened.getStatus(original.jobId))?.request.recoveryBinding).toEqual(original.request.recoveryBinding);
        return;
      }
      const reseal = vi.spyOn(agent, 'prepareAtomicAssertionShare');
      supervisor = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, log: () => undefined });
      await supervisor.start();
      await vi.waitFor(async () => {
        const retry = await reopened.getStatus(original.jobId);
        expect(retry?.state).toBe('failed_retrying');
        expect(retry?.attempt.count).toBe(2);
      }, { timeout: 3_000 });
      failing = false;
      await vi.waitFor(async () => expect((await reopened.getStatus(original.jobId))?.state).toBe('succeeded'), { timeout: 3_000 });
      const completed = await reopened.getStatus(original.jobId);
      expect(completed.request.recoveryBinding).toEqual(original.request.recoveryBinding);
      expect(completed.attempt.count).toBe(3);
      expect(await reopened.list({})).toHaveLength(1);
      expect(fake.calls('eth_accounts')).toHaveLength(callsAtFailure + 2);
      expect(reseal).not.toHaveBeenCalled();
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      expect(await store.countQuads(finalized.graphUri)).toBe(0);
      expect(await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${finalized.sharedGraphUri}> { ?s ?p ?o } }`)).toEqual(contentBefore);
      expect(agent.publishWorkspaceGossip).toHaveBeenCalledTimes(1);
      expect(agent.publishWorkspaceGossip.mock.calls[0][3].agentAddress.toLowerCase()).toBe(AUTHOR);
      expect(agent.publishWorkspaceGossip.mock.calls[0][4]).toBe(original.request.recoveryBinding.intent.operationId);
    } finally {
      await supervisor?.stop(); await store.close(); remote.destroy(); await fake.close();
    }
  });
