import type { OperationContext } from '@origintrail-official/dkg-core';

import type { DKGAgent } from '../../src/index.js';
import type { SyncPhase } from '../../src/sync/auth/request-build.js';
import type {
  SyncPageFetchOptions,
  SyncPageResult,
} from '../../src/sync/requester/page-fetch.js';

export interface LifecycleFetchCall extends SyncPageFetchOptions {
  ctx: OperationContext;
  remotePeerId: string;
  contextGraphId: string;
  includeSharedMemory: boolean;
  phase: SyncPhase;
  graphUri: string;
  deadline: number;
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
    options: SyncPageFetchOptions = {},
  ) => handler({
    ctx,
    remotePeerId,
    contextGraphId,
    includeSharedMemory,
    phase,
    graphUri,
    deadline,
    ...options,
  });
}
