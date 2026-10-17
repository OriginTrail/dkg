import type { AssertionSeal, OperationContext } from '@origintrail-official/dkg-core';
import type { PromoteRecoveryBinding } from '@origintrail-official/dkg-publisher';
import type { RecordRfc64SwmAuthorInventoryShadowParamsV1 } from '../../dkg-agent-rfc64-catalog-auto-publish.js';
import type { RemoveRfc64SwmAuthorInventoryResultV1 } from '../../rfc64/swm-author-inventory-producer-v1.js';

export interface ObserveRfc64DurableSwmPromotionParamsV1
  extends RecordRfc64SwmAuthorInventoryShadowParamsV1 {
  readonly ctx: OperationContext;
}

export interface BoundDurableSwmPromotionParamsV1
  extends Omit<ObserveRfc64DurableSwmPromotionParamsV1, 'shareOperationId'> {
  readonly recoveryBinding: PromoteRecoveryBinding;
}

export type AfterDurableSwmPromotionParamsV1 = BoundDurableSwmPromotionParamsV1
  | (Omit<ObserveRfc64DurableSwmPromotionParamsV1, 'shareOperationId'> & {
    readonly recoveryBinding?: undefined;
    readonly shareOperationId: string | null;
  });

export type ConfirmedInventoryRemovalOutcomeV1 = RemoveRfc64SwmAuthorInventoryResultV1
  | Readonly<{ status: 'inactive' }>;

export interface ObserveRfc64ConfirmedVmParamsV1 {
  readonly contextGraphId: string;
  readonly subGraphName?: string | null;
  readonly assertionCoordinate: string;
  readonly shareOperationId?: string;
  readonly seal: AssertionSeal;
  readonly assertionUri: string;
  readonly ctx: OperationContext;
  readonly publicationLabel: 'publish' | 'queued publish';
  /** The original workspace policy required by a bound share's admission. */
  readonly expectedWorkspaceAccessPolicy?: PromoteRecoveryBinding['intent']['accessPolicy'];
}
