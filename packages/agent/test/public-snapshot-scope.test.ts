import { expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { normalizePublicGraphSnapshot, sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { PublicGraphSnapshotMethods } from '../../chain/src/evm-adapter-public-graph-snapshot.js';
import { normalizePublicSnapshotSyncOptions } from '../src/public-snapshot-options.js';
import { decodePublicGraphSnapshotRequest, encodePublicGraphSnapshotRequest } from '../src/public-snapshot-wire.js';

const max = ((1n << 256n) - 1n).toString();
it.each([
  ['team/graph', '1', true], ['test', max, true], ['test', '0', false], ['test', '01', false],
  ['test', (1n << 256n).toString(), false], ['test', '9'.repeat(1000), false],
  ['../bad', '1', false], ['', '1', false], ['test', '-1', false],
] as const)('agrees across snapshot scope boundaries: %s / %s', async (contextGraphId, onChainId, valid) => {
  const scope = { contextGraphId, onChainId };
  const request = { version: 1 as const, ...scope, refresh: false };
  const snapshot = sealPublicGraphSnapshot({ version: 1, ...scope, chainId: 'evm:31337', deploymentId: 'test',
    nameHash: ethers.id(contextGraphId), contextGraphStorage: `0x${'1'.repeat(40)}`, assetStorage: `0x${'2'.repeat(40)}`,
    blockNumber: '1', blockHash: `0x${'a'.repeat(64)}`, finalityConfirmations: 1, observedAt: 1000,
    expiresAt: 121000, accessPolicy: 0, assets: [] });
  const boundaries = [
    () => normalizePublicSnapshotSyncOptions({ ...scope, trustedCorePeerIds: ['core'] }),
    () => encodePublicGraphSnapshotRequest(request),
    () => decodePublicGraphSnapshotRequest(new TextEncoder().encode(JSON.stringify(request))),
    () => normalizePublicGraphSnapshot(snapshot, { ...scope, chainId: 'evm:31337', deploymentId: 'test', now: 2000 }),
  ];
  for (const boundary of boundaries) {
    if (valid) expect(boundary).not.toThrow(); else expect(boundary).toThrow();
  }
  // Stop immediately after admission: this fixture performs no chain calls.
  const init = vi.fn(async () => { throw new Error('scope admitted'); });
  await expect(PublicGraphSnapshotMethods.prototype.readPublicGraphSnapshot.call({ init } as never, contextGraphId, onChainId))
    .rejects.toThrow(valid ? 'scope admitted' : 'Invalid snapshot scope');
  expect(init).toHaveBeenCalledTimes(valid ? 1 : 0);
});
