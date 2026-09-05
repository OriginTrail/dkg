// SPDX-License-Identifier: Apache-2.0

import { createOperationContext, type OperationContext } from
  '@origintrail-official/dkg-core';

import { CHAIN_POLICY_READ_TIMEOUT_MS } from '../../dkg-agent-constants.js';

/** Canonical policy failure shared with registered authority resolution. */
export type LiveOnChainAccessPolicyUnavailable = {
  kind: 'unavailable';
  reason: 'chain-access-policy-timeout' | 'chain-access-policy-unknown';
  detail?: string;
};

/**
 * Preserve the timeout-versus-terminal distinction consumed by authority
 * resolution. Compatibility callers may still project both to `null`.
 */
export type LiveOnChainAccessPolicyState =
  | { kind: 'available'; accessPolicy: 0 | 1 }
  | LiveOnChainAccessPolicyUnavailable;

type BoundedPolicyRead<T> =
  | { kind: 'value'; value: T }
  | { kind: 'timeout' };

export interface LiveOnChainAccessPolicyDependencies {
  isContextGraphActiveOnChain:
    | ((onChainId: bigint, signal?: AbortSignal) => Promise<boolean>)
    | undefined;
  getContextGraphAccessPolicy:
    | ((onChainId: bigint, signal?: AbortSignal) => Promise<unknown>)
    | undefined;
  runBoundedRead<T>(
    start: () => Promise<T>,
    label: string,
    signal?: AbortSignal,
  ): Promise<BoundedPolicyRead<T>>;
  claimMissingLivenessWarning(): boolean;
  warn(ctx: OperationContext, message: string): void;
  cacheAccessPolicy(onChainId: string, accessPolicy: 0 | 1): void;
}

/**
 * Resolve a candidate numeric id only after a fresh on-chain liveness proof.
 * This module owns the fail-closed state model, timeout diagnostics, and cache
 * update policy; callers provide only the chain and runtime capabilities.
 */
export async function resolveLiveOnChainAccessPolicyState(
  dependencies: LiveOnChainAccessPolicyDependencies,
  onChainId: string,
  opCtx?: OperationContext,
  options: { signal?: AbortSignal } = {},
): Promise<LiveOnChainAccessPolicyState> {
  let numericId: bigint;
  try {
    numericId = BigInt(onChainId);
  } catch {
    return { kind: 'unavailable', reason: 'chain-access-policy-unknown' };
  }
  if (numericId <= 0n) return { kind: 'unavailable', reason: 'chain-access-policy-unknown' };

  const readLiveness = dependencies.isContextGraphActiveOnChain;
  if (readLiveness === undefined) {
    if (
      dependencies.getContextGraphAccessPolicy !== undefined
      && dependencies.claimMissingLivenessWarning()
    ) {
      dependencies.warn(
        opCtx ?? createOperationContext('share'),
        'Chain adapter implements getContextGraphAccessPolicy but not ' +
        'isContextGraphActiveOnChain — cannot PROVE on-chain context-graph liveness, so ' +
        'public-on-chain CGs will be kept on the ENCRYPTED SWM path (fail-closed). ' +
        'Implement isContextGraphActiveOnChain to enable public-CG plaintext detection.',
      );
    }
    return { kind: 'unavailable', reason: 'chain-access-policy-unknown' };
  }

  const live = await dependencies.runBoundedRead(
    () => readLiveness(numericId, options.signal),
    `isContextGraphActiveOnChain(${onChainId})`,
    options.signal,
  );
  if (live.kind === 'timeout') {
    const detail =
      `isContextGraphActiveOnChain(${onChainId}) timed out after ` +
      `${CHAIN_POLICY_READ_TIMEOUT_MS}ms`;
    dependencies.warn(
      opCtx ?? createOperationContext('share'),
      `readLiveOnChainAccessPolicy(${onChainId}): ${detail} — ` +
      'treating on-chain access policy as UNKNOWN (fail-closed)',
    );
    return { kind: 'unavailable', reason: 'chain-access-policy-timeout', detail };
  }
  if (live.value !== true) {
    return { kind: 'unavailable', reason: 'chain-access-policy-unknown' };
  }

  // Never trust the cache for a security downgrade. Numeric ids can be reused
  // across chain/deployment epochs, so a fresh policy read must follow the
  // fresh liveness proof. Successful reads still improve other cached users.
  const readAccessPolicy = dependencies.getContextGraphAccessPolicy;
  if (readAccessPolicy === undefined) {
    return { kind: 'unavailable', reason: 'chain-access-policy-unknown' };
  }
  const policy = await dependencies.runBoundedRead(
    () => readAccessPolicy(numericId, options.signal),
    `getContextGraphAccessPolicy(${onChainId})`,
    options.signal,
  );
  if (policy.kind === 'timeout') {
    const detail =
      `getContextGraphAccessPolicy(${onChainId}) timed out after ` +
      `${CHAIN_POLICY_READ_TIMEOUT_MS}ms`;
    dependencies.warn(
      opCtx ?? createOperationContext('share'),
      `readLiveOnChainAccessPolicy(${onChainId}): ${detail} — ` +
      'treating on-chain access policy as UNKNOWN (fail-closed)',
    );
    return { kind: 'unavailable', reason: 'chain-access-policy-timeout', detail };
  }
  if (policy.value === 0 || policy.value === 1) {
    dependencies.cacheAccessPolicy(onChainId, policy.value);
    return { kind: 'available', accessPolicy: policy.value };
  }
  return { kind: 'unavailable', reason: 'chain-access-policy-unknown' };
}
