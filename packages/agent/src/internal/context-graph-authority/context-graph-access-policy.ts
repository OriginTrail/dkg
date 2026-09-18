// SPDX-License-Identifier: Apache-2.0

import { createOperationContext, type OperationContext } from
  '@origintrail-official/dkg-core';

import { CHAIN_POLICY_READ_TIMEOUT_MS } from '../../dkg-agent-constants.js';
import {
  ContextGraphLiveAuthorityUnsupportedError,
  type ContextGraphLiveAuthority,
} from '@origintrail-official/dkg-chain';
import type { LiveOnChainAccessPolicyUnavailable } from
  '../../registered-context-graph-authority.js';

export type LiveOnChainAccessPolicyState =
  | {
      kind: 'available';
      accessPolicy: 0 | 1;
      /**
       * Present when the policy came from the one-read live authority: the
       * roster observed in the SAME storage read as liveness and policy, so a
       * caller needing it does not issue a third call that could observe a
       * different block.
       */
      participantAgents?: readonly string[];
    }
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
  /**
   * Optional one-read live authority (liveness, policy, roster from a single
   * `getContextGraph` call). `null` = the chain proved the id nonexistent.
   * Rejects with `ContextGraphLiveAuthorityUnsupportedError` when the deployed
   * contract lacks the getter; any other rejection is transient.
   */
  readLiveAuthority?:
    | ((onChainId: bigint, signal?: AbortSignal) => Promise<ContextGraphLiveAuthority | null>)
    | undefined;
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

  const readLiveAuthority = dependencies.readLiveAuthority;
  if (readLiveAuthority !== undefined) {
    const resolved = await resolveFromLiveAuthority(
      dependencies, readLiveAuthority, numericId, onChainId, opCtx, options,
    );
    if (resolved !== 'unsupported') return resolved;
    // An older deployment without the combined getter: the three-read path below.
  }

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

/**
 * One storage read in place of the liveness + policy pair (and, for private
 * graphs, the roster read the caller would issue next). Every outcome maps to
 * the state the three-read path produces for the same chain fact, so nothing
 * downstream can tell the difference except the number of RPC calls:
 *
 *  - nonexistent id (`null`)  => `chain-access-policy-unknown`, TERMINAL — the
 *    same disposition as a liveness probe returning `false`. Mapping it to a
 *    thrown/`unavailable` outcome would make it RETRYABLE and turn a
 *    permanently-missing graph into an endless promote retry.
 *  - inactive                 => `chain-access-policy-unknown`, checked BEFORE
 *    the policy is looked at: with one tuple nothing structural forces the
 *    liveness-before-policy order the three-read path had, and a deactivated
 *    graph must never read as public.
 *  - active, policy 0|1       => `available`, and only then is the policy
 *    cache written — a deactivated graph must not seed it.
 */
async function resolveFromLiveAuthority(
  dependencies: LiveOnChainAccessPolicyDependencies,
  readLiveAuthority: NonNullable<LiveOnChainAccessPolicyDependencies['readLiveAuthority']>,
  numericId: bigint,
  onChainId: string,
  opCtx: OperationContext | undefined,
  options: { signal?: AbortSignal },
): Promise<LiveOnChainAccessPolicyState | 'unsupported'> {
  let read: BoundedPolicyRead<ContextGraphLiveAuthority | null>;
  try {
    read = await dependencies.runBoundedRead(
      () => readLiveAuthority(numericId, options.signal),
      `getContextGraphLiveAuthority(${onChainId})`,
      options.signal,
    );
  } catch (error) {
    if (
      error instanceof ContextGraphLiveAuthorityUnsupportedError
      || (error instanceof Error && error.name === 'ContextGraphLiveAuthorityUnsupportedError')
    ) {
      return 'unsupported';
    }
    // Transient: propagates exactly as a rejected liveness read does today.
    throw error;
  }
  if (read.kind === 'timeout') {
    const detail =
      `getContextGraphLiveAuthority(${onChainId}) timed out after ` +
      `${CHAIN_POLICY_READ_TIMEOUT_MS}ms`;
    dependencies.warn(
      opCtx ?? createOperationContext('share'),
      `readLiveOnChainAccessPolicy(${onChainId}): ${detail} — ` +
      'treating on-chain access policy as UNKNOWN (fail-closed)',
    );
    return { kind: 'unavailable', reason: 'chain-access-policy-timeout', detail };
  }
  const authority = read.value;
  if (authority === null) return { kind: 'unavailable', reason: 'chain-access-policy-unknown' };
  if (authority.active !== true) return { kind: 'unavailable', reason: 'chain-access-policy-unknown' };
  const policy = authority.accessPolicy;
  if (policy === 0 || policy === 1) {
    dependencies.cacheAccessPolicy(onChainId, policy);
    return {
      kind: 'available',
      accessPolicy: policy,
      // Passed through untouched: the resolver owns roster validation, and a
      // malformed roster must stay the TERMINAL `chain-participant-authority-
      // invalid` it always was — spreading it here would throw and resurface
      // as a retryable policy failure instead.
      participantAgents: authority.participantAgents,
    };
  }
  return { kind: 'unavailable', reason: 'chain-access-policy-unknown' };
}
