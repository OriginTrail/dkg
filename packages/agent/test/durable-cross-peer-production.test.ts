import { Wallet } from 'ethers';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer, PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { quadsToNQuads } from '@origintrail-official/dkg-storage';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { createGraphScopedDurableManifestPlan } from '../src/sync/durable-integrity.js';
import { getSyncCheckpointKey } from '../src/sync/checkpoint/state.js';
import { CG, PEER, createHeldProductionHarness, stopHeldProductionAgents } from './_helpers/durable-held-production.js';

const SECOND_PEER = '12D3KooWRnKxyUg8W3ju7BpxN3e9NAsG1T4d6TuK53LZxD41f3RC';
afterEach(async () => { await stopHeldProductionAgents(); vi.restoreAllMocks(); });

it('carries peer A’s verified prefix through the real agent owner and paging into peer B’s DATA request', async () => {
  const h = await createHeldProductionHarness();
  await h.chain.ensureProfile();
  h.chain.setMockACKSigner(new Wallet(HARDHAT_KEYS.PUBLISHER));
  await h.internal.store.delete([...h.data, ...h.meta]);
  // Restore the actual agent paging method: only its remote byte transport is simulated below.
  h.internal.fetchSyncPages = LifecycleSyncMethods.prototype.fetchSyncPages;
  const prefixUal = h.ual.replace(/\/7$/, '/1');
  const prefixGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(prefixUal, '1'), 'reports');
  const prefix = h.data.map(q => ({ ...q, graph: prefixGraph, subject: 'urn:cross-peer:prefix' }));
  const prefixRoot = computeFlatKCRootV10(prefix, []);
  const suffix = [...h.data, ...h.data.map(q => ({ ...q, subject: 'urn:cross-peer:suffix-2' }))];
  const suffixRoot = computeFlatKCRootV10(suffix, []);
  const prefixMeta = generateGraphKnowledgeAssetMetadata({ ual: prefixUal, contextGraphId: CG,
    merkleRoot: prefixRoot, publisherPeerId: 'publisher-peer', accessPolicy: 'public', timestamp: new Date(0),
    assertionVersion: '1', publicTripleCount: prefix.length, privateTripleCount: 0,
    assertionGraph: prefixGraph, subGraphName: 'reports',
  }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
    batchId: 0n, materializedVersion: { blockNumber: 1, txIndex: 0 },
  } } });
  const suffixMeta = generateGraphKnowledgeAssetMetadata({ ual: h.ual, contextGraphId: CG,
    merkleRoot: suffixRoot, publisherPeerId: 'publisher-peer', accessPolicy: 'public', timestamp: new Date(0),
    assertionVersion: '1', publicTripleCount: suffix.length, privateTripleCount: 0,
    assertionGraph: h.graph, subGraphName: 'reports',
  }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
    batchId: 0n, materializedVersion: { blockNumber: 1, txIndex: 0 },
  } } });
  const metadata = [...prefixMeta, ...suffixMeta];
  const manifest = createGraphScopedDurableManifestPlan(metadata, CG)!;
  expect(manifest.descriptors[0]!.ual).toBe(prefixUal);
  vi.mocked(h.chain.getLatestMerkleRoot).mockImplementation(async kaId =>
    (kaId & ((1n << 96n) - 1n)) === 1n ? prefixRoot : suffixRoot);
  const writes = vi.spyOn(h.internal.store, 'replaceGraphAndSubject');
  const pages = vi.spyOn(h.internal, 'fetchSyncPages');
  const requests: Array<{ peer: string; offset: number; session?: string; verifiedOffsetAtSend: number }> = [];
  vi.spyOn(h.internal.messenger, 'sendToPeer').mockImplementation(async (peer, protocol, bytes) => {
    expect(protocol).toBe(PROTOCOL_SYNC);
    const request = h.internal.parseSyncRequest(bytes);
    expect(request.contextGraphId).toBe(CG);
    if (request.phase === 'meta') return new TextEncoder().encode(quadsToNQuads(metadata.slice(request.offset)));
    expect(request.phase).toBe('data');
    requests.push({ peer, offset: request.offset, session: request.syncSessionId,
      verifiedOffsetAtSend: h.internal.syncCheckpoints.get(getSyncCheckpointKey(peer, CG, false, 'data'))?.offset ?? 0 });
    if (peer === PEER && request.offset > 0) throw new Error('stream reset after the first complete asset');
    // A stops inside the suffix: the preceding complete graph can be checkpointed.
    const data = peer === PEER ? [...prefix, suffix[0]!] : [...prefix, ...suffix].slice(request.offset);
    return new TextEncoder().encode(quadsToNQuads(data));
  });
  const result = await h.agent.syncDurableRecoveryContextGraph(CG, {
    candidatePeerIds: [PEER, SECOND_PEER], restrictToCandidatePeerIds: true, candidatesAreSyncCapable: true,
  });
  expect(result.outcome).toBe('terminal');
  expect(result.peerId).toBe(SECOND_PEER);
  const secondRequests = requests.filter(r => r.peer === SECOND_PEER);
  expect(secondRequests[0]).toMatchObject({ offset: 0, verifiedOffsetAtSend: prefix.length }); // A fresh-session prime.
  expect(secondRequests[1]).toMatchObject({ offset: prefix.length, verifiedOffsetAtSend: prefix.length });
  expect(secondRequests[0]!.session).toBe(secondRequests[1]!.session);
  expect(secondRequests[0]!.session).not.toBe(requests[0]!.session);
  const secondDataPage = pages.mock.calls.findIndex(call => call[1] === SECOND_PEER && call[4] === 'data');
  expect(secondDataPage).toBeGreaterThanOrEqual(0);
  expect(await pages.mock.results[secondDataPage]!.value).toMatchObject({ resumedFromOffset: prefix.length });
  expect(writes.mock.calls.filter(call => call[0] === prefixGraph)).toHaveLength(1);
  expect(await h.internal.store.countQuads(prefixGraph)).toBe(prefix.length);
  expect(await h.internal.store.countQuads(h.graph)).toBe(suffix.length);
  expect(h.internal.syncCheckpoints.get(getSyncCheckpointKey(SECOND_PEER, CG, false, 'data')))
    .toMatchObject({ terminal: true, offset: prefix.length + suffix.length, manifestDigest: manifest.manifestDigest });
}, 30_000);
