// SPDX-License-Identifier: Apache-2.0

import type { OperationContext } from '@origintrail-official/dkg-core';

export type ActivePublicContextGraphChainProof =
  | { state: 'public' }
  | { state: 'not-public'; reason: 'private' | 'unregistered' }
  | { state: 'unknown'; reason: 'unprovable' | 'rpc-failure'; detail?: string };

export type OnChainAccessPolicyState = 0 | 1 | 'unregistered' | 'unknown';

export type OnChainAccessPolicyStateResolver = (
  contextGraphId: string,
  operationContext: OperationContext,
  options: { slotBindingMode: 'chain-attested-repair' },
) => Promise<OnChainAccessPolicyState>;

export type OperationAwareActivePublicChainProofResolver = (
  contextGraphId: string,
  operationContext: OperationContext,
) => Promise<ActivePublicContextGraphChainProof>;

export type BoundActivePublicChainProofResolver = (
  operationContext: OperationContext,
) => Promise<ActivePublicContextGraphChainProof>;

/** Strict proof boundary: owns binding policy, RPC classification, and state conversion. */
export async function resolveActivePublicContextGraphChainProof(
  resolveOnChainAccessPolicyState: OnChainAccessPolicyStateResolver,
  contextGraphId: string,
  operationContext: OperationContext,
): Promise<ActivePublicContextGraphChainProof> {
  let state: OnChainAccessPolicyState;
  try {
    state = await resolveOnChainAccessPolicyState(
      contextGraphId,
      operationContext,
      { slotBindingMode: 'chain-attested-repair' },
    );
  } catch (error) {
    return {
      state: 'unknown',
      reason: 'rpc-failure',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (state === 0) return { state: 'public' };
  if (state === 1) return { state: 'not-public', reason: 'private' };
  if (state === 'unregistered') {
    return { state: 'not-public', reason: 'unregistered' };
  }
  return { state: 'unknown', reason: 'unprovable' };
}

/** Bind one lazy proof promise to one normalized graph for repair + confirmation reuse. */
export function memoizeActivePublicContextGraphChainProof(
  contextGraphId: string,
  resolveProof: OperationAwareActivePublicChainProofResolver,
): BoundActivePublicChainProofResolver {
  let proof: Promise<ActivePublicContextGraphChainProof> | undefined;
  return (operationContext) => {
    proof ??= resolveProof(contextGraphId, operationContext);
    return proof;
  };
}
