// SPDX-License-Identifier: Apache-2.0
import { decodePublicGraphSnapshotResponse, normalizePublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { PublicSnapshotMode, PublicSnapshotObservation } from './public-snapshot-evidence.js';

export class PublicSnapshotUnavailableError extends Error {}

export const PUBLIC_GRAPH_SNAPSHOT_PROTOCOL = '/dkg/10.0.0/public-graph-snapshot/1';
import type { SnapshotRequest } from './public-snapshot-policy.js';
export function createPublicSnapshotReader(options: {
  mode: PublicSnapshotMode;
  chain: Pick<ChainAdapter, 'readPublicGraphSnapshot'>; request: SnapshotRequest;
  peers: readonly string[]; signal: AbortSignal; assertCurrent(): void;
  expected: Parameters<typeof decodePublicGraphSnapshotResponse>[1];
}): (refresh?: boolean) => Promise<PublicSnapshotObservation> {
  const {chain,request,signal,expected,assertCurrent}=options;
  if (options.mode === 'rpc-only') return async () => {
    assertCurrent();
    if (!chain.readPublicGraphSnapshot) throw new Error('Independent snapshots are unsupported by this chain adapter');
    const raw=await chain.readPublicGraphSnapshot(expected.contextGraphId,expected.onChainId,{signal});
    const snapshot=normalizePublicGraphSnapshot(raw,expected);
    assertCurrent();
    return {mode:'rpc-only',snapshot,sourceCore:null};
  };
  return async (refresh=false) => {
    let failure: unknown;
    let unavailable = false;
    for (const peer of options.peers) {
      assertCurrent();
      try {
        const bytes = await request(peer, refresh, signal);
        const response = decodePublicGraphSnapshotResponse(bytes, expected);
        if (response.kind === 'unavailable') {
          unavailable = true;
          throw new PublicSnapshotUnavailableError('Snapshot temporarily unavailable');
        }
        const { snapshot } = response;
        assertCurrent();
        return {mode:'core-cache',snapshot,sourceCore:peer};
      } catch(error) { failure=error; signal.throwIfAborted(); }
    }
    const Failure = unavailable ? PublicSnapshotUnavailableError : Error;
    throw new Failure('No configured core supplied a valid public snapshot',{cause:failure});
  };
}
