// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from './dkg-agent-types.js';
import type { ContextGraphSubscriptionRollbackSlotRelease } from './context-graph-subscription-authority-recovery.js';

export type ContextGraphSubscriptionWriteOptions = Readonly<{
  persist?: boolean;
  updateRehydrationStatus?: boolean;
  preserveAdmittedWireBinding?: boolean;
  deferWireAdoption?: boolean;
  rollbackSlotRelease?: ContextGraphSubscriptionRollbackSlotRelease;
  retireNamePlaceholder?: boolean;
}>;

/** Internal data shared by the effects of one synchronous canonical write. */
export type ContextGraphSubscriptionWriteTransition = Readonly<{
  contextGraphId: string;
  source: ContextGraphSub | undefined;
  subscription: ContextGraphSub;
  adoptedWire: Readonly<Pick<ContextGraphSubscriptionRecord, 'id' | 'onChainId' | 'onChainHash' | 'coreHosted'>> | undefined;
  options: ContextGraphSubscriptionWriteOptions;
}>;
