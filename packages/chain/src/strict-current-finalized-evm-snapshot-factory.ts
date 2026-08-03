import type { StrictCurrentFinalizedEvmSnapshotScopeV1 } from './current-finalized-evm-snapshot.js';
import type { StrictFinalizedSnapshotRpcConfigV1 } from './strict-current-finalized-evm-types.js';
import { snapshotStrictFinalizedSnapshotConfigV1 } from './strict-current-finalized-evm-config.js';
import { createStrictFinalizedSnapshotRpcRuntimeV1 } from './strict-current-finalized-evm-snapshot-rpc.js';

/**
 * Build a scoped dynamic-read capability pinned to one endpoint and one
 * finalized anchor. Endpoint failover is allowed only during preflight; once
 * the callback begins it is never replayed on another endpoint.
 */
export function createStrictCurrentFinalizedEvmSnapshotScopeV1(
  input: StrictFinalizedSnapshotRpcConfigV1,
): StrictCurrentFinalizedEvmSnapshotScopeV1 {
  return createStrictFinalizedSnapshotRpcRuntimeV1(
    snapshotStrictFinalizedSnapshotConfigV1(input),
  );
}
