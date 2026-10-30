// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
  CurrentFinalizedEvmCallErrorV1,
  createStrictCurrentFinalizedEvmSnapshotScopeV1,
  isFinalizedChainAdmissionContention,
  isTransientRpcTransportFailureWithoutTransaction,
  numericChainIdOf,
  resolveRpcUrls,
} from '@origintrail-official/dkg-chain';
import {
  assertCanonicalChainId, assertCanonicalEvmAddress,
} from '@origintrail-official/dkg-core';
import { isStoreOperationTimeoutError, isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import type { DKGAgent } from './dkg-agent.js';
import { finalizedContextGraphSnapshotMismatchV1 } from './internal/context-graph-authority/finalized-context-graph-binding.js';
import { isRfc64AuthorityRpcCircuitOpenErrorV1 } from './rfc64/authority-rpc-circuit-breaker-v1.js';
import { proveRegisteredPrivateEmptyVmV1 } from './rfc64/registered-private-empty-vm-proof-v1.js';

/**
 * An attempt that proved nothing grants nothing, and says only when it is worth
 * making again. The proof below still needs every condition on every attempt.
 *
 * - `retryable`: the cause passes in moments; the caller may ask again within
 *   its own deadline.
 * - `final`: nothing a later attempt can see changes the answer.
 * - neither: not soon, but a later attempt may answer differently.
 *
 * `stage` says where the attempt ended, for the settlement's log line.
 */
export type RegisteredPrivateEmptyVmAttemptV1 =
  | {
      readonly proven: false;
      readonly retryable?: boolean;
      readonly final?: boolean;
      readonly stage?: string;
    }
  | { readonly proven: true; readonly metadataRevision: string; readonly onChainId: bigint };

export const UNPROVEN_PRIVATE_EMPTY_VM = { proven: false } as const;
export const RETRYABLE_PRIVATE_EMPTY_VM = { proven: false, retryable: true } as const;

const unproven = (stage: string, disposition?: 'retryable' | 'final'): RegisteredPrivateEmptyVmAttemptV1 => {
  tracePrivateEmptyVm(stage);
  return { proven: false, stage, ...(disposition === undefined ? {} : { [disposition]: true }) };
};

/** Finalized-read failures that say the endpoints could not answer, not what the chain holds. */
const TRANSIENT_FINALIZED_READ_CODES = new Set<CurrentFinalizedEvmCallErrorV1['code']>([
  'finalized-state-unavailable', 'rpc-unavailable', 'rpc-timeout',
]);

/**
 * A failure that says nothing about the graph: the store was busy, the node's
 * own request budget or admission refused the read, every endpoint failed, or the
 * attempt's own timeout passed. Callers wrap these, so the chain of causes is
 * walked. An `Error` with a matching code alone is not enough for the finalized
 * lane's contention, which only its own module can recognize.
 */
function isTransientAttemptFailure(error: unknown): boolean {
  if (isFinalizedChainAdmissionContention(error)) return true;
  for (let cause = error, depth = 0; cause !== undefined && cause !== null && depth < 8; depth += 1) {
    if (
      isStoreSchedulerBusyError(cause)
      || isStoreOperationTimeoutError(cause)
      || isTransientRpcTransportFailureWithoutTransaction(cause)
      || isRfc64AuthorityRpcCircuitOpenErrorV1(cause)
      || (cause instanceof CurrentFinalizedEvmCallErrorV1 && TRANSIENT_FINALIZED_READ_CODES.has(cause.code))
      || (cause as { name?: unknown }).name === 'TimeoutError'
    ) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/** Read only the agent's protected bindings through its owning mixin method. */
export interface PrivateEmptyVmAgentBindingsV1 {
  isSubscribed(): boolean;
  /** This node holds the curator's approval of the caller, by its own record. */
  holdsLocalApproval(): boolean;
  readMetadataRevision(): string;
  readChainConfig(): {
    rpcUrl?: string;
    rpcUrls?: string[];
    chainId?: string;
    hubAddress: string;
  } | undefined;
  hasAuthorityReader(): boolean;
  readAdapterEvmChainId(): Promise<bigint>;
  readResolvedFinalityConfirmations(): number | undefined;
}

export function tracePrivateEmptyVm(stage: string): void {
  if (process.env.DKG_DEBUG_PRIVATE_EMPTY_VM === '1') {
    console.info(`[private-empty-vm] ${stage}`);
  }
}

/** Collect optional finalized evidence. It never grants readiness by itself. */
export async function attemptRegisteredPrivateEmptyVmV1(
  agent: DKGAgent,
  bindings: PrivateEmptyVmAgentBindingsV1,
  contextGraphId: string,
  callerAgentAddress: string,
  signal?: AbortSignal,
): Promise<RegisteredPrivateEmptyVmAttemptV1> {
  try {
    if (signal?.aborted) return UNPROVEN_PRIVATE_EMPTY_VM;
    const caller = callerAgentAddress.toLowerCase();
    if (!ethers.isAddress(caller) || !bindings.isSubscribed()) return unproven('not-subscribed', 'final');
    const metadataRevision = bindings.readMetadataRevision();
    const confirmedBefore = await agent.hasConfirmedMetaState(contextGraphId, { signal }).catch(() => false);
    if (!confirmedBefore) return unproven('metadata-not-yet-confirmed', 'retryable');
    const privateBefore = await agent.isPrivateContextGraph(contextGraphId).catch(() => undefined);
    if (privateBefore === undefined) return unproven('private-policy-unavailable', 'retryable');
    if (!privateBefore) return unproven('not-private', 'final');
    if (bindings.readMetadataRevision() !== metadataRevision) {
      return unproven('metadata-not-stable-before-proof', 'retryable');
    }
    const before = await agent.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
      callerAgentAddress: caller, allowSubscriptionFallback: false, signal,
    });
    if (before.outcome === 'unavailable') return unproven('authority-unavailable-before-proof', 'retryable');
    if (before.outcome !== 'allowed' || before.source !== 'registered-chain'
      || before.onChainId === undefined || before.registration === 'unregistered') {
      // Without the curator's approval this answer is the caller's. With it, the
      // approval can have reached this node before the chain's roster reached its
      // index, and only asking again tells the two apart. A graph that is not
      // registered may stay so, so that answer waits for the later attempts.
      if (!bindings.holdsLocalApproval()) return unproven('authority-not-registered-allowed', 'final');
      return unproven('authority-not-registered-allowed', before.registration === 'unregistered' ? undefined : 'retryable');
    }
    const chainConfig = bindings.readChainConfig();
    if (chainConfig === undefined || !bindings.hasAuthorityReader()) {
      return unproven('chain-capability-absent', 'final');
    }
    const endpoints = resolveRpcUrls(chainConfig.rpcUrl ?? '', chainConfig.rpcUrls);
    if (endpoints.length === 0) return unproven('rpc-endpoints-absent', 'final');
    // The adapter's own reading of a configured chain: a decimal id behind any
    // namespace. The network files name theirs `base:8453`, `gnosis:100`, and
    // so on; only a local chain is `evm:31337`.
    const configuredChainId = numericChainIdOf(chainConfig.chainId);
    if ((chainConfig.chainId !== undefined && configuredChainId === undefined)
      || !ethers.isAddress(chainConfig.hubAddress)) {
      return unproven('chain-binding-absent', 'final');
    }
    const adapterChainId = await bindings.readAdapterEvmChainId();
    if (configuredChainId !== undefined && configuredChainId !== adapterChainId) {
      return unproven('chain-binding-mismatch', 'final');
    }
    const chainId = adapterChainId.toString();
    // Normalize external bindings once. The registry supplies the graph name;
    // it is not restricted to the RFC-64 author-lane grammar.
    const hubAddress = chainConfig.hubAddress.toLowerCase();
    assertCanonicalChainId(chainId);
    assertCanonicalEvmAddress(caller);
    assertCanonicalEvmAddress(hubAddress);
    const indexAbsent = () => unproven(
      'indexed-private-authority-absent', bindings.holdsLocalApproval() ? 'retryable' : undefined,
    );
    const registered = await agent.readRfc64RegisteredAuthoritySnapshotV1(contextGraphId, signal);
    if (registered === null || registered.expectedOnChainId !== before.onChainId) return indexAbsent();
    const indexed = registered.snapshot;
    if (indexed.chainId !== chainId
      || indexed.accessPolicy !== 1
      || finalizedContextGraphSnapshotMismatchV1(indexed, {
        onChainId: registered.expectedOnChainId,
        nameHash: registered.expectedNameHash,
      }) !== undefined) {
      return indexAbsent();
    }
    const depth = bindings.readResolvedFinalityConfirmations();
    const proof = await proveRegisteredPrivateEmptyVmV1({
      contextGraphId,
      onChainContextGraphId: indexed.contextGraphId,
      callerAgentAddress: caller,
      chainId,
      hubAddress,
      governanceContractAddress: indexed.governanceContract,
      snapshot: createStrictCurrentFinalizedEvmSnapshotScopeV1({
        chainId, endpoints,
        ...(depth === undefined ? {} : { finalityConfirmations: depth }),
        owner: 'rfc64',
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    });
    if (proof === 'not-empty') return unproven('finalized-not-empty', 'final');
    if (proof !== 'proven') return unproven('finalized-zero-proof-false');
    return { proven: true, metadataRevision, onChainId: before.onChainId };
  } catch (error) {
    const stage = `proof-error:${error instanceof Error ? error.name : 'unknown'}`;
    return unproven(stage, !signal?.aborted && isTransientAttemptFailure(error) ? 'retryable' : undefined);
  }
}
