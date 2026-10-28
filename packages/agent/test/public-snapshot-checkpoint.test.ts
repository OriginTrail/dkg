import { describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { PUBLIC_CHECKPOINT_PROTOCOL } from '@origintrail-official/dkg-core';
import { preparePublicSnapshotCheckpoint } from '../src/public-snapshot-checkpoint.js';
import { snapshotVerificationWidth } from '../src/snapshot-verification-pool.js';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { fixture, cg, address } from './helpers/bulk-graph-fixture.js';

async function setup(options: Parameters<typeof fixture>[3] = {}) {
  const f = await fixture(3, -1, false, options);
  const now = Date.now();
  const snapshot = sealPublicGraphSnapshot({ version: 1, chainId: 'base:84532', deploymentId: 'fixture',
    contextGraphId: cg, onChainId: '14', nameHash: `0x${'1'.repeat(64)}`,
    contextGraphStorage: `0x${'2'.repeat(40)}`, assetStorage: address,
    blockNumber: '10', blockHash: `0x${'3'.repeat(64)}`, finalityConfirmations: 1,
    observedAt: now, expiresAt: now + 120_000, accessPolicy: 0,
    assets: [...f.byId].map(([id, root]) => ({ id: String(id), root: `0x${Buffer.from(root).toString('hex')}`, version: '1' })),
  });
  const initial = { mode: 'core-cache' as const, snapshot, sourceCore: f.supplierPeer };
  const abort = new AbortController();
  const readFresh = vi.fn(async () => initial);
  const run = () => preparePublicSnapshotCheckpoint({ router: f.router, ensurePeerConnected: async () => {} }, {
    initial, readFresh, peerBatches: async function* () { yield [f.supplierPeer]; }, dataDir: f.directory,
    signal: abort.signal, assertCurrent: () => abort.signal.throwIfAborted(), deadline: Date.now() + 30_000,
  });
  return { ...f, run, readFresh, initial, abort };
}

describe('isolated public checkpoint', () => {
  it('negotiates the new protocol, verifies every asset, persists trust, and never writes live coverage', async () => {
    const f = await setup({ payloadBytes: [14, 4000, 14] });
    const probe = vi.spyOn(f.router, 'probeProtocol');
    const result = await f.run();
    expect(result).toMatchObject({ committed: 0, current: false });
    expect(result.manifest.assets.map(a => a.ual)).toEqual(f.uals);
    expect(result.manifest.assets.every(a => a.publicQuads > 0)).toBe(true);
    expect(probe.mock.calls[0]?.[1]).toBe(PUBLIC_CHECKPOINT_PROTOCOL);
    expect(await f.target.countQuads()).toBe(0);
    expect(await readFile(join(result.directory, 'load/trust.nq'), 'utf8')).toContain('chainEvidenceMode');
    expect(JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8')).state).toBe('verified-unpublished');
  });
  it.each(['asset digest', 'expanded size', 'inventory change', 'abort'] as const)('never seals a failed %s', async failure => {
    const f = await setup(failure === 'asset digest' ? { tamperDigest: 'asset' }
      : failure === 'expanded size' ? { expandedLengthMismatch: true } : {});
    if (failure === 'inventory change') f.readFresh.mockImplementation(async () => ({ ...f.initial,
      snapshot: { ...f.initial.snapshot, inventoryDigest: '0'.repeat(64) } }));
    if (failure === 'abort') f.readFresh.mockImplementation(async () => { f.abort.abort(new Error('retired')); return f.initial; });
    await expect(f.run()).rejects.toThrow();
    const attempts = await readdir(join(f.directory, 'public-snapshot-checkpoints'));
    expect(attempts).toHaveLength(1);
    expect(await readdir(join(f.directory, 'public-snapshot-checkpoints', attempts[0]!))).not.toContain('manifest.json');
    expect(await f.target.countQuads()).toBe(0);
  });
  it('does not send checkpoint traffic to an older core', async () => {
    const f = await setup();
    vi.spyOn(f.router, 'probeProtocol').mockResolvedValue('unsupported');
    const exchange = vi.spyOn(f.router, 'withDuplexStream');
    await expect(f.run()).rejects.toThrow('incremental recovery');
    expect(exchange).not.toHaveBeenCalled();
  });
  it('bounds verifier width and rejects work after termination instead of hanging', async () => {
    expect(snapshotVerificationWidth({ cpus: 64, freeBytes: 64 * 2 ** 30 })).toBe(4);
    expect(snapshotVerificationWidth({ cpus: 1, freeBytes: 64 * 2 ** 30 })).toBe(1);
    expect(snapshotVerificationWidth({ cpus: 8, freeBytes: 2 * 2 ** 30 })).toBe(2);
    const worker = new SyncVerifyWorker();
    const pending = worker.parseAndFilter('<urn:a> <urn:b> <urn:c> <urn:g> .', 'urn:g', cg);
    const rejected = expect(pending).rejects.toThrow('closed');
    await worker.close(); await rejected;
    await expect(worker.verify([], [], false)).rejects.toThrow('closed');
    await expect(worker.processDurableBatch([], [], false)).rejects.toThrow('closed');
    await worker.close();
  });
});
