import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  createGraphKnowledgeAssetScope, createOperationContext, knowledgeAssetLayerGraphUri, MemoryLayer, generateEd25519Keypair, TypedEventBus,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10, DKGPublisher, FileWorkspacePublicSnapshotStore, storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
  workspacePublicQuadsDigest, readConfirmedGraphKnowledgeAssetMetadataEnvelope,
} from '@origintrail-official/dkg-publisher';
import {
  reconcileFinalizedSwmTwinFromProjection,
} from '../src/sync/requester/finalized-swm-twin-reconciliation.js';
import { FinalizationHandler, type FinalizationHandlerOptions } from '../src/finalization-handler.js';
import { PublishMethods } from '../src/dkg-agent-publish.js';
import type { DKGAgent } from '../src/dkg-agent.js';
import { verifyExactGraphContent } from '../src/exact-graph-content-verifier.js';
import { samePublicRdfTriples } from '../src/same-public-rdf-triples.js';
import { baseRequest, chainWithSnapshotRead, currentView, positionedEvidence, TX_HASH } from './_helpers/named-ka-recovery-fixture.js';

type Input = Parameters<PublishMethods['_finalizeRecoveredQueuedKnowledgeAssetVmPublish']>[0];

const quad = (object: string, index = 0): Quad => ({
  subject: `urn:fixture:${index}`, predicate: 'urn:fixture:label', object, graph: '',
});

