// SPDX-License-Identifier: Apache-2.0
import type { ViewQuerySemantics } from '@origintrail-official/dkg-core';

/** Options forwarded by the CLI client to the daemon query endpoint. */
export interface QueryOptions {
  graphSuffix?: string;
  includeSharedMemory?: boolean;
  includeContextGraphPartitions?: boolean;
  includeSharedMemoryMeta?: boolean;
  view?: 'working-memory' | 'shared-working-memory' | 'verifiable-memory';
  /** How a view query matches its patterns; the node's default when absent. */
  semantics?: ViewQuerySemantics;
  agentAddress?: string;
  assertionName?: string;
  subGraphName?: string;
  verifiedGraph?: string;
  minTrust?:
    | 'SelfAttested'
    | 'Endorsed'
    | 'PartiallyVerified'
    | 'ConsensusVerified'
    | 0
    | 1
    | 2
    | 3;
}
