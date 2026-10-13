// SPDX-License-Identifier: Apache-2.0
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { SyncRequestEnvelope } from '../auth/request-build.js';
import type { ExactAssetExportCache, ExactAssetExportFallbackReason, ExactAssetExportStage } from './exact-asset-export-cache.js';
import type { SyncRowSnapshotBudgetError } from './snapshot-budget.js';
import type { ExperimentalExactBatchResponderResources } from './sync-handler.js';

export interface PublicAssetResponderOptions {
  /** Shared existing responder budget/cache, not a second unaccounted cache. */
  readonly exportCache: ExactAssetExportCache;
  readonly admission: Pick<ExperimentalExactBatchResponderResources, 'withPreAuthorizationAdmission' | 'withAuthorizedResponseAdmission'>;
  readonly authorizeSyncRequest: (request: SyncRequestEnvelope, peerId: string, options: { signal?: AbortSignal }) => Promise<boolean>;
  /** Positive normal CG policy read: the experimental pilot serves public CGs only. */
  readonly isPublicContextGraph: (contextGraphId: string, signal: AbortSignal) => Promise<boolean>;
  readonly servingWithheld?: (contextGraphId: string) => boolean;
  readonly onStage?: (stage: 'metadata' | 'export' | 'encode' | 'send' | 'source-fence' | 'ack-wait' | ExactAssetExportStage, assetIndex: number, durationMs: number, context: OperationContext) => void;
  /** Successful cache lease export count, never a peer/body authority claim. */
  readonly onExport?: (assetIndex: number, wholePayloadExports: 0 | 1, context: OperationContext) => void;
  readonly onPayload?: (assetIndex: number, plainBytes: number, encodedBytes: number, context: OperationContext) => void;
  /** Local closed reason bound to the request's operation and canonical asset index. */
  readonly onFallback?: (reason: ExactAssetExportFallbackReason, assetIndex: number, context: OperationContext, budgetReason?: SyncRowSnapshotBudgetError['reason']) => unknown;
}
