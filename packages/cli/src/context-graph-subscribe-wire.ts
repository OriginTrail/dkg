import type { ContextGraphSyncMode } from '@origintrail-official/dkg-agent';
import type { CatchupJobResult } from './catchup-result-wire.js';

/** Stable response returned by both Context Graph subscription client methods. */
export interface ContextGraphSubscribeResponse {
  subscribed: string;
  syncMode: ContextGraphSyncMode;
  catchup?: CatchupJobResult | {
    status: 'queued';
    includeSharedMemory: boolean;
    /** @deprecated Backward-compatible response alias for includeSharedMemory. */
    includeWorkspace: boolean;
    jobId: string;
  };
}
