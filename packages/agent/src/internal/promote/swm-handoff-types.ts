import type { ConfirmedVmIdentityAndTimingV1 } from '../confirmed-catalog-handoff-types.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
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

/** Promotion transfer retains the original workspace policy admission fence. */
export interface TransferRfc64ConfirmedVmParamsV1 extends ConfirmedVmIdentityAndTimingV1 {
  readonly expectedWorkspaceAccessPolicy?: PromoteRecoveryBinding['intent']['accessPolicy'];
}
