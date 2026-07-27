import type { OperationContext } from '@origintrail-official/dkg-core';

import type { DKGAgent } from '../../src/index.js';
import type { SyncPhase } from '../../src/sync/auth/request-build.js';
import type { SyncPageResult } from '../../src/sync/requester/page-fetch.js';

export interface LifecycleFetchCall {
  ctx: OperationContext;
  remotePeerId: string;
  contextGraphId: string;
  includeSharedMemory: boolean;
  phase: SyncPhase;
  graphUri: string;
  deadline: number;
  snapshotRef?: string;
  sinceBatchId?: string;
  signal?: AbortSignal;
  recovery?: boolean;
  forceFreshSession?: boolean;
  assetUals?: string[];
}

export function stubLifecycleFetch(
  agent: DKGAgent,
  handler: (call: LifecycleFetchCall) => Promise<SyncPageResult>,
): void {
  (agent as any).fetchSyncPages = (
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: SyncPhase,
    graphUri: string,
    deadline: number,
    snapshotRef?: string,
    sinceBatchId?: string,
    signal?: AbortSignal,
    recovery?: boolean,
    forceFreshSession?: boolean,
    assetUals?: string[],
  ) => handler({
    ctx,
    remotePeerId,
    contextGraphId,
    includeSharedMemory,
    phase,
    graphUri,
    deadline,
    snapshotRef,
    sinceBatchId,
    signal,
    recovery,
    forceFreshSession,
    assetUals,
  });
}
