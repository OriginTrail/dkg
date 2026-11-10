// SPDX-License-Identifier: Apache-2.0
/**
 * The RPC-usage consumer vocabulary as rpc-usage.ts exports it: its version,
 * its exact serialization, and the module's whole export surface. Pinned so
 * that moving where the vocabulary is built changes none of them.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as rpcUsage from '../src/rpc-usage.js';

describe('the RPC-usage consumer vocabulary', () => {
  it('is version 4, serialized byte for byte as it was released', () => {
    expect(rpcUsage.RPC_USAGE_SNAPSHOT_CONSUMER_VOCABULARY_VERSION).toBe(4);
    expect(rpcUsage.RPC_USAGE_SNAPSHOT_CONSUMERS).toHaveLength(218);
    const serialized = JSON.stringify(rpcUsage.RPC_USAGE_SNAPSHOT_CONSUMERS);
    expect(createHash('sha256').update(serialized).digest('hex'))
      .toBe('f743eb5a8f53306d10dd9fb10a0b603b925c74291c2110e058a532eb423492c4');
  });

  it('is exported from rpc-usage.ts with the rest of its runtime surface', () => {
    expect(Object.keys(rpcUsage).sort()).toEqual([
      'KNOWN_RPC_METHODS',
      'RPC_ENDPOINT_SLOT_LABELS',
      'RPC_USAGE_ADAPTER_ROLES',
      'RPC_USAGE_SNAPSHOT_CONSUMERS',
      'RPC_USAGE_SNAPSHOT_CONSUMER_VOCABULARY_VERSION',
      'RpcUsageCumulativeAccumulator',
      'RpcUsageTracker',
      'boundedRpcEndpointSlotLabel',
      'boundedRpcMethodLabel',
      'boundedRpcUsageSnapshotConsumerLabel',
      'captureRpcUsageIssuerContext',
      'createRpcUsageRecorder',
      'emptyRpcUsageWindow',
      'mergeRpcUsageWindows',
      'normalizeRpcEndpointSlotLabel',
      'normalizeRpcUsageAdapterRole',
      'normalizeRpcUsageConsumer',
      'normalizeRpcUsageWindow',
      'rpcUsageWindowTotal',
      'snapshotProcessRpcUsage',
      'withRpcUsageAdapterRole',
      'withRpcUsageConsumer',
      'withRpcUsageIssuerContext',
      'withRpcUsageSite',
    ]);
  });
});
