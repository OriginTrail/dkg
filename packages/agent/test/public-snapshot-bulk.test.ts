import { describe, expect, it, vi } from 'vitest';
import { sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { BULK_GRAPH_KIND as K, BULK_GRAPH_PROTOCOL, BULK_GRAPH_CHUNK_BYTES, contextGraphMetaUri, knowledgeAssetLayerGraphUri,
  MemoryLayer, createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../src/dkg-agent.js';
import { recoverPublicSnapshotBulk } from '../src/public-snapshot-bulk.js';
import { PublicSnapshotEvidence } from '../src/public-snapshot-evidence.js';
import { fixture, cg } from './helpers/bulk-graph-fixture.js';

// Reduce only the local fixture's chunk bound; run the real stream, verifier,
// snapshot authentication and group publication on each side of the boundary.
vi.mock('@origintrail-official/dkg-core', async importOriginal => ({
  ...await importOriginal<typeof import('@origintrail-official/dkg-core')>(), BULK_GRAPH_CHUNK_BYTES: 300,
}));

describe('public bulk snapshot recovery', () => {
  it.each(['connect', 'protocols', 'delayed-identify', 'reconciliation'] as const)('uses a healthy supplier after %s and recovers across chunks', async failure => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Set<string>(), completed = new Set<string>(), controls: number[] = [];
    const f = await fixture(5, -1, false, { onControl: frame => {
      if (failure !== 'reconciliation' || frame.kind !== K.COMMIT) return;
      controls.push(frame.index);
      expect(completed.has(f.uals[frame.index]!)).toBe(true);
    } });
    const snapshot = sealPublicGraphSnapshot({ version: 1, chainId: 'base:84532', deploymentId: 'fixture',
      contextGraphId: cg, onChainId: '14', nameHash: `0x${'1'.repeat(64)}`,
      contextGraphStorage: `0x${'2'.repeat(40)}`, assetStorage: `0x${'0'.repeat(39)}1`,
      blockNumber: '10', blockHash: `0x${'3'.repeat(64)}`, finalityConfirmations: 1,
      observedAt: Date.now(), expiresAt: Date.now() + 120_000, accessPolicy: 0,
      assets: [...f.byId].map(([id, root]) => ({ id: String(id), root: `0x${Buffer.from(root).toString('hex')}`, version: '1' })),
    });
    const ensure = vi.fn(async (peer: string) => { if (peer === 'offline' && failure === 'connect') throw new Error('admission unavailable'); });
    const protocols = vi.fn(async (peer: string) => { if (peer === 'offline') throw new Error('probe unavailable'); return failure === 'delayed-identify' ? [] : [BULK_GRAPH_PROTOCOL]; });
    const probe = vi.spyOn(f.router, 'probeProtocol');
    const agent = { store: f.target, router: f.router, ensurePeerConnected: ensure, getPeerProtocols: protocols,
      getOrCreateSyncVerifyWorker: () => f.worker,
      processDurableBatchInWorker: ((data, meta, _ctx, accept, mode) => f.worker.processDurableBatch(data, meta, accept, mode)) as DKGAgent['processDurableBatchInWorker'],
      reconcileAfterGraphScopedMaterialization: async (asset: { ual: string }) => {
        if (failure !== 'reconciliation') return;
        started.add(asset.ual); await held; completed.add(asset.ual);
      },
    } as unknown as DKGAgent;
    const requests: string[][] = [], peers: string[] = [];
    const exchange = f.router.withDuplexStream.bind(f.router);
    vi.spyOn(f.router, 'withDuplexStream').mockImplementation((peer, protocol, options, consume) => {
      peers.push(peer);
      return exchange(peer, protocol, options, (stream, signal) => {
        const send = stream.send.bind(stream);
        let first = true;
        stream.send = bytes => {
          if (first) { first = false; requests.push(JSON.parse(Buffer.from(bytes.subarray()).subarray(20).toString()).assetUals); }
          return send(bytes);
        };
        return consume(stream, signal);
      });
    });
    const signal = new AbortController().signal;
    const pending = recoverPublicSnapshotBulk(agent, { contextGraphId: cg, peers: ['offline', f.supplierPeer],
      uals: f.uals, evidence: new PublicSnapshotEvidence({ mode: 'core-cache', snapshot, sourceCore: f.supplierPeer }, () => true),
      signal, assertCurrent: () => signal.throwIfAborted(), deadline: Date.now() + 30_000, dataDir: f.directory,
      shouldQuarantineCommitted: () => false, onCommitted: () => {}, log: () => {},
    });
    if (failure === 'reconciliation') {
      try {
        await vi.waitFor(() => expect(started.size).toBeGreaterThanOrEqual(2), { timeout: 5000 });
        expect(controls).toHaveLength(0);
      } finally { release(); }
    } else release();
    const result = await pending;
    if (failure === 'reconciliation') expect(completed).toEqual(new Set(f.uals));
    expect(ensure.mock.calls.map(call => call[0])).toEqual(['offline', f.supplierPeer]);
    if (failure === 'delayed-identify') expect(probe).toHaveBeenCalledExactlyOnceWith(f.supplierPeer, BULK_GRAPH_PROTOCOL, 3_000, signal);
    else expect(probe).not.toHaveBeenCalled();
    expect(result.committed).toEqual(new Set(f.uals));
    expect(result.bulkChunks!.length).toBeGreaterThanOrEqual(2);
    expect(requests[0]).toEqual(f.uals);
    expect(requests[1]).toEqual(f.uals.slice(result.bulkChunks![0]!.committedAssets));
    expect(requests).toHaveLength(result.bulkChunks!.length);
    expect(peers.every(peer => peer === f.supplierPeer)).toBe(true);
    expect(result.bulkChunks!.every(chunk => chunk.encodedBytes <= BULK_GRAPH_CHUNK_BYTES)).toBe(true);
    expect(result.bulkChunks!.reduce((n, chunk) => n + chunk.committedAssets, 0)).toBe(f.uals.length);
    for (const ual of f.uals) expect(await f.target.countQuads(knowledgeAssetLayerGraphUri(cg,
      MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, 1)))).toBe(1);
    const roots = await f.target.query(`SELECT ?ual ?root WHERE { GRAPH <${contextGraphMetaUri(cg)}> { ?ual <http://dkg.io/ontology/merkleRoot> ?root } } ORDER BY ?ual`);
    if (roots.type !== 'bindings') throw new Error('Expected stored roots');
    expect(roots.bindings.map(row => ({ ual: row.ual, root: `0x${JSON.parse(row.root!).replace(/^0x/, '')}` })))
      .toEqual(f.uals.map((ual, i) => ({ ual, root: snapshot.assets[i]!.root })));
  }, 30_000);

  it('negotiates missing advertisements and rejects genuinely unsupported cores without sending a snapshot', async () => {
    const probe = vi.fn(async (_peer: string, _protocol: string, _timeout: number, _signal: AbortSignal) => 'unsupported');
    const exchange = vi.fn();
    const agent = { ensurePeerConnected: vi.fn(), getPeerProtocols: async () => [],
      router: { probeProtocol: probe, withDuplexStream: exchange } } as unknown as DKGAgent;
    const signal = new AbortController().signal;
    await expect(recoverPublicSnapshotBulk(agent, { contextGraphId: cg, peers: ['unsupported'], uals: [],
      evidence: {} as PublicSnapshotEvidence, signal, assertCurrent: () => {}, deadline: Date.now() + 500,
      dataDir: '/unused', shouldQuarantineCommitted: () => false, onCommitted: () => {}, log: () => {},
    })).rejects.toThrow('Configured cores do not support bulk graph v1');
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]![2]).toBeLessThanOrEqual(500);
    expect(probe.mock.calls[0]![3]).toBe(signal);
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each([
    ['cancel', 'connect'], ['ownership', 'connect'], ['cancel', 'negotiate'], ['ownership', 'negotiate'],
  ] as const)('stops supplier selection when %s changes during %s', async (mode, stage) => {
    const controller = new AbortController(), reason = new Error('job retired');
    let current = true;
    const fail = async () => { if (mode === 'cancel') controller.abort(reason); else current = false; throw new Error('peer failed'); };
    const ensure = vi.fn(async () => { if (stage === 'connect') await fail(); });
    const probe = vi.fn(fail);
    const agent = { ensurePeerConnected: ensure, getPeerProtocols: async () => [], router: { probeProtocol: probe } } as unknown as DKGAgent;
    await expect(recoverPublicSnapshotBulk(agent, { contextGraphId: cg, peers: ['first', 'second'], uals: [],
      evidence: {} as PublicSnapshotEvidence, signal: controller.signal,
      assertCurrent: () => { if (!current) throw reason; }, deadline: Date.now() + 1000, dataDir: '/unused',
      shouldQuarantineCommitted: () => false, onCommitted: () => {}, log: () => {},
    })).rejects.toBe(reason);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(stage === 'negotiate' ? 1 : 0);
  });
});
