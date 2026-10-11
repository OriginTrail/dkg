// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
  createStrictCurrentFinalizedEvmSnapshotScopeV1,
  isFinalizedChainAdmissionContention,
  numericChainIdOf,
  resolveRpcUrls,
} from '@origintrail-official/dkg-chain';
import {
  assertCanonicalChainId, assertCanonicalEvmAddress,
} from '@origintrail-official/dkg-core';
import type { DKGAgent } from './dkg-agent.js';
import { finalizedContextGraphSnapshotMismatchV1 } from './internal/context-graph-authority/finalized-context-graph-binding.js';
import { proveRegisteredPrivateEmptyVmV1 } from './rfc64/registered-private-empty-vm-proof-v1.js';

export type RegisteredPrivateEmptyVmAttemptV1 =
  | { readonly proven: false; readonly retryable?: boolean }
  | { readonly proven: true; readonly metadataRevision: string; readonly onChainId: bigint };

export const UNPROVEN_PRIVATE_EMPTY_VM = { proven: false } as const;
export const RETRYABLE_PRIVATE_EMPTY_VM = { proven: false, retryable: true } as const;

/** Read only the agent's protected bindings through its owning mixin method. */
export interface PrivateEmptyVmAgentBindingsV1 {
  isSubscribed(): boolean;
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
    if (!ethers.isAddress(caller) || !bindings.isSubscribed()) {
      tracePrivateEmptyVm('not-subscribed'); return UNPROVEN_PRIVATE_EMPTY_VM;
    }
    const metadataRevision = bindings.readMetadataRevision();
    const confirmedBefore = await agent.hasConfirmedMetaState(contextGraphId, { signal }).catch(() => false);
    if (!confirmedBefore) {
      tracePrivateEmptyVm('metadata-not-yet-confirmed'); return RETRYABLE_PRIVATE_EMPTY_VM;
    }
    const privateBefore = await agent.isPrivateContextGraph(contextGraphId).catch(() => false);
    if (!privateBefore) { tracePrivateEmptyVm('not-private'); return UNPROVEN_PRIVATE_EMPTY_VM; }
    if (bindings.readMetadataRevision() !== metadataRevision) {
      tracePrivateEmptyVm('metadata-not-stable-before-proof'); return RETRYABLE_PRIVATE_EMPTY_VM;
    }
    const before = await agent.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
      callerAgentAddress: caller, allowSubscriptionFallback: false, signal,
    });
    if (before.outcome === 'unavailable') {
      tracePrivateEmptyVm('authority-unavailable-before-proof'); return RETRYABLE_PRIVATE_EMPTY_VM;
    }
    if (before.outcome !== 'allowed' || before.source !== 'registered-chain'
      || before.onChainId === undefined || before.registration === 'unregistered') {
      tracePrivateEmptyVm('authority-not-registered-allowed'); return UNPROVEN_PRIVATE_EMPTY_VM;
    }
    const chainConfig = bindings.readChainConfig();
    if (chainConfig === undefined || !bindings.hasAuthorityReader()) {
      tracePrivateEmptyVm('chain-capability-absent'); return UNPROVEN_PRIVATE_EMPTY_VM;
    }
    const endpoints = resolveRpcUrls(chainConfig.rpcUrl ?? '', chainConfig.rpcUrls);
    if (endpoints.length === 0) { tracePrivateEmptyVm('rpc-endpoints-absent'); return UNPROVEN_PRIVATE_EMPTY_VM; }
    // The adapter's own reading of a configured chain: a decimal id behind any
    // namespace. The network files name theirs `base:8453`, `gnosis:100`, and
    // so on; only a local chain is `evm:31337`.
    const configuredChainId = numericChainIdOf(chainConfig.chainId);
    if ((chainConfig.chainId !== undefined && configuredChainId === undefined)
      || !ethers.isAddress(chainConfig.hubAddress)) {
      tracePrivateEmptyVm('chain-binding-absent'); return UNPROVEN_PRIVATE_EMPTY_VM;
    }
    const adapterChainId = await bindings.readAdapterEvmChainId();
    if (configuredChainId !== undefined && configuredChainId !== adapterChainId) {
      tracePrivateEmptyVm('chain-binding-mismatch'); return UNPROVEN_PRIVATE_EMPTY_VM;
    }
    const chainId = adapterChainId.toString();
    // Normalize external bindings once. The registry supplies the graph name;
    // it is not restricted to the RFC-64 author-lane grammar.
    const hubAddress = chainConfig.hubAddress.toLowerCase();
    assertCanonicalChainId(chainId);
    assertCanonicalEvmAddress(caller);
    assertCanonicalEvmAddress(hubAddress);
    const registered = await agent.readRfc64RegisteredAuthoritySnapshotV1(contextGraphId, signal);
    if (registered === null || registered.expectedOnChainId !== before.onChainId) {
      tracePrivateEmptyVm('indexed-private-authority-absent'); return UNPROVEN_PRIVATE_EMPTY_VM;
    }
    const indexed = registered.snapshot;
    if (indexed.chainId !== chainId
      || indexed.accessPolicy !== 1
      || finalizedContextGraphSnapshotMismatchV1(indexed, {
        onChainId: registered.expectedOnChainId,
        nameHash: registered.expectedNameHash,
      }) !== undefined) {
      tracePrivateEmptyVm('indexed-private-authority-absent'); return UNPROVEN_PRIVATE_EMPTY_VM;
    }
    const depth = bindings.readResolvedFinalityConfirmations();
    const proven = await proveRegisteredPrivateEmptyVmV1({
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
    if (!proven) { tracePrivateEmptyVm('finalized-zero-proof-false'); return UNPROVEN_PRIVATE_EMPTY_VM; }
    return { proven: true, metadataRevision, onChainId: before.onChainId };
  } catch (error) {
    tracePrivateEmptyVm(`proof-error:${error instanceof Error ? error.name : 'unknown'}`);
    return signal?.aborted || !isFinalizedChainAdmissionContention(error)
      ? UNPROVEN_PRIVATE_EMPTY_VM : RETRYABLE_PRIVATE_EMPTY_VM;
  }
}
