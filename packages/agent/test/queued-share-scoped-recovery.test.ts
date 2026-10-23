import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import {
  MemoryLayer, canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1, createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { PromoteJob, PromoteExecutionAuthority } from '@origintrail-official/dkg-publisher';
import { readAssertionPromoteEvidence } from '../../publisher/src/assertion-promote-evidence.js';
import { createPromotionAgentForTest } from './_helpers/promotion-agent.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(store => store.close())); });

describe('queued share preparation and recovery in a scoped storage lane', () => {
  it('retains the scoped payload, author and seal while leaving the same-name default draft untouched', async () => {
    const signer = ethers.Wallet.createRandom(), scopedLane = signer.address;
    const defaultLane = ethers.Wallet.createRandom().address;
    const cg = 'scoped-recovery', name = 'same-name';
    const store = new OxigraphStore(); stores.push(store);
    const { agent, publisher } = await createPromotionAgentForTest(store, {
      agentAddress: defaultLane, peerId: '12D3KooWScopedRecovery', kaAllocator: makeTestKaNumberAllocator(),
    });
    // Exercise actual draft finalization, with a held scoped author distinct from the node default.
    delete agent.prepareAtomicAssertionShare;
    agent.chain = { chainId: 'mock:31337', getEvmChainId: async () => 31337n,
      getKnowledgeAssetsLifecycleAddress: async () => signer.address, hasContractCode: async () => false };
    agent.kaNumberAllocator = makeTestKaNumberAllocator();
    agent.reconciledKaAuthors = new Set();
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'legacy', killSwitchActive: false });
    agent.localAgents = new Map([[signer.address, { mode: 'custodial', privateKey: signer.privateKey }]]);
    let now = Date.now();
    agent.configurePromoteQueue({ now: () => now, leaseMs: 1000, backoff: () => 0 });
    const queue = agent.promoteQueue;
    const payload = (value: string) => [{ subject: 'urn:asset', predicate: 'urn:value', object: JSON.stringify(value) }];
    for (const [lane, value] of [[defaultLane, 'default'], [scopedLane, 'scoped']]) {
      await publisher.assertionCreate(cg, name, lane);
      await publisher.assertionWrite(cg, name, lane, payload(value));
    }
    const defaultBefore = await publisher.assertionQuery(cg, name, defaultLane);
    const { jobId } = await agent.assertion.promoteAsync(cg, name, {
      agentAddress: scopedLane, authorAgentAddress: signer.address,
    });
    const authority = (job: PromoteJob): PromoteExecutionAuthority => {
      const assertCurrent = async () => {
        const current = await queue.getStatus(job.jobId);
        expect(current.state).toBe('running');
        expect(current.lease.claimToken).toBe(job.lease!.claimToken);
        expect(current.lease.expiresAt).toBeGreaterThan(now);
      };
      return { assertCurrent, run: async mutation => { await assertCurrent(); return mutation(); } };
    };
    const first = await queue.claimNext('first-worker');
    const prepared = await agent.assertion.prepareQueuedShare(first, authority(first));
    const bound = prepared.job.request.recoveryBinding;
    const seal = (await readAssertionPromoteEvidence(store, cg, name, scopedLane)).seal!;
    expect(seal).toBeDefined();
    expect(seal.authorAddress.toLowerCase()).toBe(signer.address.toLowerCase());
    expect(bound.sealDigest).toBe(computeCanonicalGraphScopedAuthorSealDigestV1(
      canonicalGraphScopedAuthorSealFromAssertionSealV1(seal)));
    expect(prepared.job.request).toMatchObject({ agentAddress: scopedLane, authorAgentAddress: signer.address });
    // Model process exit after preparation and the durable start marker, before promotion.
    await queue.recordCommitMarker(jobId, first.lease.claimToken, 'promoteStarted');
    now += 1001;
    expect(await queue.recoverOnStartup()).toEqual({ reclaimed: 1, abandoned: 0 });
    const replacement = await queue.claimNext('replacement-worker');
    expect(replacement).toMatchObject({ jobId, attempt: { count: 2 }, request: {
      agentAddress: scopedLane, authorAgentAddress: signer.address, recoveryBinding: bound,
    } });
    expect((await agent.assertion.prepareQueuedShare(replacement, authority(replacement))).job).toEqual(replacement);
    const result = await agent.assertion.promote(cg, name, {
      ...replacement.request, executionAuthority: authority(replacement),
    });
    expect(result).toMatchObject({ sealed: true, publishReady: true });
    const sharedGraph = knowledgeAssetLayerGraphUri(cg, MemoryLayer.SharedWorkingMemory,
      createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion));
    const content = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${sharedGraph}> { ?s ?p ?o } }`);
    expect(content.type === 'quads' && content.quads.map(({ subject, predicate, object }) => ({ subject, predicate, object })))
      .toEqual(payload('scoped'));
    expect(await publisher.hasSwmShareComplete(cg, name, scopedLane)).toBe(true);
    expect(await publisher.assertionQuery(cg, name, defaultLane)).toEqual(defaultBefore);
    expect((await readAssertionPromoteEvidence(store, cg, name, defaultLane)).seal).toBeUndefined();
    expect(await publisher.hasSwmShareComplete(cg, name, defaultLane)).toBe(false);
    expect((await queue.getStatus(jobId)).request.recoveryBinding).toEqual(bound);
    expect(await queue.list({})).toHaveLength(1);
  });
});
