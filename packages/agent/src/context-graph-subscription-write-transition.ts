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
type WireSource = Readonly<{ localId: string; subscription: ContextGraphSub }>;

/** A projected write and the exact source identities it is allowed to replace. */
export type ContextGraphSubscriptionWriteTransition = Readonly<{
  contextGraphId: string;
  source: ContextGraphSub | undefined;
  wireSource: WireSource | undefined;
  subscription: ContextGraphSub;
  adoptedWire: Readonly<Pick<ContextGraphSubscriptionRecord, 'id' | 'onChainId' | 'onChainHash' | 'coreHosted'>> | undefined;
  localWireId: string;
  previousWireId: string;
  nextWireId: string;
  options: ContextGraphSubscriptionWriteOptions;
}>;

// Weak ownership keeps unapplied records collectible and prevents cross-agent or repeated application.
const pending = new WeakMap<ContextGraphSubscriptionWriteTransition, ReadonlyMap<string, ContextGraphSub>>();
export function prepareSubscriptionWriteTransition(
  subscriptions: ReadonlyMap<string, ContextGraphSub>, input: ContextGraphSubscriptionWriteTransition,
): ContextGraphSubscriptionWriteTransition {
  const transition = Object.freeze({ ...input, options: Object.freeze({ ...input.options }),
    wireSource: input.wireSource && Object.freeze({ ...input.wireSource }),
    adoptedWire: input.adoptedWire && Object.freeze({ ...input.adoptedWire }) });
  pending.set(transition, subscriptions);
  return transition;
}

/** Consume once, before any custody retirement, runtime effect or persistence. */
export function consumeSubscriptionWriteTransition(
  transition: ContextGraphSubscriptionWriteTransition, subscriptions: ReadonlyMap<string, ContextGraphSub>, wire: WireSource | null,
): void {
  if (pending.get(transition) !== subscriptions
    || subscriptions.get(transition.contextGraphId) !== transition.source
    || wire?.localId !== transition.wireSource?.localId
    || wire?.subscription !== transition.wireSource?.subscription) {
    throw new Error('Subscription transition changed before apply');
  }
  pending.delete(transition);
}