describe('confirmed queued publication with an escaped operation snapshot', () => {
  // The first eleven cases have complete VM and a retained transaction-bearing job.
  const cases = [
    ['included', 21, 'vm'], ['included', 23, 'vm'], ['included', 23, 'both'],
    ['broadcast', 23, 'both'], ['broadcast', 23, 'both'], ['included', 44, 'both'],
    ['included', 23, 'both'], ['broadcast', 23, 'both'], ['included', 23, 'both'],
    ['broadcast', 44, 'both'], ['broadcast', 23, 'both'],
    ['included', 23, 'swm'], // confirmed before VM materialization
    ['included', 23, 'partial-swm'], ['included', 23, 'empty-swm'],
    ['included', 23, 'ambiguous-swm'], ['included', 23, 'other-operation'],
    ['included', 23, 'newer-swm'], // another SWM head wins before locked retirement
  ] as const;
  it.each(cases)('finishes %s with %i rows in %s (%#)', async (status, count, copies) => {
    const store = new OxigraphStore();
    const dir = await mkdtemp(join(tmpdir(), 'confirmed-operation-'));
    try {
      // HTTP stores may return Unicode in SELECT bindings but escapes in CONSTRUCT text.
      const query = store.query.bind(store);
      vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
        const result = await query(sparql, options);
        if (result.type !== 'quads' || !sparql.trimStart().startsWith('CONSTRUCT')) return result;
        return { ...result, quads: result.quads.map(q => ({ ...q, object: q.object.replaceAll('é', String.raw`\u00E9`) })) };
      });
      const snapshot = new FileWorkspacePublicSnapshotStore(dir);
      const original = Array.from({ length: count }, (_, i) => quad(String.raw`"caf\u00E9 ${i}"`, i));
      const observed = original.map((q, i) => ({ ...q, object: `"café ${i}"` }));
      expect(workspacePublicQuadsDigest(original)).not.toBe(workspacePublicQuadsDigest(observed));
      const root = ethers.hexlify(computeFlatKCRootV10(original, [])) as `0x${string}`;
      const request = { ...baseRequest(), publicTripleCount: count, sealMerkleRoot: root };
      request.seal = { ...request.seal, merkleRoot: root };
      const scope = createGraphKnowledgeAssetScope(request.kaUal!, request.assertionVersion!);
      const chain = chainWithSnapshotRead(async () => ({ ...currentView(), latestRoot: root }));
      const writeLocks = new Map<string, Promise<void>>();
      const publisher = new DKGPublisher({ store, chain, eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
      const workspace = { store, graphManager: new GraphManager(store), contextGraphId: request.contextGraphId,
        shareOperationId: request.shareOperationId, kaUal: scope.ual, assertionVersion: scope.assertionVersion };
      const retirementOutcomes: string[] = [];
      let retireCalls = 0;
      const swmGraph = knowledgeAssetLayerGraphUri(request.contextGraphId, MemoryLayer.SharedWorkingMemory, scope);
      const reconcileTwin = vi.fn<NonNullable<FinalizationHandlerOptions['reconcileConfirmedGraphScopedSwmTwin']>>(
        async (evidence, ctx) => {
          if (copies === 'partial-swm') await store.deleteByPattern({ graph: swmGraph, subject: observed[0]!.subject });
          if (copies === 'empty-swm') await store.dropGraph(swmGraph);
          if (copies === 'ambiguous-swm' || copies === 'other-operation') {
            const successor = { ...workspace, shareOperationId: 'separate-operation',
              assertionVersion: copies === 'other-operation' ? scope.assertionVersion : '2' };
            await storeKnowledgeAssetOperationPublicQuads({ ...successor, quads: original, publicSnapshotStore: snapshot });
            await storeKnowledgeAssetWorkspaceHead(successor);
            if (copies === 'ambiguous-swm') await store.deleteByPattern({
              graph: workspace.graphManager.sharedMemoryMetaUri(request.contextGraphId),
              subject: scope.ual + '#dkg-swm-head', predicate: 'http://dkg.io/ontology/shareOperationId',
            });
          }
          if (copies === 'newer-swm') await storeKnowledgeAssetWorkspaceHead({ ...workspace, assertionVersion: '2' });
          const outcome = await reconcileFinalizedSwmTwinFromProjection({ store, writeLocks, evidence,
            retire: async (candidate) => {
              retireCalls++;
              await publisher.clearPublishedKnowledgeAssetSwm(candidate.contextGraphId,
                { kind: 'named-lifecycle', identity: { agentAddress: candidate.agentAddress, kaNumber: candidate.kaNumber } },
                candidate.subGraphName, ctx, candidate.kaUal);
            } });
          retirementOutcomes.push(outcome);
        },
      );
      const handler = new FinalizationHandler(store, chain, { reconcileConfirmedGraphScopedSwmTwin: reconcileTwin });
      await storeKnowledgeAssetOperationPublicQuads({
        ...workspace, quads: original, publicSnapshotStore: snapshot,
      });
      if (copies !== 'vm') await storeKnowledgeAssetWorkspaceHead(workspace);
      const layers = [];
      if (copies !== 'vm') layers.push(MemoryLayer.SharedWorkingMemory);
      if (copies !== 'swm') layers.push(MemoryLayer.VerifiableMemory);
      for (const layer of layers) {
        const graph = knowledgeAssetLayerGraphUri(request.contextGraphId, layer, scope);
        await store.insert(observed.map(q => ({ ...q, graph })));
      }
      const vmGraph = knowledgeAssetLayerGraphUri(request.contextGraphId, MemoryLayer.VerifiableMemory, scope);
      const digest = workspacePublicQuadsDigest(original);
      const writeReceipt = vi.fn(async () => {
        // VM content and the original on-chain identity must be present before the receipt is completed.
        const verified = await verifyExactGraphContent(store, { graphUri: vmGraph, publicTripleCount: count,
          expectedMerkleRoot: ethers.getBytes(root), expectedPublicQuadsDigest: digest,
          operationQuads: original, source: 'test.recoveredReceipt' });
        expect(verified.status).toBe('verified');
        if (verified.status !== 'verified') throw new Error('missing recovered VM copy');
        expect(verified.quads).toEqual(expect.arrayContaining(observed));
        expect(verified.equivalentOperationDigest).toBe(digest);
        const metadata = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, {
          contextGraphId: request.contextGraphId, ual: scope.ual,
        });
        expect(metadata).toMatchObject({ state: 'confirmed', envelope: { transactionHash: TX_HASH, publicTripleCount: count } });
      });
      const catalog = vi.fn();
      const receiver = {
        store, chain, publicSnapshotStore: snapshot, peerId: 'test-peer',
        log: { info: vi.fn() }, namedKaRecoveryPendingLog: { versionViewRead() {} },
        getContextGraphOnChainId: async () => '1', getOrCreateFinalizationHandler: () => handler,
        writeLocks, _writeQueuedKnowledgeAssetVmPublishReceipt: writeReceipt,
        _resolveRecoveredKnowledgeAssetVmLifecycleAuthor: async () => undefined,
        afterConfirmedGraphScopedVmPublishV1: catalog,
      };
      const evidence = positionedEvidence();
      const input = {
        request, walletId: 'wallet', lookup: { txHash: TX_HASH, walletId: 'wallet' },
        job: { jobId: 'retained-job', status, broadcast: { txHash: TX_HASH, merkleRoot: root } },
        recovery: { ...evidence, publishProof: { ...evidence.publishProof, merkleRoot: root } },
      } as Input;
      await PublishMethods.prototype._finalizeRecoveredQueuedKnowledgeAssetVmPublish.call(
        receiver as unknown as DKGAgent, input, createOperationContext('system'),
      );
      expect(writeReceipt).toHaveBeenCalledExactlyOnceWith(request, TX_HASH, 77, BigInt(request.seal.reservedKaId!));
      expect(reconcileTwin).toHaveBeenCalledWith(expect.objectContaining({
        publicQuadsDigest: workspacePublicQuadsDigest(observed),
        arrival: 'recovered-operation', shareOperationId: request.shareOperationId, operationDigest: digest,
      }), expect.anything());
      if (copies === 'partial-swm' || copies === 'empty-swm') {
        const partial = copies === 'partial-swm';
        expect(retirementOutcomes).toEqual([partial ? 'content-mismatch' : 'retired']);
        expect(retireCalls).toBe(partial ? 0 : 1);
        expect(await store.countQuads(swmGraph)).toBe(partial ? count - 1 : 0);
        const meta = workspace.graphManager.sharedMemoryMetaUri(request.contextGraphId);
        for (const subject of [scope.ual + '#dkg-swm-head', `urn:dkg:share:${request.contextGraphId}:${request.shareOperationId}`]) {
          expect(await store.query(`ASK { GRAPH <${meta}> { <${subject}> ?p ?o } }`)).toEqual({ type: 'boolean', value: partial });
        }
      } else if (copies === 'ambiguous-swm' || copies === 'other-operation') {
        expect(retirementOutcomes).toContain(copies === 'ambiguous-swm' ? 'head-missing-or-ambiguous' : 'swm-commitment-mismatch');
        expect(await store.countQuads(swmGraph)).toBe(count);
        const meta = workspace.graphManager.sharedMemoryMetaUri(request.contextGraphId);
        const operation = `urn:dkg:share:${request.contextGraphId}:separate-operation`;
        expect(await store.query(`ASK { GRAPH <${meta}> { <${operation}> ?p ?o } }`)).toEqual({ type: 'boolean', value: true });
      } else if (copies === 'newer-swm') {
        expect(retirementOutcomes).toContain('head-version-mismatch');
        expect(await store.countQuads(swmGraph)).toBe(count);
      } else if (copies !== 'vm') {
        expect(retirementOutcomes).toContain('retired');
        expect(await store.countQuads(swmGraph)).toBe(0);
      }
      expect(catalog).toHaveBeenCalledWith(expect.objectContaining({
        shareOperationId: request.shareOperationId,
        confirmedTransaction: expect.objectContaining({ txHash: TX_HASH, blockNumber: 77 }),
      }));
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('compares complete RDF triples with multiplicity, without value coercion or blank-node identity', () => {
    const a = quad(String.raw`"\u00e9"@fr`);
    const b = quad('"é"@fr');
    expect(samePublicRdfTriples([a, b], [b, b])).toBe(true);
    expect(samePublicRdfTriples([a], [quad('"é"@FR')])).toBe(true);
    for (const other of [
      { ...b, subject: 'urn:other' }, { ...b, predicate: 'urn:other' }, { ...b, graph: 'urn:other' },
      quad('"é"@en'), quad('"é"'), quad(String.raw`"\\u00e9"@fr`), quad('"é"@fr'), quad('urn:é'),
    ]) expect(samePublicRdfTriples([a, b], [b, other])).toBe(false);
    for (const row of [quad('_:a'), { ...a, subject: '_:a' }, quad(String.raw`"\xFF"`)]) {
      expect(samePublicRdfTriples([a, row], [b, row])).toBe(false);
    }
  });

  it('requires original digest and strict term equality even when chain roots agree', async () => {
    const store = new OxigraphStore();
    try {
      const original = [quad('"01"^^<http://www.w3.org/2001/XMLSchema#integer>')];
      const stored = [quad('"1"^^<http://www.w3.org/2001/XMLSchema#integer>')];
      const graphUri = 'urn:fixture:graph';
      await store.insert(stored.map(q => ({ ...q, graph: graphUri })));
      const expectedMerkleRoot = computeFlatKCRootV10(original, []);
      expect(expectedMerkleRoot).toEqual(computeFlatKCRootV10(stored, []));
      const input = { graphUri, publicTripleCount: 1, expectedMerkleRoot,
        expectedPublicQuadsDigest: workspacePublicQuadsDigest(original), source: 'test.recovery' };
      for (const quads of [undefined, [], original, stored]) {
        expect((await verifyExactGraphContent(store, { ...input, operationQuads: quads })).status).toBe('head-mismatch');
      }
    } finally { await store.close(); }
  });
});
