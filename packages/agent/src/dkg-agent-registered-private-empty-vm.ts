// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { createStrictCurrentFinalizedEvmSnapshotScopeV1, resolveRpcUrls } from '@origintrail-official/dkg-chain';
import {
  assertCanonicalChainId, assertCanonicalDecimalU256, assertCanonicalEvmAddress,
} from '@origintrail-official/dkg-core';
import type { DKGAgent } from './dkg-agent.js';
import type { ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
import { proveRegisteredPrivateEmptyVmV1 } from './rfc64/registered-private-empty-vm-proof-v1.js';

export type RegisteredPrivateEmptyVmReadinessResult<T> =
  | { readonly proven: false }
  | { readonly proven: true; readonly value: T };

export type ContextGraphReadinessAuthorityV1 =
  | ContextGraphReadAuthorityDecision
  | { readonly outcome: 'unavailable' };

export interface InspectedContextGraphReadinessV1 {
  readonly current: boolean;
  readonly hasConfirmedMeta: boolean | undefined;
  readonly isPrivate: boolean;
  readonly authority: ContextGraphReadinessAuthorityV1;
}

export class RegisteredPrivateEmptyVmMethods {
  /** Inspect and commit graph readiness under one agent-owned, same-turn fence. */
  async inspectAndCommitContextGraphReadinessV1<T>(
    this: DKGAgent,
    input: {
      contextGraphId: string;
      inspectMetadata: boolean;
      expectedRevision?: string;
      callerAgentAddress?: string;
      signal?: AbortSignal;
    },
    commit: (inspection: InspectedContextGraphReadinessV1) => T,
  ): Promise<T> {
    const { contextGraphId, signal } = input;
    const readRevision = () => {
      try {
        return this.contextGraphMetaProjection.readContextGraphAuthorityFactsRevision(contextGraphId);
      } catch {
        return undefined;
      }
    };
    const revision = input.expectedRevision ?? readRevision();
    let hasConfirmedMeta = input.inspectMetadata
      ? await this.hasConfirmedMetaState(contextGraphId, { signal }).catch(() => undefined)
      : undefined;
    let isPrivate = false;
    if (hasConfirmedMeta) {
      try {
        isPrivate = await this.isPrivateContextGraph(contextGraphId);
      } catch {
        // Unknown policy cannot prove either public readiness or the private
        // zero-VM exception. Preserve the private fail-closed posture while
        // withholding the confirmed-metadata fact.
        hasConfirmedMeta = undefined;
        isPrivate = true;
      }
    }
    const authority: ContextGraphReadinessAuthorityV1 =
      await this.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
        callerAgentAddress: input.callerAgentAddress,
        allowSubscriptionFallback: false,
        freshness: 'live',
        signal,
      }).catch(() => ({ outcome: 'unavailable' as const }));
    // The callback is synchronous. No await can separate this final fence from
    // classification or persistence; a caller cannot turn stale facts into
    // durable readiness while an authority read is in flight.
    const current = signal?.aborted !== true
      && revision !== undefined
      && this.subscribedContextGraphs.get(contextGraphId)?.subscribed === true
      && readRevision() === revision;
    return commit(current
      ? { current, hasConfirmedMeta, isPrivate, authority }
      : {
          current, hasConfirmedMeta: undefined, isPrivate: false,
          authority: authority.outcome === 'allowed' ? { outcome: 'unavailable' } : authority,
        });
  }

  /** A zero-VM proof grants durable readiness only; SWM still needs its own proof. */
  async proveRegisteredPrivateEmptyVmV1<T>(
    this: DKGAgent,
    contextGraphId: string,
    callerAgentAddress: string,
    commit: (inspection: InspectedContextGraphReadinessV1) => T,
    signal?: AbortSignal,
  ): Promise<RegisteredPrivateEmptyVmReadinessResult<T>> {
    const unproven = { proven: false } as const;
    let caller = '';
    let metadataRevision = '';
    let beforeOnChainId: bigint | undefined;
    const trace = (stage: string) => {
      if (process.env.DKG_DEBUG_PRIVATE_EMPTY_VM === '1') {
        console.info(`[private-empty-vm] ${stage}`);
      }
    };
    try {
      if (signal?.aborted) return unproven;
      caller = callerAgentAddress.toLowerCase();
      if (!ethers.isAddress(caller) ||
        this.subscribedContextGraphs.get(contextGraphId)?.subscribed !== true) {
        trace('not-subscribed'); return unproven;
      }
      metadataRevision = this.contextGraphMetaProjection
        .readContextGraphAuthorityFactsRevision(contextGraphId);
      const confirmedBefore = await this.hasConfirmedMetaState(contextGraphId, { signal }).catch(() => false);
      const privateBefore = confirmedBefore
        && await this.isPrivateContextGraph(contextGraphId).catch(() => false);
      if (!privateBefore || this.contextGraphMetaProjection
        .readContextGraphAuthorityFactsRevision(contextGraphId) !== metadataRevision) {
        trace('metadata-not-stable-before-proof'); return unproven;
      }
      const authority = () => this.resolveContextGraphSubscriptionBootstrapAuthority(
        contextGraphId,
        { callerAgentAddress: caller, allowSubscriptionFallback: false, signal },
      );
      const before = await authority();
      if (before.outcome !== 'allowed' || before.source !== 'registered-chain'
        || before.onChainId === undefined || before.registration === 'unregistered') {
        trace('authority-not-registered-allowed'); return unproven;
      }
      beforeOnChainId = before.onChainId;
      const chainConfig = this.config.chainConfig;
      if (chainConfig === undefined
        || this.contextGraphAuthorityReaderCapability.status === 'unsupported') {
        trace('chain-capability-absent'); return unproven;
      }
      const endpoints = resolveRpcUrls(chainConfig.rpcUrl, chainConfig.rpcUrls);
      if (endpoints.length === 0) { trace('rpc-endpoints-absent'); return unproven; }
      const chainId = chainConfig.chainId?.match(/^evm:(0|[1-9][0-9]*)$/u)?.[1];
      if (chainId === undefined || !ethers.isAddress(chainConfig.hubAddress)) {
        trace('chain-binding-absent'); return unproven;
      }
      // Normalize external bindings once, then narrow to the shared wire
      // scalars. The graph name itself is hashed as supplied by the DKG
      // registry and is not restricted to the RFC-64 author-lane grammar.
      const onChainContextGraphId = before.onChainId.toString(10);
      const hubAddress = chainConfig.hubAddress.toLowerCase();
      assertCanonicalChainId(chainId);
      assertCanonicalDecimalU256(onChainContextGraphId);
      assertCanonicalEvmAddress(caller);
      assertCanonicalEvmAddress(hubAddress);
      // The catalog reader owns capability binding, coordinated admission,
      // cancellation, and the finalized authority snapshot. Match its target
      // to the subscription's admitted on-chain identity before using it.
      const registered = await this.readRfc64RegisteredAuthoritySnapshotV1(contextGraphId, signal);
      if (registered === null || registered.expectedOnChainId !== before.onChainId) {
        trace('indexed-private-authority-absent'); return unproven;
      }
      const indexed = registered.snapshot;
      if (indexed.chainId !== chainId
        || indexed.contextGraphId !== onChainContextGraphId
        || indexed.active !== true || indexed.accessPolicy !== 1
        || indexed.nameHash !== registered.expectedNameHash
        || !ethers.isAddress(indexed.governanceContract)) {
        trace('indexed-private-authority-absent'); return unproven;
      }
      const governanceContractAddress = indexed.governanceContract.toLowerCase();
      assertCanonicalEvmAddress(governanceContractAddress);
      const depth = this.chain.getFinalityConfirmations?.()
        ?? chainConfig.finalityConfirmations;
      const proven = await proveRegisteredPrivateEmptyVmV1({
        contextGraphId,
        onChainContextGraphId,
        callerAgentAddress: caller,
        chainId,
        hubAddress,
        governanceContractAddress,
        snapshot: createStrictCurrentFinalizedEvmSnapshotScopeV1({
          chainId, endpoints,
          ...(depth === undefined ? {} : { finalityConfirmations: depth }),
          owner: 'rfc64',
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
      });
      if (!proven) { trace('finalized-zero-proof-false'); return unproven; }
    } catch (error) {
      trace(`proof-error:${error instanceof Error ? error.name : 'unknown'}`);
      return unproven;
    }
    // The inspected callback owns the last live authority read and the same-
    // turn metadata/subscription fence. Keep it outside the fail-closed proof
    // catch so caller-owned persistence errors remain visible.
    return this.inspectAndCommitContextGraphReadinessV1({
      contextGraphId,
      inspectMetadata: true,
      expectedRevision: metadataRevision,
      callerAgentAddress: caller,
      signal,
    }, (inspection) => {
      const { current, hasConfirmedMeta, isPrivate, authority: after } = inspection;
      if (!current || !hasConfirmedMeta || !isPrivate
        || after.outcome !== 'allowed' || after.source !== 'registered-chain'
        || after.registration === 'unregistered'
        || after.onChainId !== beforeOnChainId) {
        trace('post-proof-authority-changed');
        return unproven;
      }
      trace('proven');
      return { proven: true, value: commit(inspection) };
    });
  }
}
