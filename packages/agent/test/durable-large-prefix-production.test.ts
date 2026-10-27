import { afterEach, expect, it, vi } from 'vitest';
import { Wallet } from 'ethers';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { createOperationContext, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer, PROTOCOL_SYNC, DEFAULT_MAX_READ_BYTES } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { quadToNQuad, quadsToNQuads } from '@origintrail-official/dkg-storage';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { createGraphScopedDurableManifestPlan, graphScopedDurableManifestPrefixAtOffset } from '../src/sync/durable-integrity.js';
import { getSyncCheckpointKey } from '../src/sync/checkpoint/state.js';
import { CG, PEER, createHeldProductionHarness, stopHeldProductionAgents } from './_helpers/durable-held-production.js';

afterEach(async () => { await stopHeldProductionAgents(); vi.restoreAllMocks(); });

it('resumes a stored 100,001-row asset above the default read byte limit and settles only its suffix', async () => {
  const h = await createHeldProductionHarness();
  await h.chain.ensureProfile();
  h.chain.setMockACKSigner(new Wallet(HARDHAT_KEYS.PUBLISHER));
  await h.internal.store.delete(h.data); // The suffix metadata exists, but its DATA is missing.
  h.internal.fetchSyncPages = LifecycleSyncMethods.prototype.fetchSyncPages;
  const ual = h.ual.replace(/\/7$/, '/1');
  const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(ual, '1'), 'reports');
  const prefix = Array.from({ length: 100_001 }, (_, i) => ({ graph,
    subject: `urn:large-prefix:${i}`, predicate: 'urn:large-prefix:value', object: `"${'x'.repeat(120)}"`,
  }));
  // Even graphless proof bytes exceed the old aggregate 10 MiB export default.
  expect(Buffer.byteLength(quadToNQuad({ ...prefix[0]!, graph: '' })) * prefix.length)
    .toBeGreaterThan(DEFAULT_MAX_READ_BYTES);
  const root = computeFlatKCRootV10(prefix, []);
  const meta = generateGraphKnowledgeAssetMetadata({ ual, contextGraphId: CG,
    merkleRoot: root, publisherPeerId: 'publisher-peer', accessPolicy: 'public', timestamp: new Date(0),
    assertionVersion: '1', publicTripleCount: prefix.length, privateTripleCount: 0,
    assertionGraph: graph, subGraphName: 'reports',
  }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
    batchId: 0n, materializedVersion: { blockNumber: 1, txIndex: 0 },
  } } });
  await h.internal.store.insert([...prefix, ...meta]);
  const metadata = [...meta, ...h.meta], data = [...prefix, ...h.data];
  const manifest = createGraphScopedDurableManifestPlan(metadata, CG)!;
  expect(manifest.descriptors[0]!.ual).toBe(ual);
  const key = getSyncCheckpointKey(PEER, CG, false, 'data');
  h.internal.syncCheckpoints.setManifestBoundOffset(key, prefix.length, manifest.manifestDigest, Date.now(),
    graphScopedDurableManifestPrefixAtOffset(manifest, prefix.length)!.prefixDigest);
  const writes = vi.spyOn(h.internal.store, 'replaceGraphAndSubject');
  const queryStore = h.internal.store.query.bind(h.internal.store);
  const ordered = [...prefix].sort((a, b) => a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0);
  // Model an indexed store for this large fixture: real bounded reading and
  // Merkle verification run, without sorting 100k rows again for every OFFSET.
  const queries = vi.spyOn(h.internal.store, 'query').mockImplementation(async (query, options) => {
    if (options?.source !== 'agent.durableSync.heldAssetContent' || !query.includes(`<${graph}>`))
      return queryStore(query, options);
    if (query.includes('COUNT(*)')) return { type: 'bindings', bindings: [{ count: String(prefix.length) }] };
    expect(query).toContain('ORDER BY');
    const offset = Number(query.match(/OFFSET (\d+)/)![1]);
    const limit = Number(query.match(/LIMIT (\d+)/)![1]);
    return { type: 'bindings', bindings: ordered.slice(offset, offset + limit)
      .map(q => ({ s: q.subject, p: q.predicate, o: q.object })) };
  });
  const offsets: number[] = [];
  vi.spyOn(h.internal.messenger, 'sendToPeer').mockImplementation(async (peer, protocol, bytes) => {
    expect(peer).toBe(PEER); expect(protocol).toBe(PROTOCOL_SYNC);
    const request = h.internal.parseSyncRequest(bytes);
    const rows = request.phase === 'meta' ? metadata : data;
    if (request.phase === 'data') {
      offsets.push(request.offset);
      expect(request.offset === 0 || request.offset >= prefix.length).toBe(true);
    }
    return new TextEncoder().encode(quadsToNQuads(rows.slice(request.offset, request.offset + request.limit)));
  });
  const { result } = await LifecycleSyncMethods.prototype.runLegacyDurableSyncDetailed.call(
    h.agent, createOperationContext('sync'), PEER, [CG],
  );
  expect(result.complete).toBe(true);
  expect(result.failedPhases).toBe(0);
  expect(offsets.slice(0, 2)).toEqual([0, prefix.length]);
  expect(writes.mock.calls.filter(call => call[0] === graph)).toHaveLength(0);
  expect(writes.mock.calls.filter(call => call[0] === h.graph)).toHaveLength(1);
  expect(await h.internal.store.countQuads(graph)).toBe(prefix.length);
  expect(await h.internal.store.countQuads(h.graph)).toBe(h.data.length);
  expect(h.internal.syncCheckpoints.get(key)).toMatchObject({ terminal: true, offset: data.length });
  const proofPages = queries.mock.calls.filter(call =>
    call[1]?.source === 'agent.durableSync.heldAssetContent' && /ORDER BY/.test(call[0]));
  expect(proofPages.length).toBeGreaterThan(100);
  for (const [query, options] of proofPages) {
    expect(Number(query.match(/LIMIT (\d+)/)![1])).toBeLessThanOrEqual(256);
    expect(options.maxResponseBytes).toBeLessThanOrEqual(DEFAULT_MAX_READ_BYTES);
  }
}, 120_000);
