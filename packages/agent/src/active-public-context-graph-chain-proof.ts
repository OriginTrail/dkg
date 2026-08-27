// SPDX-License-Identifier: Apache-2.0

import type { OperationContext } from '@origintrail-official/dkg-core';

export type ActivePublicContextGraphChainProof =
  | { state: 'public' }
  | { state: 'not-public'; reason: 'private' | 'unregistered' }
  | { state: 'unknown'; reason: 'unprovable' | 'rpc-failure'; detail?: string };

export type ActivePublicChainProofSlotBindingMode =
  | 'legacy-policy'
  | 'chain-attested-repair';

export type OnChainAccessPolicyState = 0 | 1 | 'unregistered' | 'unknown';

export type OnChainAccessPolicyStateResolver = (
  contextGraphId: string,
  operationContext: OperationContext,
  options: { slotBindingMode: ActivePublicChainProofSlotBindingMode },
) => Promise<OnChainAccessPolicyState>;

/** Canonical conversion from the agent's policy state to reusable public-chain evidence. */
export async function resolveActivePublicContextGraphChainProof(
  resolveOnChainAccessPolicyState: OnChainAccessPolicyStateResolver,
  contextGraphId: string,
  operationContext: OperationContext,
  slotBindingMode: ActivePublicChainProofSlotBindingMode,
): Promise<ActivePublicContextGraphChainProof> {
  const state = await resolveOnChainAccessPolicyState(
    contextGraphId,
    operationContext,
    { slotBindingMode },
  );
  if (state === 0) return { state: 'public' };
  if (state === 1) return { state: 'not-public', reason: 'private' };
  if (state === 'unregistered') {
    return { state: 'not-public', reason: 'unregistered' };
  }
  return { state: 'unknown', reason: 'unprovable' };
}
