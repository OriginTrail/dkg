import { vi } from 'vitest';
import { ethers } from 'ethers';
import { sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { preparePublicSnapshotCheckpoint } from '../../src/public-snapshot-checkpoint.js';
import type { PublicSnapshotMode, PublicSnapshotObservation } from '../../src/public-snapshot-evidence.js';
import { fixture, cg, address } from './bulk-graph-fixture.js';

export async function checkpointFixture(options: Parameters<typeof fixture>[3] = {}, mode: PublicSnapshotMode = 'core-cache', count = 3) {
  const f = await fixture(count, -1, false, options);
  const now = Date.now();
  const snapshot = sealPublicGraphSnapshot({ version: 1, chainId: 'base:84532', deploymentId: 'fixture',
    contextGraphId: cg, onChainId: '14', nameHash: ethers.id(cg),
    contextGraphStorage: `0x${'2'.repeat(40)}`, assetStorage: address,
    blockNumber: '10', blockHash: `0x${'3'.repeat(64)}`, finalityConfirmations: 1,
    observedAt: now, expiresAt: now + 120_000, accessPolicy: 0,
    assets: [...f.byId].map(([id, root]) => ({ id: String(id), root: `0x${Buffer.from(root).toString('hex')}`, version: '1' })),
  });
  const initial: PublicSnapshotObservation = mode === 'core-cache'
    ? { mode, snapshot, sourceCore: f.supplierPeer } : { mode, snapshot, sourceCore: null };
  const abort = new AbortController();
  const readFresh = vi.fn(async () => initial);
  const run = (dataDir = f.directory) => preparePublicSnapshotCheckpoint({ router: f.router, ensurePeerConnected: async () => {} }, {
    initial, readFresh, peerBatches: async function* () { yield [f.supplierPeer]; }, dataDir,
    signal: abort.signal, assertCurrent: () => abort.signal.throwIfAborted(), deadline: Date.now() + 30_000,
  });
  return { ...f, run, readFresh, initial, abort };
}

