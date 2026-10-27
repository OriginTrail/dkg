// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { BULK_GRAPH_KIND as K, contextGraphMetaUri, knowledgeAssetLayerGraphUri,
  MemoryLayer, createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, readConfirmedGraphKnowledgeAssetMetadataEnvelope } from '@origintrail-official/dkg-publisher';
import { recoverPublicSnapshotBulk, type PublicSnapshotBulkHost } from '../src/public-snapshot-bulk.js';
import { recoverPublicSnapshotToCurrent } from '../src/public-snapshot-catch-up.js';
import { PublicSnapshotEvidence, type PublicSnapshotObservation } from '../src/public-snapshot-evidence.js';
import { createPublicSnapshotHeldAssetCheck } from '../src/public-snapshot-held-assets.js';
import { fixture, cg, address } from './helpers/bulk-graph-fixture.js';
import { observeOutboundBulkFrames } from './helpers/observe-bulk-graph-frames.js';

it('bulk catch-up authenticates refreshed pins, replaces an imported version and adds an asset within one deadline', async () => {
  const f = await fixture(2), [a, b] = f.uals;
  const entries = [...f.byId].map(([id, root]) => ({ id: String(id), root: `0x${Buffer.from(root).toString('hex')}`, version: '1' }));
  const seal = (assets: typeof entries, blockNumber: string): PublicSnapshotObservation => {
    const observedAt = Date.now();
    return { mode: 'core-cache', sourceCore: f.supplierPeer, snapshot: sealPublicGraphSnapshot({
      version: 1, chainId: 'base:84532', deploymentId: 'fixture', contextGraphId: cg,
      onChainId: '14', nameHash: `0x${'1'.repeat(64)}`, contextGraphStorage: `0x${'2'.repeat(40)}`,
      assetStorage: address, blockNumber, blockHash: `0x${'3'.repeat(64)}`, finalityConfirmations: 1,
      observedAt, expiresAt: observedAt + 120_000, accessPolicy: 0, assets,
    }) };
  };
  const initial = seal(entries.slice(0, 1), '10');
  const graph = knowledgeAssetLayerGraphUri(cg, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(a!, 2));
  const data = [{ subject: 'urn:entity:1:0', predicate: 'urn:payload', object: '"updated version two"', graph }];
  const root = computeFlatKCRootV10(data, []), rootHex = `0x${Buffer.from(root).toString('hex')}`;
  const metadata = generateGraphKnowledgeAssetMetadata({ contextGraphId: cg, ual: a!, assertionGraph: graph,
    assertionVersion: 2, publicTripleCount: 1, privateTripleCount: 0, merkleRoot: root, authorAddress: address,
    publisherPeerId: 'fixture', accessPolicy: 'public', allowedPeers: [], timestamp: new Date() },
    { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
      batchId: BigInt(entries[0]!.id), materializedVersion: { blockNumber: 11, txIndex: 0 },
    } } });
  let next: PublicSnapshotObservation | undefined;
  const readFresh = vi.fn(async () => {
    if (!next) {
      expect(await createPublicSnapshotHeldAssetCheck(f.target, new PublicSnapshotEvidence(initial, () => true))(a!)).toBe(true);
      await f.source.replaceGraphAndSubject!(graph, data, contextGraphMetaUri(cg), a!, metadata);
      next = seal([{ ...entries[0]!, version: '2', root: rootHex }, entries[1]!], '11');
    }
    return next;
  });
  const requests: { snapshotDigest: string; assetUals: string[] }[] = [];
  observeOutboundBulkFrames(f.router, frame => {
    if (frame.kind === K.REQUEST) requests.push(JSON.parse(Buffer.from(frame.payload).toString()));
  });
  const deadlines: number[] = [], timeouts: number[] = [];
  const exchange = f.router.withDuplexStream.bind(f.router);
  f.router.withDuplexStream = (peer, protocol, options, consume) => {
    timeouts.push(options.timeoutMs); return exchange(peer, protocol, options, consume);
  };
  const host: PublicSnapshotBulkHost = {
    store: f.target, router: f.router, ensurePeerConnected: async () => {},
    verification: {
      parseAndFilter: (text, graph, context) => f.worker.parseAndFilter(text, graph, context),
      processBatch: (data, meta, _ctx, accept = false, mode) => f.worker.processDurableBatch(data, meta, accept, mode),
    }, reconcile: async () => {},
  };
  const signal = new AbortController().signal, deadline = Date.now() + 30_000;
  const result = await recoverPublicSnapshotToCurrent({ initial, deadline, signal, assertCurrent: () => signal.throwIfAborted(),
    readFresh, recover: observation => {
      deadlines.push(deadline);
      return recoverPublicSnapshotBulk(host, { contextGraphId: cg,
        peerBatches: async function* () { yield [f.supplierPeer]; },
        uals: observation === initial ? [a!] : [a!, b!],
        evidence: new PublicSnapshotEvidence(observation, () => true), signal,
        assertCurrent: () => signal.throwIfAborted(), deadline, dataDir: f.directory,
        shouldQuarantineCommitted: () => false, onCommitted: () => {}, log: () => {},
      });
    } });
  expect(result.rounds).toBe(2); expect(result.observation).toBe(next); expect(result.fresh).toBe(next);
  expect(result.recovered.committed).toEqual(new Set([a, b])); expect(readFresh).toHaveBeenCalledTimes(2);
  expect(requests.map(r => ({ snapshotDigest: r.snapshotDigest, assetUals: r.assetUals }))).toEqual([
    { snapshotDigest: initial.snapshot.snapshotDigest, assetUals: [a] },
    { snapshotDigest: next!.snapshot.snapshotDigest, assetUals: [a, b] },
  ]);
  expect(next!.snapshot.snapshotDigest).not.toBe(initial.snapshot.snapshotDigest);
  expect(result.bulkChunks).toHaveLength(2);
  expect(result.bulkChunks!.map(chunk => chunk.committedAssets)).toEqual([1, 2]);
  expect(result.bulkChunks!.every(chunk => chunk.encodedBytes > 0)).toBe(true);
  expect(deadlines).toEqual([deadline, deadline]); expect(timeouts).toHaveLength(2);
  expect(timeouts[1]).toBeLessThanOrEqual(timeouts[0]!); expect(timeouts[1]).toBeLessThan(30_000);
  const holds = createPublicSnapshotHeldAssetCheck(f.target, new PublicSnapshotEvidence(next!, () => true));
  expect(await holds(a!)).toBe(true); expect(await holds(b!)).toBe(true);
  const stored = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(f.target, { contextGraphId: cg, ual: a! });
  expect(stored).toMatchObject({ state: 'confirmed', envelope: { assertionVersion: '2', assertionGraph: graph } });
  const content = await f.target.query(`SELECT ?value WHERE { GRAPH <${graph}> { <urn:entity:1:0> <urn:payload> ?value } }`);
  expect(content).toMatchObject({ type: 'bindings', bindings: [{ value: '"updated version two"' }] });
}, 30_000);
