// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphAuthorityIndexRevisionReader, ContextGraphAuthorityReadOptions } from '@origintrail-official/dkg-chain';
import { Rfc64AuthorityRpcCircuitOpenErrorV1, type Rfc64AuthorityReadCoordinatorSnapshotV1 } from '../../rfc64/authority-rpc-circuit-breaker-v1.js';

/** A cooldown read cannot escalate an absent or unsupported cache into RPC. */
export function retainedAuthoritySnapshotReaderV1(
  reader: ContextGraphAuthorityIndexRevisionReader,
  circuit: Rfc64AuthorityReadCoordinatorSnapshotV1,
): NonNullable<ContextGraphAuthorityIndexRevisionReader['resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes']> {
  return async (nameHashes: readonly string[], options?: ContextGraphAuthorityReadOptions) => {
    const retained = await reader.peekFinalizedContextGraphAuthoritySnapshotsByNameHashes?.(nameHashes, options);
    options?.signal?.throwIfAborted();
    if (retained !== undefined) return retained;
    const retryAtMs = circuit.retryAtMs ?? Date.now();
    throw new Rfc64AuthorityRpcCircuitOpenErrorV1(retryAtMs, Math.max(0, retryAtMs - Date.now()));
  };
}
